// scripts/verify.mjs — 엔진 검증 하네스 (node scripts/verify.mjs)
// 1) 산식확정 보고서 v2의 검증 앵커 15개가 스탯 중립 기준으로 유지되는지
// 2) v2.1 신규 메커니즘(중거리 완화·헤더·크로스·수비 스탯 스케일·몸싸움 듀얼)의 방향성
// 3) 수비 재배치가 만드는 "수비 붕괴"의 창발 (고정 수비 대비 비교)
// 을 확인한다. 실패 시 exit 1.

import { calcShot, calcPass, calcDribble, resolveSequence } from '../src/engine/resolve.js'
import { initDefense, advanceDefense } from '../src/engine/defense.js'
import { matchScore } from '../src/engine/match.js'
import { XT_GRID, xtAt, planScore, planGrade } from '../src/engine/xt.js'
import { midpoint } from '../src/engine/geometry.js'
import { K } from '../src/engine/constants.js'
import { readFileSync } from 'node:fs'

const sigmoid = (z) => 1 / (1 + Math.exp(-z))
// 스탯 중립값: norm(v) = 0.70 이 되는 FM 값 (= 검증 앵커의 "스킬 중립")
const MIDFM = ((K.STAT.MID - K.STAT_FLOOR) * K.STAT.FM_MAX) / (1 - K.STAT_FLOOR)
const STAT_KEYS = ['flair','finishing','dribbling','longshots','crossing','passing','heading','strength','acceleration','pace','jumping','balance','marking','tackle','positioning','anticipation']
const neutral = (over = {}) => ({
  heightCm: 182.5,
  stats: Object.fromEntries(STAT_KEYS.map((k) => [k, over[k] ?? MIDFM])),
})
const defAt = (x, y, over = {}) => ({ id: `d${x}_${y}`, position: 'DF', x, y, ...neutral(over) })
const act = (type, from, to, actor = neutral()) => ({ type, from, to, ctrl: midpoint(from, to), actor })

