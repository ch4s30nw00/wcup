// scripts/coord-sensitivity.mjs — 좌표 오차 민감도 측정 (node scripts/coord-sensitivity.mjs [오차m])
//
// 물음: 손으로 찍은 152개 좌표를 전부 정밀하게 찍어야 하는가?
//
// 판정 함수(calcPass·calcShot·calcDribble)는 상대팀 좌표만 인자로 받는다 — 아군 좌표는
// 액션의 시작·도착점으로만 들어간다. 그래서 "좌표가 틀리면 판정이 틀어진다"는 경로는
// 상대 선수 한 명 한 명의 압박항 e^(−d/R)뿐이다. R이 2~4m라 멀리 있는 수비수는
// 아무리 틀려도 결과가 안 바뀐다 — 그 경계가 어디인지를 잰다.
//
// 방법: 선수 한 명을 8방향으로 δm 옮겨보고, 그 경기에서 나올 법한 액션 묶음의
// 성공확률이 최대 몇 %p 흔들리는지 본다. 액션 묶음은 고정 — 오직 그 선수만 움직인다.

import { readFileSync } from 'node:fs'
import { calcShot, calcPass, calcDribble, probOf } from '../src/engine/resolve.js'
import { midpoint } from '../src/engine/geometry.js'

const read = (f) => JSON.parse(readFileSync(new URL(`../src/data/${f}`, import.meta.url), 'utf-8'))
const players = read('players.json')
const POS = read('positions.json').positions
const scenarios = [read('scenarios.json')]
for (const f of ['scenes-2026.json', 'kor_ita_2002.json', 'kor_ger_2018.json']) {
  try {
    const d = read(f)
    scenarios.push(...(Array.isArray(d) ? d : d.matches ? d.matches : [d]))
  } catch {
    /* 없으면 건너뛴다 */
  }
}
const byMatch = new Map()
for (const s of scenarios) if (s?.match_id) byMatch.set(s.match_id, s)

const DELTA = Number(process.argv[2] ?? 5) // 좌표 오차 가정치(m)
const DIRS = Array.from({ length: 8 }, (_, i) => {
  const a = (i * Math.PI) / 4
  return [Math.cos(a), Math.sin(a)]
})
const GOAL = { x: 120, y: 40 }
const clampPitch = (p) => ({ x: Math.min(120, Math.max(0, p.x)), y: Math.min(80, Math.max(0, p.y)) })
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const act = (type, from, to, actor) => ({ type, from, to, ctrl: midpoint(from, to), actor })

// 그 경기에서 감독이 실제로 그릴 법한 액션들. 좌표 하나가 흔들렸을 때
// "어떤 판정이든 최대 얼마나 바뀌는가"를 보려는 것이므로 넓게 깐다.
function probesFor(mates, carrier) {
  const probes = []
  for (const [dx, dy] of DIRS)
    for (const L of [8, 15])
      probes.push(act('dribble', carrier, clampPitch({ x: carrier.x + dx * L, y: carrier.y + dy * L }), carrier))
  for (const m of mates) if (m.id !== carrier.id) probes.push(act('pass', carrier, m, carrier))
  for (const m of [carrier, ...mates]) if (dist(m, GOAL) <= 35) probes.push(act('shot', m, GOAL, m))
  return probes
}

const probOfProbe = (a, opps) => {
  if (a.type === 'shot') return probOf(calcShot(a, opps))
  if (a.type === 'pass') return probOf(calcPass(a, opps))
  return probOf(calcDribble(a, opps))
}

console.log(`좌표 오차 ±${DELTA}m 가정 — 그 선수 하나만 옮겼을 때 판정이 흔들리는 폭\n`)

