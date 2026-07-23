// scripts/verify-playback.mjs — 재생(연출) 회귀 검증.  실행: node scripts/verify-playback.mjs
//
// verify.mjs가 "판정이 맞는가"를 본다면, 이 스크립트는 "화면이 판정과 어긋나 보이지 않는가"를 본다.
// 연출은 판정에 영향을 주지 않으므로 앵커로 잡을 수 없고, 대신 프레임을 실제로 돌려 확인한다.
//
// 잡는 회귀 (실제로 있었던 버그):
//   패스 궤적은 "계획 좌표"로 그려지는데 선수는 조향·노이즈로 그 자리에서 밀려나 있다.
//   양쪽 끝을 선수의 실제 위치에 고정하지 않으면 공이 빈 잔디에서 출발하거나 빈 잔디에
//   떨어졌다가 선수에게 순간이동한다 — "공이 혼자 움직인다"고 보이는 원인. (최대 5.2m 관측)

globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)

import { readFileSync } from 'node:fs'
import { resolveSequence } from '../src/engine/resolve.js'
import { playSequence } from '../src/engine/playback.js'
import { midpoint, samplePath, minDistToPath } from '../src/engine/geometry.js'

const players = JSON.parse(readFileSync(new URL('../src/data/players.json', import.meta.url), 'utf-8'))
const scenario = JSON.parse(readFileSync(new URL('../src/data/scenarios.json', import.meta.url), 'utf-8'))
const moment = scenario.moments[0]
const pos = moment.positions
const get = (id) => ({ ...players.find((p) => p.id === id), ...pos[id] })
const home = Object.keys(pos).filter((i) => i.startsWith('kor')).map(get)
const opponents = Object.keys(pos).filter((i) => i.startsWith('por')).map(get)
const byId = Object.fromEntries([...home, ...opponents].map((p) => [p.id, p]))

let fails = 0
const chk = (label, ok, detail) => {
  if (!ok) fails++
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

// App.jsx와 같은 규칙으로 체인을 만든다: 패스 도착점 = 그 시점 리시버가 서 있는 자리
const build = (acts) => {
  const at = {}
  const posOf = (id) => at[id] ?? pos[id]
  let carrier = acts[0].actorId
  return acts.map((a, i) => {
    const from = posOf(carrier)
    let to
    if (a.type === 'dribble') {
      to = a.to
      at[carrier] = to
    } else {
      to = posOf(a.receiverId)
      at[a.receiverId] = to
      carrier = a.receiverId
    }
    const actorId = carrier === a.receiverId && a.type !== 'dribble' ? a.actorId : carrier
    return { ...a, actorId, actor: byId[actorId], from, to, ctrl: midpoint(from, to), index: i }
  })
}

const CASES = [
  {
    name: '짧은 패스 2회',
    acts: [
      { type: 'pass', actorId: 'kor_07', receiverId: 'kor_11' },
      { type: 'pass', actorId: 'kor_11', receiverId: 'kor_09' },
    ],
  },
  { name: '긴 전환 패스', acts: [{ type: 'pass', actorId: 'kor_07', receiverId: 'kor_18' }] },
  {
    name: '드리블 후 침투 패스',
    acts: [
      { type: 'dribble', actorId: 'kor_07', to: { x: 80, y: 36 } },
      { type: 'pass', actorId: 'kor_07', receiverId: 'kor_11' },
    ],
  },
  {
    name: '연속 3패스',
    acts: [
      { type: 'pass', actorId: 'kor_07', receiverId: 'kor_09' },
      { type: 'pass', actorId: 'kor_09', receiverId: 'kor_11' },
      { type: 'pass', actorId: 'kor_11', receiverId: 'kor_06' },
    ],
  },
]

// 허용치: 공이 선수 발밑을 벗어난 채 소유권이 넘어가도 되는 최대 거리(m).
// 선수 원 반지름이 1.4m이라, 이보다 크면 화면에서 "빈 자리에 떨어졌다"가 보인다.
const SNAP_LIMIT = 1.4
// 공이 그려진 궤적에서 벗어나도 되는 최대 거리(m). 0에 가까워야 한다 —
// 리시버 쪽으로 휘는 보정이 들어가면 이 값이 커진다.
const PATH_LIMIT = 0.5

console.log('\n[재생] 패스가 선수 발밑에서 출발해 발밑에 도착하는가')
let worst = 0
let worstLabel = ''
for (const c of CASES) {
  const actions = build(c.acts)
  let seed = null
  for (let s = 1; s < 6000; s++) {
    const r = resolveSequence(actions, { opponents, players: home, seed: s })
    if (r.steps.every((x) => x.success !== false)) { seed = s; break }
  }
  if (!seed) { chk(`${c.name}: 전부 성공하는 시드 탐색`, false); continue }

  const result = resolveSequence(actions, { opponents, players: home, seed })
  const frames = []
  await new Promise((done) => {
    playSequence({
      actions, result, runLegs: [], players: home, opponents, byId,
      ballOwnerId: actions[0].actorId, seed,
      onFrame: (f) =>
        frames.push({
          ball: { ...f.ball },
          home: JSON.parse(JSON.stringify(f.home)),
          opp: JSON.parse(JSON.stringify(f.opp)),
        }),
      onDone: done,
    })
  })

  // 소유권이 넘어가는 순간의 스냅: 공이 계획 도착점 부근에 있다가 갑자기 튀는 거리
  for (const a of actions) {
    if (a.type !== 'pass') continue
    let snap = 0
    for (let i = 1; i < frames.length; i++) {
      const prev = frames[i - 1].ball
      const wasAtPlan = Math.hypot(prev.x - a.to.x, prev.y - a.to.y) < 1.5
      const jumped = Math.hypot(frames[i].ball.x - prev.x, frames[i].ball.y - prev.y)
      if (wasAtPlan && jumped > snap) snap = jumped
    }
    const label = `${c.name} → ${byId[a.receiverId].name}`
    if (snap > worst) { worst = snap; worstLabel = label }
    chk(`${label}: 스냅 ${snap.toFixed(2)}m`, snap <= SNAP_LIMIT)

  }

  // 공은 "그려진 궤적" 위로만 날아야 한다. 리시버 쪽으로 끌어당기는 보정을 넣으면
  // 궤적이 팍 꺾여 유도탄처럼 보인다 — 그 회귀를 막는 검사.
  // 비행 중인 프레임만 본다: 공이 어느 선수 발밑에도 없는(=아무도 소유하지 않은) 순간.
  const paths = actions.map((a) => samplePath(a.from, a.ctrl, a.to))
  let devi = 0
  for (const f of frames) {
    const all = [...Object.values(f.home), ...Object.values(f.opp)]
    const atFeet = all.some((p) => Math.hypot(p.x - f.ball.x, p.y - f.ball.y) < 1.5)
    if (atFeet) continue // 누군가 몰고 있는 중 — 궤적 위에 있을 이유가 없다
    const d = Math.min(...paths.map((pt) => minDistToPath(pt, f.ball).d))
    if (d > devi) devi = d
  }
  chk(`${c.name}: 비행 중 궤적 이탈 ${devi.toFixed(2)}m (그린 대로 날아가는가)`, devi <= PATH_LIMIT)
}
console.log(`  최악 ${worst.toFixed(2)}m (${worstLabel}) / 허용 ${SNAP_LIMIT}m`)

console.log(fails === 0 ? '\n재생 검증 통과 ✅' : `\n${fails}건 실패 ❌`)
process.exit(fails === 0 ? 0 : 1)