let fails = 0
const check = (label, got, want, tol = 0.005) => {
  const ok = Math.abs(got - want) <= tol
  if (!ok) fails++
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}: ${got.toFixed(3)} (기대 ${want})`)
}
const checkDir = (label, cond, detail) => {
  if (!cond) fails++
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

// ── 1. 보고서 검증 앵커 ──────────────────────────────────────────────
console.log('\n[앵커] 패스 무압박 (L=8/20/30 → 0.90/0.75/0.55)')
for (const [L, want] of [[8, 0.9], [20, 0.75], [30, 0.55]]) {
  const a = act('pass', { x: 40, y: 40 }, { x: 40 + L, y: 40 })
  check(`L=${L}m`, sigmoid(calcPass(a, []).z), want)
}

console.log('[앵커] 패스 리시버 압박 (L=20, d=0.5/2/8 → 0.34/0.47/0.70)')
for (const [d, want] of [[0.5, 0.34], [2, 0.47], [8, 0.7]]) {
  const a = act('pass', { x: 40, y: 40 }, { x: 60, y: 40 })
  check(`d_recv=${d}m`, sigmoid(calcPass(a, [defAt(60 + d, 40)]).z), want)
}

console.log('[앵커] 중앙 슛 xG (D=6/11/13/16.5/20 → 0.55/0.20/0.13/0.06/0.03)')
for (const [D, want] of [[6, 0.55], [11, 0.2], [13, 0.13], [16.5, 0.06], [20, 0.03]]) {
  const a = act('shot', { x: 120 - D, y: 40 }, { x: 119, y: 40 })
  check(`D=${D}m`, sigmoid(calcShot(a, []).z), want)
}

console.log('[앵커] 드리블 1v1 (L=6, 간격 0.5/2/3/5 → 0.49/0.67/0.74/0.81)')
for (const [g, want] of [[0.5, 0.49], [2, 0.67], [3, 0.74], [5, 0.81]]) {
  const a = act('dribble', { x: 40, y: 40 }, { x: 46, y: 40 })
  check(`간격 ${g}m`, sigmoid(calcDribble(a, [defAt(43, 40 + g)]).z), want)
}

console.log('[앵커] 궤적 매칭 커널 (편차 1/2/3/5m → 0.95/0.80/0.61/0.25)')
for (const [d, want] of [[1, 95], [2, 80], [3, 61], [5, 25]]) {
  const answer = [{ x: 10, y: 40 }, { x: 30, y: 40 }]
  const user = [{ x: 10, y: 40 + d }, { x: 30, y: 40 + d }]
  check(`d=${d}m`, matchScore(user, answer), want, 1)
}

// ── 2. v2.1 신규 메커니즘 방향성 ─────────────────────────────────────
console.log('\n[신규] 중거리 스탯 — 거리 감쇠 완화 (데이터 요청 §8)')
{
  const from = { x: 96, y: 40 } // 24m 중거리
  const lo = sigmoid(calcShot(act('shot', from, { x: 119, y: 40 }, neutral({ longshots: 6 })), []).z)
  const hi = sigmoid(calcShot(act('shot', from, { x: 119, y: 40 }, neutral({ longshots: 18 })), []).z)
  checkDir(`중거리 6 → ${lo.toFixed(3)} < 중거리 18 → ${hi.toFixed(3)}`, hi > lo * 1.5)
}

console.log('[신규] 크로스→헤더 — 골결:헤더 3:7 + 공중 듀얼 (데이터 요청 §2·3)')
{
  const cross = act('pass', { x: 95, y: 70 }, { x: 112, y: 44 }) // 측면 → 박스
  const header = (actor, defs) => calcShot({ ...act('shot', { x: 112, y: 44 }, { x: 119, y: 41 }), actor }, defs, cross)
  checkDir('크로스 직후 슛이 헤더로 판정', header(neutral(), []).header === true)
  const tall = header(neutral({ heading: 17, jumping: 16 }), [])
  const small = header(neutral({ heading: 6, jumping: 8 }), [])
  checkDir(`헤더 17/점프 16 (${sigmoid(tall.z).toFixed(3)}) > 헤더 6/점프 8 (${sigmoid(small.z).toFixed(3)})`, tall.z > small.z)
  const vsTallDef = header(neutral(), [defAt(112, 42.5, { jumping: 18 })])
  const vsSmallDef = header(neutral(), [defAt(112, 42.5, { jumping: 5 })])
  checkDir('수비 점프 18 상대가 점프 5 상대보다 어려움', vsTallDef.z < vsSmallDef.z)
  checkDir('일반 슛은 header 아님', calcShot(act('shot', { x: 110, y: 40 }, { x: 119, y: 40 }), []).header === false)
}

console.log('[신규] 수비 스탯 스케일 — 위치선정·예측력 (데이터 요청 §6·7)')
{
  const a = act('pass', { x: 40, y: 40 }, { x: 60, y: 40 })
  const weak = sigmoid(calcPass(a, [defAt(62, 40, { positioning: 5, anticipation: 5 })]).z)
  const strong = sigmoid(calcPass(a, [defAt(62, 40, { positioning: 17, anticipation: 17 })]).z)
  checkDir(`위치선정 17 수비 (${strong.toFixed(3)}) < 위치선정 5 수비 (${weak.toFixed(3)})`, strong < weak)
}

console.log('[신규] 드리블 듀얼 — 마크·태클 수비 + 몸싸움·균형 (데이터 요청 §1·5)')
{
  const a = act('dribble', { x: 40, y: 40 }, { x: 46, y: 40 })
  const vsWeak = sigmoid(calcDribble(a, [defAt(43, 41, { marking: 5, tackle: 5, anticipation: 8 })]).z)
  const vsStrong = sigmoid(calcDribble(a, [defAt(43, 41, { marking: 17, tackle: 17, anticipation: 16 })]).z)
  checkDir(`태클 17 상대 (${vsStrong.toFixed(3)}) < 태클 5 상대 (${vsWeak.toFixed(3)})`, vsStrong < vsWeak)
  const strongAtt = sigmoid(calcDribble({ ...a, actor: neutral({ strength: 17, balance: 16 }) }, [defAt(43, 41)]).z)
  const weakAtt = sigmoid(calcDribble({ ...a, actor: neutral({ strength: 5, balance: 6 }) }, [defAt(43, 41)]).z)
  checkDir(`몸싸움 17 공격수 (${strongAtt.toFixed(3)}) > 몸싸움 5 (${weakAtt.toFixed(3)})`, strongAtt > weakAtt)
}

// ── 3. 수비 재배치 — 붕괴의 창발 ────────────────────────────────────
console.log('\n[수비 재배치] 미끼 후 전환: 한쪽으로 끌고 → 빈 반대편 공략 (수비 붕괴)')
{
  // 백4 + GK. 미끼 패스로 수비를 왼쪽 아래로 끌어낸 뒤 오른쪽 빈 공간으로 전환.
  const defs0 = initDefense([
    defAt(95, 30), defAt(97, 38), defAt(96, 46), defAt(94, 54),
    { ...defAt(116.5, 40), position: 'GK' },
  ])
  const bait = act('pass', { x: 70, y: 40 }, { x: 80, y: 16 }) // 미끼: 왼쪽 측면
  const switchP = act('pass', { x: 80, y: 16 }, { x: 93, y: 57 }) // 전환: 오른쪽 하프스페이스
  const defs1 = advanceDefense(defs0, { to: bait.to, durSec: 1.2, attackers: [{ id: 'a', x: 80, y: 16 }] })
  const ps = sigmoid(calcPass(switchP, defs0).z) // 수비가 안 움직였다면
  const pd = sigmoid(calcPass(switchP, defs1).z) // 미끼에 끌려간 수비 상대
  console.log(`    전환 패스: 고정 수비 ${ps.toFixed(3)} → 끌려간 수비 ${pd.toFixed(3)}`)
  checkDir('미끼에 끌려간 수비 상대로 전환 패스가 더 쉬움 (붕괴 창발)', pd > ps, `+${((pd - ps) * 100).toFixed(1)}%p`)
  const moved = defs1.reduce((m, d, i) => m + Math.hypot(d.x - defs0[i].x, d.y - defs0[i].y), 0) / defs1.length
  checkDir(`수비수 평균 이동 ${moved.toFixed(1)}m (> 2m)`, moved > 2)

  // 반대로 같은 곳만 두드리면(수비가 모인 곳으로 재진입) 더 어려워야 한다
  const again = act('pass', { x: 80, y: 16 }, { x: 90, y: 24 })
  const psA = sigmoid(calcPass(again, defs0).z)
  const pdA = sigmoid(calcPass(again, defs1).z)
  checkDir(`모인 쪽 재진입은 더 어려움 (${psA.toFixed(3)} → ${pdA.toFixed(3)})`, pdA < psA)
}

console.log('[수비 재배치] 결정론 — 같은 입력 두 번 = 같은 좌표')
{
  const mk = () => {
    let d = initDefense([defAt(90, 30), defAt(92, 50)])
    d = advanceDefense(d, { to: { x: 100, y: 40 }, durSec: 1.0, attackers: [] })
    d = advanceDefense(d, { to: { x: 108, y: 44 }, durSec: 0.8, attackers: [] })
    return d.map((x) => `${x.x.toFixed(6)},${x.y.toFixed(6)}`).join(';')
  }
  checkDir('결정론 유지', mk() === mk())
}

// ── 3c. xT 그리드 / PlanScore (판정과 독립) ──────────────────────────
console.log('\n[xT] 정적 그리드 — 벨만 재귀 수렴 결과의 형태')
{
  checkDir(`그리드 크기 ${XT_GRID.length} = NX×NY (${K.XT.NX}×${K.XT.NY})`, XT_GRID.length === K.XT.NX * K.XT.NY)
  checkDir('모든 값이 유효 확률 범위 [0, 1]', XT_GRID.every((v) => v >= 0 && v <= 1))

  // 중앙선을 따라 전진하면 xT가 단조 증가해야 한다.
  // (소유 유지율 ρ 없이 짰을 때 그리드가 평평해진 적이 있어 회귀 방지용으로 남긴다.)
  const line = [10, 30, 50, 70, 90, 100, 110].map((x) => xtAt({ x, y: 40 }))
  const monotone = line.every((v, i) => i === 0 || v > line[i - 1])
  checkDir(`중앙 전진 시 xT 단조 증가 (${line.map((v) => v.toFixed(4)).join(' → ')})`, monotone)

  // 골문 앞이 자기 진영보다 훨씬 위협적이어야 한다 (평평하면 이 배수가 1에 가까워진다)
  const ratio = xtAt({ x: 118, y: 40 }) / xtAt({ x: 10, y: 40 })
  checkDir(`골문 앞 / 자기 진영 xT 비 = ${ratio.toFixed(1)}배 (> 20)`, ratio > 20)

  // 같은 x에서는 중앙이 측면보다 위협적
  checkDir(
    `중앙(y=40) > 측면(y=8) at x=105 (${xtAt({ x: 105, y: 40 }).toFixed(4)} > ${xtAt({ x: 105, y: 8 }).toFixed(4)})`,
    xtAt({ x: 105, y: 40 }) > xtAt({ x: 105, y: 8 }),
  )
}

console.log('[xT] PlanScore — 전진 설계는 +, 후퇴는 −')
{
  const fwd = planScore([
    { type: 'dribble', from: { x: 48, y: 34 }, to: { x: 82, y: 36 } },
    { type: 'pass', from: { x: 82, y: 36 }, to: { x: 105, y: 45 } },
    { type: 'shot', from: { x: 105, y: 45 }, to: { x: 119, y: 39 } },
  ])
  checkDir(`90+1 재현 체인 PlanScore = +${fwd.total.toFixed(4)} (양수)`, fwd.total > 0)
  checkDir('스텝 델타 합 = total', Math.abs(fwd.steps.reduce((m, s) => m + s.delta, 0) - fwd.total) < 1e-12)
  checkDir(`등급 S/A (${planGrade(fwd.total).label})`, ['S', 'A'].includes(planGrade(fwd.total).label))

  const back = planScore([{ type: 'pass', from: { x: 80, y: 40 }, to: { x: 40, y: 40 } }])
  checkDir(`백패스 PlanScore = ${back.total.toFixed(4)} (음수)`, back.total < 0)

  // 판정과 독립 — 수비수·시드를 전혀 보지 않는다 (같은 체인이면 항상 같은 점수)
  const a = planScore([{ type: 'pass', from: { x: 60, y: 40 }, to: { x: 100, y: 40 } }]).total
  const b = planScore([{ type: 'pass', from: { x: 60, y: 40 }, to: { x: 100, y: 40 } }]).total
  checkDir('결정론 — 같은 체인이면 같은 점수', a === b)
  checkDir('빈 체인은 0점', planScore([]).total === 0)
}

// ── 4. 실제 시나리오 스모크: 90+1 역습 재현 체인 ─────────────────────
console.log('\n[스모크] 실제 데이터로 resolveSequence (손흥민 드리블→황희찬 패스→슛)')
{
  const players = JSON.parse(readFileSync(new URL('../src/data/players.json', import.meta.url), 'utf-8'))
  const scenario = JSON.parse(readFileSync(new URL('../src/data/scenarios.json', import.meta.url), 'utf-8'))
  const moment = scenario.moments[0]
  const pos = moment.positions
  const get = (id) => ({ ...players.find((p) => p.id === id), ...pos[id] })
  const opponents = Object.keys(pos).filter((id) => id.startsWith('por')).map(get)
  const son = get('kor_07')
  const hwang = get('kor_11')
  const actions = [
    { type: 'dribble', actorId: 'kor_07', actor: son, from: pos.kor_07, to: { x: 82, y: 36 }, ctrl: midpoint(pos.kor_07, { x: 82, y: 36 }) },
    { type: 'pass', actorId: 'kor_07', receiverId: 'kor_11', actor: son, from: { x: 82, y: 36 }, to: { x: 105, y: 45 }, ctrl: midpoint({ x: 82, y: 36 }, { x: 105, y: 45 }) },
    { type: 'shot', actorId: 'kor_11', actor: hwang, from: { x: 105, y: 45 }, to: { x: 119, y: 39 }, ctrl: midpoint({ x: 105, y: 45 }, { x: 119, y: 39 }) },
  ]
  const homeStart = Object.keys(pos).filter((id) => id.startsWith('kor')).map(get)
  const res = resolveSequence(actions, { opponents, players: homeStart, seed: 20221202 })
  res.steps.forEach((s, i) => console.log(`    ${i + 1}. ${s.type} p=${(s.p * 100).toFixed(0)}%${s.header ? ' (헤더)' : ''}${s.cross ? ' (크로스)' : ''}`))
  console.log(`    outcome=${res.outcome} pTotal=${(res.pTotal * 100).toFixed(1)}%`)
  checkDir('스텝별 defPos 스냅샷 존재', res.steps.every((s) => s.defPos && Object.keys(s.defPos).length === opponents.length))
  checkDir('확률이 유효 범위', res.steps.every((s) => s.p >= K.P_MIN && s.p <= K.P_MAX))
}

console.log(fails === 0 ? '\n모든 검증 통과 ✅' : `\n${fails}건 실패 ❌`)
process.exit(fails === 0 ? 0 : 1)
