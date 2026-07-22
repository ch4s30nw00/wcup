// scripts/verify.mjs — 엔진 검증 하네스 (node scripts/verify.mjs)
// 1) 산식확정 보고서 v2의 검증 앵커 15개가 스탯 중립 기준으로 유지되는지
// 2) v2.1 신규 메커니즘(중거리 완화·헤더·크로스·수비 스탯 스케일·몸싸움 듀얼)의 방향성
// 3) 수비 재배치가 만드는 "수비 붕괴"의 창발 (고정 수비 대비 비교)
// 을 확인한다. 실패 시 exit 1.

import { calcShot, calcPass, calcDribble, resolveSequence, planOffside, probOf } from '../src/engine/resolve.js'
import { checkOffside, offsideLineX } from '../src/engine/offside.js'
import { initDefense, advanceDefense } from '../src/engine/defense.js'
import { matchScore } from '../src/engine/match.js'
import { throughTarget } from '../src/engine/sheets.js'
import { encodeShare, decodeShare } from '../src/engine/share.js'
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

console.log('[앵커] 중앙·무압박 발슈팅 xG (6/12/18/25yd → 0.42/0.18/0.09/0.04)')
for (const [D, want] of [[5.5, 0.42], [11, 0.18], [16.5, 0.09], [23, 0.04]]) {
  const a = act('shot', { x: 120 - D, y: 40 }, { x: 119, y: 40 })
  check(`D=${D}m`, sigmoid(calcShot(a, []).z), want)
}

console.log('[앵커] 슛 라인 블로커 — 감점은 하되 자동 선방으로 만들지 않음')
{
  const a = act('shot', { x: 109, y: 40 }, { x: 119, y: 40 })
  check('12yd, 라인 위 블로커', sigmoid(calcShot(a, [defAt(114, 40)]).z), 0.095)
  check('12yd, 라인에서 2m 블로커', sigmoid(calcShot(a, [defAt(114, 42)]).z), 0.143)
}

