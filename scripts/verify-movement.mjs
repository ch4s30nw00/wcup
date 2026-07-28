// scripts/verify-movement.mjs — 선수 움직임의 물리 회귀 검증. 실행: node scripts/verify-movement.mjs
//
// verify.mjs가 "판정이 맞는가", verify-playback.mjs가 "공과 선수가 어긋나 보이지 않는가"를
// 본다면, 이 스크립트는 **"사람처럼 움직이는가"**를 본다.
//
// 왜 필요한가: 베타테스트에서 나온 지적이 전부 여기서 걸릴 수 있는 것들이었는데
// 잡아주는 테스트가 하나도 없었다.
//   · 연산에 안 들어가는 선수가 자기 최대 주력의 1.6배로 질주 (측정 10.6 m/s, 한계 6.6)
//   · 오프볼 런이 예약된 선수가 3.8초 동안 완전히 굳어 있음
//   · 슛을 마친 선수가 옛 런 종점으로 23.7m 순간이동 (좀비 세그먼트)
//
// 검사 항목
//   1) 누구도 자기 runSpeedOf를 의미 있게 넘지 않는다 (GK 다이브는 몸을 던지는 동작이라 예외)
//   2) 한 프레임 이동량이 물리 상한을 넘지 않는다 — 순간이동 0
//   3) 재생 내내 완전히 굳어 있는 선수가 없다
//
// 실패 시 exit 1.

globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)

import { readFileSync } from 'node:fs'
import { resolveSequence } from '../src/engine/resolve.js'
import { playSequence } from '../src/engine/playback.js'
import { midpoint } from '../src/engine/geometry.js'
import { runSpeedOf, reachRadius, clampToReach, actionDuration } from '../src/engine/sheets.js'

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

// App.jsx의 체인·런 유도와 같은 순서 (런의 from = 그 시점 계획 좌표,
// 드리블 앵커 런은 가동 반경으로 클램프)
function derive(chainActs, runs) {
  const at = {}
  const posOf = (id) => at[id] ?? pos[id]
  const runLegMap = {}
  const len = chainActs.length
  const applyRunsAt = (i, timeBudget = null) => {
    runs.forEach((r, key) => {
      if (Math.min(r.afterIndex, len) === i && !runLegMap[key]) {
        const from = posOf(r.id)
        const player = byId[r.id]
        const to = timeBudget != null && player ? clampToReach(from, r.to, reachRadius(player, timeBudget)) : r.to
        runLegMap[key] = { key, id: r.id, from, to, ctrl: midpoint(from, to), afterIndex: r.afterIndex }
        at[r.id] = to
      }
    })
  }
  let carrier = chainActs[0].actorId
  const chain = chainActs.map((act, index) => {
    const cur = posOf(carrier)
    if (act.type === 'dribble') {
      const ctrl = midpoint(cur, act.to)
      applyRunsAt(index, actionDuration({ type: 'dribble', from: cur, to: act.to, ctrl }))
      const leg = { type: 'dribble', actorId: carrier, from: cur, to: act.to, ctrl, index }
      at[carrier] = act.to
      return leg
    }
    applyRunsAt(index)
    const to = act.receiverId === 'GOAL' ? act.to : posOf(act.receiverId)
    const leg = { type: act.type, actorId: carrier, receiverId: act.receiverId, from: cur, to, ctrl: midpoint(cur, to), index }
    if (act.receiverId !== 'GOAL') {
      at[act.receiverId] = to
      carrier = act.receiverId
    }
    return leg
  })
  applyRunsAt(len)
  return { chain: chain.map((l) => ({ ...l, actor: byId[l.actorId] })), runLegs: Object.values(runLegMap) }
}

