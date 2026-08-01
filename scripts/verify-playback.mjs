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
import { midpoint, samplePath, minDistToPath, pathLength } from '../src/engine/geometry.js'
import { actionDuration, runSpeedOf, throughPassSpeed, throughTarget } from '../src/engine/sheets.js'
import { K } from '../src/engine/constants.js'

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
  { name: '긴 전환 패스', acts: [{ type: 'pass', actorId: 'kor_07', receiverId: 'kor_16' }] },
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
  {
    name: '로빙패스 공 높이',
    aerial: true,
    acts: [{ type: 'pass', passKind: 'lob', actorId: 'kor_07', receiverId: 'kor_11' }],
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

  if (c.aerial) {
    const peak = Math.max(...frames.map((f) => f.ball.height ?? 0))
    chk(`${c.name}: 비행 중 공 높이 ${peak.toFixed(2)} (> 0.8)`, peak > 0.8)
  }

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

console.log('\n[드리블 병행 런] 가속도 반경 끝 목표까지 계속 달리는가')
{
  const carrier = byId.kor_07
  const runner = byId.kor_11
  const dribble = {
    type: 'dribble',
    actorId: carrier.id,
    actor: carrier,
    from: { x: carrier.x, y: carrier.y },
    to: { x: 76, y: 23 },
    ctrl: { x: 67.5, y: 23 },
    index: 0,
  }
  const runSeconds = actionDuration(dribble)
  const runTarget = {
    x: runner.x + runSpeedOf(runner) * runSeconds,
    y: runner.y,
  }
  const nextPass = {
    type: 'pass',
    actorId: carrier.id,
    receiverId: runner.id,
    actor: carrier,
    from: dribble.to,
    to: runTarget,
    ctrl: midpoint(dribble.to, runTarget),
    index: 1,
  }
  const actions = [dribble, nextPass]
  let seed = null
  for (let s = 1; s < 6000; s++) {
    const trial = resolveSequence(actions, { opponents, players: home, seed: s })
    if (trial.steps.every((step) => step.success !== false)) { seed = s; break }
  }
  if (!seed) {
    chk('병행 런: 성공 시드 탐색', false)
  } else {
    const result = resolveSequence(actions, { opponents, players: home, seed })
    const runnerFrames = []
    const runnerTimeline = []
    await new Promise((done) => {
      playSequence({
        actions,
        result,
        runLegs: [{ id: runner.id, from: { x: runner.x, y: runner.y }, to: runTarget, ctrl: midpoint(runner, runTarget), afterIndex: 0 }],
        players: home,
        opponents,
        byId,
        ballOwnerId: carrier.id,
        seed,
        onFrame: (frame) => {
          runnerFrames.push({ ...frame.home[runner.id] })
          runnerTimeline.push({ player: { ...frame.home[runner.id] }, ball: { ...frame.ball }, elapsed: frame.elapsed })
        },
        onDone: done,
      })
    })
    const handoffAt = 300 + actionDuration(dribble) * 1000
    const handoffFrames = runnerTimeline.filter((f) => f.elapsed >= handoffAt && f.elapsed <= handoffAt + 90)
    const handoffGap = Math.min(...handoffFrames.map((f) => Math.hypot(f.player.x - runTarget.x, f.player.y - runTarget.y)))
    chk(`second action starts with runner at target (${handoffGap.toFixed(2)}m)`, handoffGap <= 0.25)
    // 출발 전 대기: 예전에는 좌표를 못 박아 완전히 굳어 있었다(베타테스트 "석상" 지적).
    // 이제는 목줄(K.PLAY.LEASH_WAIT) 안에서 잔 움직임을 허용한다 — 다만 목줄을 넘으면
    // 런 출발점이 달라져 다음 액션의 계획 좌표와 어긋나므로 그 상한은 지켜야 한다.
    const preRun = runnerTimeline.filter((f) => f.elapsed < 300)
    const preRunDrift = Math.max(...preRun.map((f) => Math.hypot(f.player.x - runner.x, f.player.y - runner.y)))
    chk(
      `runner stays within its leash before the explicit run (${preRunDrift.toFixed(2)}m / ${K.PLAY.LEASH_WAIT}m)`,
      preRunDrift <= K.PLAY.LEASH_WAIT,
    )
    // 프레임 간격이 일정하지 않으므로 고정 상수(예전 0.35m)로는 판정할 수 없다 —
    // 긴 프레임 한 번에 값이 ±50% 튀어 이 검사는 무작위로 빨간불이 됐다.
    // 이제 엔진이 한 프레임 이동량을 물리 상한으로 자르므로(K.PLAY.JUMP_CAP),
    // 그 상한과 직접 비교한다. 상수가 아니라 규칙을 검사하는 것이라 흔들리지 않는다.
    const stepOver = runnerTimeline.slice(1).map((f, i) => {
      const dt = (f.elapsed - runnerTimeline[i].elapsed) / 1000
      if (!(dt > 0)) return 0
      const step = Math.hypot(f.player.x - runnerTimeline[i].player.x, f.player.y - runnerTimeline[i].player.y)
      return step - Math.max(runSpeedOf(runner), K.SPEED.dribble) * K.PLAY.JUMP_CAP * dt
    })
    const worstOver = Math.max(...stepOver)
    chk(`off-ball run stays within the physical step cap (초과 ${worstOver.toFixed(3)}m)`, worstOver <= 0.02)
    const passArrivalGap = Math.min(...runnerTimeline
      .filter((f) => f.elapsed >= handoffAt)
      .map((f) => Math.hypot(f.ball.x - runTarget.x, f.ball.y - runTarget.y)))
    chk(`next pass completes at the run target (${passArrivalGap.toFixed(2)}m)`, passArrivalGap <= 0.25)
    const nearest = Math.min(...runnerFrames.map((p) => Math.hypot(p.x - runTarget.x, p.y - runTarget.y)))
    chk(`드리블 뒤에도 가속도 반경 끝 목표에 도착 (${nearest.toFixed(2)}m)`, nearest <= 0.25)
  }
}

console.log(fails === 0 ? '\n재생 검증 통과 ✅' : `\n${fails}건 실패 ❌`)
console.log('\n[through-pass receiver] receiver runs to the same point as the ball')
{
  const carrier = byId.kor_07
  const runner = byId.kor_11
  const target = throughTarget({
    runnerFrom: { x: runner.x, y: runner.y },
    ballFrom: { x: carrier.x, y: carrier.y },
    want: { x: 96, y: 24 },
    player: runner,
    passKind: 'through',
  })
  const pass = {
    type: 'pass',
    passKind: 'through',
    actorId: carrier.id,
    receiverId: runner.id,
    actor: carrier,
    from: { x: carrier.x, y: carrier.y },
    to: target,
    ctrl: midpoint(carrier, target),
    passSpeed: throughPassSpeed({
      runnerFrom: { x: runner.x, y: runner.y },
      ballFrom: { x: carrier.x, y: carrier.y },
      to: target,
      player: runner,
      passKind: 'through',
    }),
    index: 0,
  }
  let seed = null
  for (let s = 1; s < 6000; s++) {
    const trial = resolveSequence([pass], { opponents, players: home, seed: s })
    if (trial.steps[0].success) { seed = s; break }
  }
  if (!seed) {
    chk('through-pass success seed found', false)
  } else {
    const result = resolveSequence([pass], { opponents, players: home, seed })
    const frames = []
    await new Promise((done) => {
      playSequence({
        actions: [pass], result,
        runLegs: [{ id: runner.id, from: { x: runner.x, y: runner.y }, to: target, ctrl: midpoint(runner, target), afterIndex: 0 }],
        players: home, opponents, byId, ballOwnerId: carrier.id, seed,
        onFrame: (frame) => frames.push({ elapsed: frame.elapsed, ball: { ...frame.ball }, runner: { ...frame.home[runner.id] } }),
        onDone: done,
      })
    })
    const ballAtTarget = frames.reduce((best, frame) => {
      const gap = Math.hypot(frame.ball.x - target.x, frame.ball.y - target.y)
      return gap < best.gap ? { frame, gap } : best
    }, { frame: null, gap: Infinity })
    const receiverGap = Math.hypot(ballAtTarget.frame.runner.x - target.x, ballAtTarget.frame.runner.y - target.y)
    const runDistance = Math.max(...frames.map((frame) => Math.hypot(frame.runner.x - runner.x, frame.runner.y - runner.y)))
    chk(`through receiver moves (${runDistance.toFixed(2)}m)`, runDistance > 0.1)
    chk(`through receiver is at the ball endpoint (${receiverGap.toFixed(2)}m)`, receiverGap <= 0.25)
  }
}

// --- 차단자가 그 자리에 실제로 닿을 수 있는가 --------------------------------
// 있었던 버그: 차단 지점을 "경로에서 가장 가까운 점"으로만 잡아서, 옆에 서 있던 수비수가
// 공이 0.25초 만에 지나가는 자리로 순간이동해 끊는 그림이 됐다. 2002 이영표 패스에서
// 디리비오가 그랬다 — 필요 속도 10.9 m/s, 그의 주력은 6.6. 끊긴 211건이 전부 그의 몫이었다.
// 확률은 그대로 두고 연출 좌표만 고쳤으므로, 검사도 "지목된 사람이 시간 안에 갈 수 있나"만 본다.
console.log('\n[차단자] 지목된 수비수가 그 지점에 시간 안에 닿을 수 있는가')
{
  const scn2002 = JSON.parse(readFileSync(new URL('../src/data/kor_ita_2002.json', import.meta.url), 'utf-8'))
  const p02 = scn2002.moments[0].positions
  const g02 = (id) => ({ ...players.find((p) => p.id === id), ...p02[id] })
  const ids02 = Object.keys(p02)
  const home02 = ids02.filter((i) => i.startsWith('kor')).map(g02)
  const opp02 = ids02.filter((i) => i.startsWith('ita')).map(g02)
  const lee = g02('kor02_14'), young = g02('kor02_10')
  const mk = (from, to, actor, actorId, receiverId) => ({
    type: 'pass', actorId, receiverId, actor, from, to, ctrl: midpoint(from, to),
  })
  // 두 장면·여러 체인을 함께 돌린다. 한 장면만 보면 그 장면에서 지목이 사라졌을 때
  // 표본 0으로 공회전한다 (실제로 2002는 이 수정 뒤 지목이 0건이 된다).
  const SCENES = [
    {
      name: '2002',
      home: home02, opp: opp02,
      chain: [
        mk({ x: lee.x, y: lee.y }, { x: young.x, y: young.y }, lee, 'kor02_14', 'kor02_10'),
        mk({ x: young.x, y: young.y }, { x: 108, y: 44 }, young, 'kor02_10', 'kor02_19'),
      ],
    },
    { name: '2022 짧은 패스 2회', home, opp: opponents, chain: build(CASES[0].acts) },
    { name: '2022 연속 3패스', home, opp: opponents, chain: build(CASES[3].acts) },
  ]
  let checked = 0
  let impossible = 0
  let worstNeed = 0
  let worstWho = ''
  for (const sc of SCENES) {
    for (let seed = 1; seed <= 400; seed++) {
      const r = resolveSequence(sc.chain, { opponents: sc.opp, players: sc.home, seed })
      const fi = r.steps.findIndex((s) => s.success === false)
      if (fi < 0 || !r.steps[fi].interceptorId) continue
      const s = r.steps[fi]
      // 판정에 쓰인 좌표 = 직전 스텝이 끝난 시점 (첫 액션이면 장면 좌표)
      const who = sc.opp.find((o) => o.id === s.interceptorId)
      const at = (fi > 0 ? r.steps[fi - 1].defPos?.[s.interceptorId] : null) ?? who
      const along = pathLength(samplePath(sc.chain[fi].from, sc.chain[fi].ctrl, sc.chain[fi].to)) * s.interceptFrac
      const tBall = along / K.SPEED.pass
      const need = Math.hypot(at.x - s.interceptPoint.x, at.y - s.interceptPoint.y)
      const needSpeed = tBall > 0 ? need / tBall : Infinity
      checked++
      if (needSpeed > runSpeedOf(who) + 1e-6) impossible++
      if (needSpeed > worstNeed) { worstNeed = needSpeed; worstWho = `${sc.name} ${who.name} ${needSpeed.toFixed(1)} m/s (주력 ${runSpeedOf(who).toFixed(1)})` }
    }
  }
  chk(`표본이 있는가 (지목 ${checked}건)`, checked >= 20)
  chk(`도달 불가 ${impossible}건 — 최대 요구 ${worstWho || '-'}`, impossible === 0)
}

process.exit(fails === 0 ? 0 : 1)