console.log('[앵커] 골키퍼와 1대1 — 열린 슛길의 단독 찬스 보정')
{
  const gk = { id: 'gk', position: 'GK', x: 116.5, y: 40, ...neutral() }
  const a = act('shot', { x: 109, y: 40 }, { x: 119, y: 40 })
  const open = calcShot(a, [gk])
  const screened = calcShot(a, [gk, defAt(114, 40)])
  checkDir(`12yd 1대1 (${sigmoid(open.z).toFixed(3)})은 단독 찬스로 판정`, open.oneOnOne === true)
  check('12yd 1대1 xG', sigmoid(open.z), 0.55)
  checkDir('수비수가 슛길을 막으면 1대1 보정 제외', screened.oneOnOne === false)
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

// ── 2b. 경합 게이트 (v2.2) — "수비수 없으면 드리블은 실패하지 않는다" ──
// 주의: 위 앵커 15개는 calc*()의 로그오즈 z를 그대로 본다(산식 불변 확인용).
// 여기서는 게이트까지 적용된 **실제 게임 확률**(probOf)을 본다.
console.log('\n[경합 게이트] 드리블 — 압박이 없으면 실패도 없다 (사용자 확정 2026-07-20)')
{
  const drib = (defs, L = 6) => probOf(calcDribble(act('dribble', { x: 40, y: 40 }, { x: 40 + L, y: 40 }), defs))
  checkDir(`수비수 0명 · 6m → ${(drib([]) * 100).toFixed(1)}% (= 100%)`, drib([]) === 1)
  checkDir(`수비수 0명 · 25m 장거리도 100% (${(drib([], 25) * 100).toFixed(1)}%)`, drib([], 25) === 1)
  // 멀리 있는 수비수는 사실상 없는 것과 같다 (연속적으로 1에 수렴 — 임계 점프 없음)
  const far = drib([defAt(40, 70)])
  checkDir(`30m 밖 수비수 → ${(far * 100).toFixed(2)}% (> 99%)`, far > 0.99 && far < 1)
  // 근접 수비는 기존과 동일하게 막는다 (사용자: "근처에 있으면 막히는 것도 맞고")
  const near = drib([defAt(43, 40.5)])
  checkDir(`간격 0.5m 근접 수비 → ${(near * 100).toFixed(1)}% (기존 49%대 유지)`, Math.abs(near - 0.49) < 0.02)
  // 간격이 벌어질수록 단조 증가
  const ladder = [0.5, 2, 5, 10].map((g) => drib([defAt(43, 40 + g)]))
  checkDir(
    `간격별 단조 증가 (${ladder.map((v) => (v * 100).toFixed(0) + '%').join(' → ')})`,
    ladder.every((v, i) => i === 0 || v > ladder[i - 1]),
  )
}

console.log('[경합 게이트] 패스·슛에는 적용하지 않는다 (빠질 수 있어야 한다)')
{
  // 사용자 지적: "패스는 빠질 수 있잖아" → 무압박이어도 100%가 아니다 (앵커 그대로)
  const pass = (L) => probOf(calcPass(act('pass', { x: 40, y: 40 }, { x: 40 + L, y: 40 }), []))
  checkDir(`무압박 패스 30m → ${(pass(30) * 100).toFixed(0)}% (< 100%, 앵커 0.55 유지)`, Math.abs(pass(30) - 0.55) < 0.01)
  checkDir(`무압박 패스 8m → ${(pass(8) * 100).toFixed(0)}% (< 100%)`, pass(8) < 1)
  const shot = probOf(calcShot(act('shot', { x: 108, y: 40 }, { x: 119, y: 40 }), []))
  checkDir(`무수비 슛 12m → ${(shot * 100).toFixed(0)}% (< 100%, 골결정력으로 빗나갈 수 있다)`, shot < 1)
}

// ── 2c. 스루패스 도착점 — "공과 사람이 같이 도착" ────────────────────
console.log('\n[스루패스] 도착점이 리시버 가동범위 안에 들어오는가')
{
  const runnerFrom = { x: 53, y: 46 }
  const ballFrom = { x: 48, y: 34 }
  const player = neutral({ pace: 15, acceleration: 15 })
  const speed = K.DEF.SPD_MIN + (K.DEF.SPD_MAX - K.DEF.SPD_MIN) * (15 / K.STAT.FM_MAX)
  // 공이 도착하는 시간 안에 리시버가 그 지점까지 갈 수 있어야 한다
  const feasible = (p) => {
    const runT = Math.hypot(p.x - runnerFrom.x, p.y - runnerFrom.y) / speed
    const ballT = Math.hypot(p.x - ballFrom.x, p.y - ballFrom.y) / K.SPEED.pass + K.DEF.REACT
    return runT <= ballT + 1e-6
  }
  // 너무 먼 지점(47m)을 찍으면 성립하는 데까지 당겨야 한다 — 예전엔 그대로 통과해
  // 리시버가 자기 동심원 밖에 놓였고, 유저가 손으로 다시 옮겨야 했다 (회귀 방지)
  const want = { x: 100, y: 52 }
  checkDir(`찍은 지점(47.4m)은 원래 성립 불가`, !feasible(want))
  const got = throughTarget({ runnerFrom, ballFrom, want, player })
  const d = Math.hypot(got.x - runnerFrom.x, got.y - runnerFrom.y)
  checkDir(`당겨진 도착점 ${d.toFixed(1)}m → 성립`, feasible(got))
  checkDir('원래 찍은 방향 위에 있다', Math.abs((got.x - runnerFrom.x) * (want.y - runnerFrom.y) - (got.y - runnerFrom.y) * (want.x - runnerFrom.x)) < 1e-6)
  // 가까운 지점은 손대지 않는다
  const near = { x: 58, y: 47 }
  const keep = throughTarget({ runnerFrom, ballFrom, want: near, player })
  checkDir('성립하는 지점은 그대로 둔다', keep.x === near.x && keep.y === near.y)
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

// ── 3b. 오프사이드 (순수 기하) ───────────────────────────────────────
console.log('\n[오프사이드] 최후방 2번째 수비수 라인 판정')
{
  // 백4(x=90,92,94,96) + GK(116.5). 내림차순 116.5, 96, 94, 92, 90 → 라인 = 96
  const line4 = [defAt(90, 30), defAt(92, 38), defAt(94, 46), defAt(96, 54), { ...defAt(116.5, 40), position: 'GK' }]
  check('라인 = 최후방 2번째 (GK 포함 정렬)', offsideLineX(line4), 96, 0.001)

  const at = (rx, ball = { x: 70, y: 40 }) => checkOffside({ receiver: { x: rx, y: 40 }, opponents: line4, ball })
  checkDir('라인 뒤(x=98) → 오프사이드', at(98).offside === true)
  checkDir('라인 앞(x=94) → 온사이드', at(94).offside === false)
  checkDir('동일선상(x=96) → 온사이드 (실축 규칙)', at(96).offside === false)

  // 우리 진영에서는 오프사이드가 없다 — 라인을 넘겨도 x ≤ 60이면 성립 안 함
  const ownHalf = [defAt(50, 30), defAt(52, 40), defAt(55, 50)]
  checkDir(
    '우리 진영(x=58)은 라인을 넘어도 온사이드',
    checkOffside({ receiver: { x: 58, y: 40 }, opponents: ownHalf, ball: { x: 40, y: 40 } }).offside === false,
  )

  // 공보다 뒤에 있으면 온사이드 (백패스는 절대 오프사이드가 아니다)
  checkDir(
    '공보다 뒤(백패스) → 온사이드',
    checkOffside({ receiver: { x: 98, y: 40 }, opponents: line4, ball: { x: 105, y: 40 } }).offside === false,
  )

  // 수비수가 1명 이하면 라인이 정의되지 않는다
  checkDir('수비 1명 → 라인 없음(판정 불가)', offsideLineX([defAt(90, 40)]) === null)
}

console.log('[오프사이드] resolveSequence 통합 — 확정 실패 + 턴오버')
{
  const defs = [defAt(90, 30), defAt(92, 38), defAt(94, 46), defAt(96, 54), { ...defAt(116.5, 40), position: 'GK' }]
  // 판정 기준은 "패스가 떠나는 순간 리시버가 서 있던 자리"(players의 좌표)이지 도착점이 아니다.
  const mkPass = (toX) => ({
    type: 'pass', actorId: 'a1', receiverId: 'a2', actor: neutral(),
    from: { x: 70, y: 40 }, to: { x: toX, y: 40 }, ctrl: midpoint({ x: 70, y: 40 }, { x: toX, y: 40 }),
  })
  // (i) 리시버가 이미 라인(96) 뒤에 서 있다 → 오프사이드
  const standingOff = [{ id: 'a1', x: 70, y: 40 }, { id: 'a2', x: 104, y: 40 }]
  const off = resolveSequence([mkPass(104)], { opponents: defs, players: standingOff, seed: 1 })
  checkDir(`라인 뒤에 서 있는 리시버 → outcome=OFFSIDE (${off.outcome})`, off.outcome === 'OFFSIDE')
  checkDir('오프사이드 스텝은 확정 실패', off.steps[0].success === false && off.steps[0].offside === true)
  checkDir(`오프사이드면 pTotal=0 (${off.pTotal})`, off.pTotal === 0)

  // (ii) 리시버가 라인 앞에서 출발해 공을 향해 달려든다 → 도착점이 라인 뒤여도 온사이드.
  //      역습 스루패스가 성립하는 근거 — 90+1 장면 재현이 오프사이드로 막히면 안 된다.
  const runningOn = [{ id: 'a1', x: 70, y: 40 }, { id: 'a2', x: 70, y: 44 }]
  const thru = resolveSequence([mkPass(104)], { opponents: defs, players: runningOn, seed: 1 })
  checkDir(`침투 패스(뒤에서 출발) → 온사이드 (${thru.outcome})`, thru.steps[0].offside === false && thru.outcome !== 'OFFSIDE')

  const on = resolveSequence([mkPass(92)], { opponents: defs, players: runningOn, seed: 1 })
  checkDir(`라인 앞 패스는 오프사이드 아님 (${on.outcome})`, on.steps[0].offside === false && on.outcome !== 'OFFSIDE')

  // 계획 단계 경고는 판정과 같은 좌표를 본다 (하이브리드 (a) 단계)
  const warn = planOffside([mkPass(104)], { opponents: defs, players: standingOff })
  checkDir('planOffside가 같은 패스를 경고', warn.length === 1 && warn[0].receiverId === 'a2')
  checkDir('침투 패스는 경고 없음', planOffside([mkPass(104)], { opponents: defs, players: runningOn }).length === 0)
  checkDir('온사이드 패스는 경고 없음', planOffside([mkPass(92)], { opponents: defs, players: runningOn }).length === 0)

  // 드리블·슛은 오프사이드 대상이 아니다
  const drib = { type: 'dribble', actorId: 'a1', actor: neutral(), from: { x: 70, y: 40 }, to: { x: 104, y: 40 }, ctrl: midpoint({ x: 70, y: 40 }, { x: 104, y: 40 }) }
  checkDir('드리블은 오프사이드 판정 대상 아님', planOffside([drib], { opponents: defs, players: standingOff }).length === 0)
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

// ── 4b. 경기 데이터 무결성 — 경기 선택 화면에 뜨는 모든 경기 ─────────
// 장면 데이터가 참조하는 선수 id가 players.json에 없으면 보드가 빈 채로 뜬다.
// 좌표 오타(피치 밖)나 팀 배정 실수도 여기서 잡는다 — 브라우저를 열기 전에.
// data/matches.js의 MATCHES와 같은 소스를 같은 순서로 본다.
console.log('\n[경기 데이터] 플레이 가능한 모든 경기의 참조 무결성')
{
  const load = (f) => JSON.parse(readFileSync(new URL(`../src/data/${f}`, import.meta.url), 'utf-8'))
  const players = load('players.json')
  const byId = Object.fromEntries(players.map((p) => [p.id, p]))
  const matches = [load('scenarios.json'), ...load('scenes-2026.json').matches]

  checkDir(`플레이 가능한 경기 ${matches.length}개 (선택 화면 카드 수)`, matches.length >= 1)
  checkDir('경기 id 중복 없음', new Set(matches.map((m) => m.match_id)).size === matches.length)

  for (const scn of matches) {
    const moment = scn.moments[0]
    const ids = Object.keys(moment.positions ?? {})
    const missing = ids.filter((id) => !byId[id])
    checkDir(`${scn.match_id}: 참조 선수 ${ids.length}명 전원 players.json에 존재`, missing.length === 0, missing.join(', '))
    checkDir(`${scn.match_id}: 공 소유자(${moment.ball})가 온필드`, ids.includes(moment.ball))
    // home = 플레이어가 조작하는 팀. 공이 상대에게 있으면 보드가 통째로 뒤집힌다.
    checkDir(`${scn.match_id}: 공 소유자가 home(${scn.home}) 소속`, byId[moment.ball]?.team === scn.home)

    const home = ids.filter((id) => byId[id]?.team === scn.home)
    const away = ids.filter((id) => byId[id]?.team === scn.away)
    checkDir(`${scn.match_id}: ${scn.home} ${home.length}명 vs ${scn.away} ${away.length}명 (양 팀 11명)`, home.length === 11 && away.length === 11)
    checkDir(`${scn.match_id}: 양 팀 GK 1명씩`, [home, away].every((t) => t.filter((id) => byId[id].position === 'GK').length === 1))

    const oob = ids.filter((id) => {
      const { x, y } = moment.positions[id]
      return !(x >= 0 && x <= 120 && y >= 0 && y <= 80)
    })
    checkDir(`${scn.match_id}: 전원 좌표가 피치(120×80) 안`, oob.length === 0, oob.join(', '))
    checkDir(
      `${scn.match_id}: 좌표 중복 없음 (겹쳐 선 선수)`,
      new Set(ids.map((id) => `${moment.positions[id].x},${moment.positions[id].y}`)).size === ids.length,
    )
  }
}

// ── 5. 공유 링크 인코딩 (engine/share.js) ────────────────────────────
// 링크가 깨지면 "내 전술 봐라"가 성립하지 않는다 — 왕복이 무손실인지 확인한다.
console.log('\n[공유 링크] 전술 → URL → 전술 왕복')
{
  const ids = ['kor_01', 'kor_07', 'kor_11', 'kor_09']
  const acts = [
    { type: 'dribble', to: { x: 82.3, y: 36.7 }, ctrl: null },
    { type: 'pass', receiverId: 'kor_11', to: null, ctrl: { x: 90.5, y: 30.2 } }, // 곡선 패스
    { type: 'shot', receiverId: 'GOAL', to: { x: 119, y: 39.4 }, ctrl: null },
  ]
  const runs = [{ id: 'kor_09', to: { x: 100.1, y: 52.6 }, ctrl: null, afterIndex: 1 }]
  const url = encodeShare({ seed: 20221202, chainActs: acts, runs, playerIds: ids })
  const back = decodeShare(url, { playerIds: ids })

  checkDir(`인코딩 길이 ${url.length}자 (URL 안전 · 200자 미만)`, url.length < 200)
  checkDir('URL에 이스케이프 필요한 문자 없음', encodeURIComponent(url) === url)
  checkDir(`시드 왕복 (${back?.seed})`, back?.seed === 20221202)
  checkDir('액션 수 왕복', back?.chainActs.length === 3)
  checkDir('드리블 좌표 왕복 (0.1m 오차 내)', Math.abs(back.chainActs[0].to.x - 82.3) < 0.05 && Math.abs(back.chainActs[0].to.y - 36.7) < 0.05)
  checkDir('패스 수신자 왕복', back.chainActs[1].receiverId === 'kor_11')
  checkDir('곡선 ctrl 보존', Math.abs(back.chainActs[1].ctrl.x - 90.5) < 0.05)
  checkDir('직선 ctrl은 null 유지 (URL 절약)', back.chainActs[0].ctrl === null)
  checkDir("슛의 receiverId='GOAL' 복원", back.chainActs[2].receiverId === 'GOAL' && back.chainActs[2].type === 'shot')
  checkDir('오프볼 런 왕복 (선수·좌표·앵커)', back.runs[0].id === 'kor_09' && back.runs[0].afterIndex === 1 && Math.abs(back.runs[0].to.x - 100.1) < 0.05)

  // 깨진 링크는 예외 대신 null — 앱이 빈 보드로 뜨고 죽지 않아야 한다
  checkDir('빈 값 → null', decodeShare('', { playerIds: ids }) === null)
  checkDir('쓰레기 문자열 → null', decodeShare('zzzz', { playerIds: ids }) === null)
  checkDir('다른 버전 → null', decodeShare('9.123.d_1_2.', { playerIds: ids }) === null)
  checkDir('범위 밖 선수 인덱스 → null', decodeShare('1.123.p_99.', { playerIds: ids }) === null)
  checkDir('빈 전술도 유효 (시드만 공유)', decodeShare('1.777..', { playerIds: ids })?.seed === 777)
}

console.log(fails === 0 ? '\n모든 검증 통과 ✅' : `\n${fails}건 실패 ❌`)
process.exit(fails === 0 ? 0 : 1)