// 전 스텝이 성공하는 시드를 찾는다 — 실패하면 뒤 액션과 런이 잘려 관찰 구간이 줄어든다
function play({ chainActs, runs = [] }) {
  const { chain, runLegs } = derive(chainActs, runs)
  let seed = 1
  let result = null
  for (let s = 1; s < 4000; s++) {
    const r = resolveSequence(chain, { opponents, players: home, seed: s })
    if (r.steps.every((x) => x.success)) {
      seed = s
      result = r
      break
    }
  }
  if (!result) return null
  const shooterId = chain[chain.length - 1]?.type === 'shot' ? chain[chain.length - 1].actorId : null
  return new Promise((resolve) => {
    const prev = {}
    const stat = {}
    for (const p of [...home, ...opponents])
      stat[p.id] = { max: 0, maxAt: 0, jump: 0, jumpAt: 0, moved: 0, stillRun: 0, worstStill: 0, win: [] }
    let lastEl = 0
    playSequence({
      actions: chain,
      result,
      runLegs,
      players: home,
      opponents,
      byId,
      ballOwnerId: moment.ball,
      seed,
      onFrame: ({ home: H, opp: O, elapsed }) => {
        const dt = (elapsed - lastEl) / 1000
        lastEl = elapsed
        if (dt <= 0.0005) return
        for (const [id, p] of [...Object.entries(H), ...Object.entries(O)]) {
          const q = prev[id]
          if (q) {
            const d = Math.hypot(p.x - q.x, p.y - q.y)
            const s = stat[id]
            const v = d / dt
            // 지속 속도 — 한 프레임 델타는 프레임 간격 지터에 좌우돼 ±50%씩 튄다.
            // 보는 사람이 "과속"으로 느끼는 것도 순간값이 아니라 이어지는 속도다.
            s.win.push({ t: elapsed, x: p.x, y: p.y })
            while (s.win.length > 1 && elapsed - s.win[0].t > SPEED_WINDOW_MS) s.win.shift()
            if (s.win.length > 1) {
              const a0 = s.win[0]
              const span = (elapsed - a0.t) / 1000
              if (span >= SPEED_WINDOW_MS / 2000) {
                const vw = Math.hypot(p.x - a0.x, p.y - a0.y) / span
                if (vw > s.max) {
                  s.max = vw
                  s.maxAt = elapsed
                }
              }
            }
            if (d > s.jump) {
              s.jump = d
              s.jumpAt = elapsed
            }
            s.moved += d
            // 연속 정지 구간 길이
            if (v < 0.2) {
              s.stillRun += dt
              if (s.stillRun > s.worstStill) s.worstStill = s.stillRun
            } else s.stillRun = 0
          }
          prev[id] = { x: p.x, y: p.y }
        }
      },
      onDone: () => resolve({ stat, total: lastEl, seed, chain, shooterId }),
    })
  })
}

const D = (x, y) => ({ x, y })
const CASES = [
  {
    name: '드리블 → 패스 → 슛 (지시 런 없음)',
    chainActs: [
      { type: 'dribble', actorId: 'kor_07', to: D(82, 36) },
      { type: 'pass', receiverId: 'kor_11' },
      { type: 'shot', receiverId: 'GOAL', to: D(119, 39) },
    ],
  },
  {
    // 좀비 세그먼트 회귀 케이스 — 런을 마친 선수가 나중에 드리블·슛을 한다.
    // 고치기 전에는 슛 직후 런 종점으로 23.7m 되돌아갔다.
    name: '런 → 수신 → 드리블 → 슛 (같은 선수)',
    chainActs: [
      { type: 'dribble', actorId: 'kor_07', to: D(78, 36) },
      { type: 'pass', receiverId: 'kor_11' },
      { type: 'dribble', to: D(100, 42) },
      { type: 'shot', receiverId: 'GOAL', to: D(119, 40) },
    ],
    runs: [{ id: 'kor_11', to: D(92, 44), afterIndex: 0 }],
  },
  {
    // 석상 회귀 케이스 — 늦은 런이 예약된 선수가 그 전까지 굳어 있었다(3.8초).
    name: '늦은 런이 예약된 선수',
    chainActs: [
      { type: 'dribble', actorId: 'kor_07', to: D(75, 36) },
      { type: 'pass', receiverId: 'kor_06' },
      { type: 'pass', receiverId: 'kor_11' },
    ],
    runs: [{ id: 'kor_16', to: D(95, 60), afterIndex: 2 }],
  },
]