const all = []
for (const [matchId, pos] of Object.entries(POS)) {
  const sc = byMatch.get(matchId)
  const ids = Object.keys(pos)
  const get = (id) => {
    const p = players.find((q) => q.id === id)
    return p ? { ...p, ...pos[id] } : null
  }
  // 조작하는 팀은 공을 든 선수가 속한 쪽이다 — id 첫 글자로 넘겨짚으면
  // 파일마다 선수 순서가 달라서 팀이 뒤집힌다(bra_nor에서 실제로 뒤집혔다).
  const carrierId = sc?.moments?.[0]?.ball ?? sc?.ball
  if (!carrierId) {
    console.log(`${matchId}: 볼 소유자를 못 찾아 건너뜀\n`)
    continue
  }
  const homePfx = carrierId.split('_')[0]
  const mates = ids.filter((i) => i.startsWith(homePfx)).map(get).filter(Boolean)
  const opps = ids.filter((i) => !i.startsWith(homePfx)).map(get).filter(Boolean)
  if (!mates.length || !opps.length) {
    console.log(`${matchId}: players.json에 선수가 없어 건너뜀\n`)
    continue
  }
  const carrier = get(carrierId)
  const probes = probesFor(mates, carrier)
  const base = probes.map((a) => probOfProbe(a, opps))

  const rows = []
  for (let k = 0; k < opps.length; k++) {
    let worst = 0
    for (const [dx, dy] of DIRS) {
      const moved = opps.map((o, i) =>
        i === k ? { ...o, ...clampPitch({ x: o.x + dx * DELTA, y: o.y + dy * DELTA }) } : o,
      )
      probes.forEach((a, j) => {
        worst = Math.max(worst, Math.abs(probOfProbe(a, moved) - base[j]))
      })
    }
    const o = opps[k]
    rows.push({
      id: o.id,
      name: o.name,
      dBall: dist(o, carrier),
      // 액션은 공에서만 나가는 게 아니라 아군 사이를 오가고 골문으로 향한다.
      // "공까지 거리"가 민감도를 설명하지 못하면 이 둘이 설명하는지 본다.
      dMate: Math.min(...mates.map((m) => dist(o, m))),
      dGoal: dist(o, GOAL),
      worst,
    })
  }
  rows.sort((a, b) => b.worst - a.worst)
  const matters = rows.filter((r) => r.worst >= 0.02)
  all.push({ matchId, rows, matters: matters.length, opps: opps.length, mates: mates.length })

  console.log(`■ ${matchId}  (공: ${carrier.name}, 상대 ${opps.length}명, 아군 ${mates.length}명, 프로브 ${probes.length}개)`)
  for (const r of rows)
    console.log(
      `   ${r.worst >= 0.02 ? '●' : '·'} ${String(r.name).padEnd(22)} 공 ${r.dBall.toFixed(1).padStart(5)}m  최근접아군 ${r.dMate.toFixed(1).padStart(5)}m  골문 ${r.dGoal.toFixed(1).padStart(5)}m   최대변동 ${(r.worst * 100).toFixed(1).padStart(5)}%p`,
    )
  console.log(`   → 유의미(≥2%p): ${matters.length}명 / ${opps.length}명\n`)
}

const totOpp = all.reduce((s, m) => s + m.opps, 0)
const totMat = all.reduce((s, m) => s + m.matters, 0)
const totMates = all.reduce((s, m) => s + m.mates, 0)
console.log('─'.repeat(64))
console.log(`전체 상대 선수 ${totOpp}명 중 판정에 유의미한 선수: ${totMat}명 (${((totMat / totOpp) * 100).toFixed(0)}%)`)
console.log(`아군 ${totMates}명은 판정 함수에 인자로 들어가지 않는다 (액션의 시작·도착점으로만 쓰인다)`)

// "무엇을 보면 정밀하게 찍을 선수를 고를 수 있는가" — 후보 지표 셋을 나란히 본다.
const flat = all.flatMap((m) => m.rows)
const BANDS = [[0, 5], [5, 10], [10, 15], [15, 20], [20, 30], [30, 45], [45, 999]]
for (const [key, label] of [['dBall', '공까지'], ['dMate', '최근접 아군까지'], ['dGoal', '골문까지']]) {
  console.log(`\n${label} 거리 구간별 최대변동:`)
  for (const [lo, hi] of BANDS) {
    const g = flat.filter((r) => r[key] >= lo && r[key] < hi)
    if (!g.length) continue
    const mx = Math.max(...g.map((r) => r.worst))
    const avg = g.reduce((s, r) => s + r.worst, 0) / g.length
    const safe = g.filter((r) => r.worst < 0.02).length
    console.log(
      `  ${String(lo).padStart(2)}~${hi === 999 ? '  ∞' : String(hi).padStart(3)}m  ${String(g.length).padStart(3)}명   평균 ${(avg * 100).toFixed(2).padStart(5)}%p   최대 ${(mx * 100).toFixed(1).padStart(5)}%p   무시가능 ${safe}/${g.length}`,
    )
  }
}

// 상관계수 — 세 지표 중 무엇이 민감도를 실제로 예측하는가
const corr = (key) => {
  const xs = flat.map((r) => r[key])
  const ys = flat.map((r) => r.worst)
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length
  const my = ys.reduce((a, b) => a + b, 0) / ys.length
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my)
    dx += (xs[i] - mx) ** 2
    dy += (ys[i] - my) ** 2
  }
  return num / Math.sqrt(dx * dy)
}
console.log('\n민감도와의 상관계수 (음수일수록 "멀수록 안 중요")')
for (const k of ['dBall', 'dMate', 'dGoal']) console.log(`  ${k.padEnd(6)} r = ${corr(k).toFixed(3)}`)