// 지속 속도를 재는 창(ms). 한 프레임(~16ms)은 지터가 커서 판정 기준이 못 된다.
const SPEED_WINDOW_MS = 150
// 조향이 목표를 지나칠 때의 오버슛까지 감안한 여유. 1.15배는 "빠르다"가 아니라
// "이 선수 다리로는 불가능하다"를 가르는 선이다.
const SPEED_TOL = 1.15
const STILL_MAX_S = 2.5

for (const c of CASES) {
  const r = await play(c)
  console.log(`\n[움직임] ${c.name}`)
  if (!r) {
    chk('전 스텝 성공 시드', false, '4000개 안에서 못 찾음')
    continue
  }
  const { stat, total, shooterId } = r
  const rows = Object.entries(stat).map(([id, s]) => ({ id, p: byId[id], ...s }))

  // 1) 과속 — GK는 다이브가 있어 제외한다 (달리기가 아니라 몸을 던지는 동작)
  const over = rows
    .filter((r2) => r2.p.position !== 'GK')
    .map((r2) => ({ ...r2, ratio: r2.max / runSpeedOf(r2.p) }))
    .filter((r2) => r2.ratio > SPEED_TOL)
    .sort((a, b) => b.ratio - a.ratio)
  chk(
    `자기 주력을 넘는 선수 없음 (최대 ×${Math.max(...rows.filter((x) => x.p.position !== 'GK').map((x) => x.max / runSpeedOf(x.p))).toFixed(2)})`,
    over.length === 0,
    over.length ? over.slice(0, 3).map((o) => `${o.p.name} ${o.max.toFixed(1)}m/s (한계 ${runSpeedOf(o.p).toFixed(1)})`).join(', ') : null,
  )

  // 2) 순간이동 — 한 프레임 이동량이 물리 상한을 넘는가.
  //    프레임 간격(약 16ms)에 상한 속도를 곱한 값이 기준. 여유롭게 잡아도 23m 점프는 걸린다.
  const worstJump = rows.reduce((a, b) => (b.jump > a.jump ? b : a))
  chk(
    `순간이동 없음 (최대 한 프레임 ${worstJump.jump.toFixed(2)}m)`,
    worstJump.jump <= 1.5,
    worstJump.jump > 1.5 ? `${worstJump.p.name} t=${(worstJump.jumpAt / 1000).toFixed(2)}s` : null,
  )

  // 3) 석상 — 재생 내내 굳어 있는 선수. 슈터는 골 세리머니에서 제자리에 서므로 제외.
  const frozen = rows.filter((r2) => r2.id !== shooterId && r2.worstStill > STILL_MAX_S).sort((a, b) => b.worstStill - a.worstStill)
  chk(
    `${STILL_MAX_S}초 이상 굳어 있는 선수 없음 (최장 ${Math.max(...rows.filter((x) => x.id !== shooterId).map((x) => x.worstStill)).toFixed(1)}s)`,
    frozen.length === 0,
    frozen.length ? frozen.slice(0, 3).map((f) => `${f.p.name} ${f.worstStill.toFixed(1)}s`).join(', ') : null,
  )
  console.log(`     (재생 ${(total / 1000).toFixed(1)}s · 총 이동 최대 ${Math.max(...rows.map((x) => x.moved)).toFixed(0)}m)`)
}

console.log(fails === 0 ? '\n움직임 검증 통과 ✅' : `\n${fails}건 실패 ❌`)
process.exit(fails === 0 ? 0 : 1)
