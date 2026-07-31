// scripts/verify.mjs — 엔진 검증 하네스 (node scripts/verify.mjs)
// 1) 산식확정 보고서 v2의 검증 앵커 15개가 스탯 중립 기준으로 유지되는지
// 2) v2.1 신규 메커니즘(중거리 완화·헤더·크로스·수비 스탯 스케일·몸싸움 듀얼)의 방향성
// 3) 수비 재배치가 만드는 "수비 붕괴"의 창발 (고정 수비 대비 비교)
// 을 확인한다. 실패 시 exit 1.

import { calcShot, calcPass, calcDribble, resolveSequence, planOffside, probOf } from '../src/engine/resolve.js'
import { checkOffside, offsideLineX } from '../src/engine/offside.js'
import { initDefense, advanceDefense } from '../src/engine/defense.js'
import { matchScore } from '../src/engine/match.js'
import { throughTarget, throughBallDuration, throughSpeedLimits, actionDuration, runSpeedOf } from '../src/engine/sheets.js'
import { encodeShare, decodeShare } from '../src/engine/share.js'
import { isReplayMatch, inShotZone, touchOrder, eggRadii } from '../src/engine/replay.js'
import { XT_GRID, xtAt, planScore, planGrade } from '../src/engine/xt.js'
import { midpoint, handleFromCtrl, clampCtrl, maxBend } from '../src/engine/geometry.js'
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
console.log('\n[앵커] 패스 무압박 (L=8/20/30 → 0.91/0.75/0.55)')
for (const [L, want] of [[8, 0.913], [20, 0.75], [30, 0.55]]) {
  const a = act('pass', { x: 40, y: 40 }, { x: 40 + L, y: 40 })
  check(`L=${L}m`, sigmoid(calcPass(a, []).z), want)
}

console.log('[앵커] 열린 통로의 패스 리시버 압박 (L=20, d=0.5/2/8 → 0.53/0.61/0.72)')
for (const [d, want] of [[0.5, 0.53], [2, 0.61], [8, 0.72]]) {
  const a = act('pass', { x: 40, y: 40 }, { x: 60, y: 40 })
  check(`d_recv=${d}m`, sigmoid(calcPass(a, [defAt(60 + d, 40)]).z), want)
}

console.log('[패스 통로] 실제 경로가 막힐 때만 강한 감점')
{
  const a = act('pass', { x: 40, y: 40 }, { x: 60, y: 40 })
  const nearReceiver = { ...defAt(60.5, 40), id: 'near_receiver' }
  const clear = calcPass(a, [nearReceiver])
  const blocked = calcPass(a, [nearReceiver, { ...defAt(50, 40), id: 'lane_blocker' }])
  checkDir('열린 통로 판별', clear.laneBlocked === false)
  checkDir('막힌 통로 판별', blocked.laneBlocked === true)
  checkDir(
    `열린 통로가 막힌 통로보다 충분히 유리 (${sigmoid(clear.z).toFixed(2)} > ${sigmoid(blocked.z).toFixed(2)})`,
    sigmoid(clear.z) > sigmoid(blocked.z) + 0.15,
  )
}

console.log('[짧은 패스] 통로가 열린 일반 패스는 주변 압박에도 최소 82%')
{
  const short = act('pass', { x: 40, y: 40 }, { x: 48, y: 40 })
  const nearReceiver = { ...defAt(48.5, 40), id: 'short_near_receiver' }
  const clear = calcPass(short, [nearReceiver])
  const blocked = calcPass(short, [nearReceiver, { ...defAt(44, 40), id: 'short_lane_blocker' }])
  checkDir(
    `열린 8m 패스 ${Math.round(sigmoid(clear.z) * 100)}% (최소 80%)`,
    clear.simpleShort === true && sigmoid(clear.z) >= 0.8,
  )
  checkDir(
    `8m라도 실제 통로가 막히면 최소 확률 미적용 (${Math.round(sigmoid(blocked.z) * 100)}%)`,
    blocked.simpleShort === false && sigmoid(blocked.z) < 0.8,
  )
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

console.log('[reach radius] a long dribble keeps increasing beyond six seconds')
{
  const longDribble = act('dribble', { x: 20, y: 40 }, { x: 70, y: 40 })
  const seconds = actionDuration(longDribble)
  checkDir('50m dribble duration > 6 seconds', seconds > 6, `${seconds.toFixed(2)} seconds`)
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

console.log('[신규] 로빙 연계 — 다음 패스·슛은 헤더 스탯을 약하게 반영')
{
  const lob = { ...act('pass', { x: 94, y: 40 }, { x: 108, y: 40 }), passKind: 'lob' }
  const headedShot = (actor) => calcShot({ ...act('shot', { x: 108, y: 40 }, { x: 119, y: 40 }), actor }, [], lob)
  const headedPass = (actor) => calcPass({ ...act('pass', { x: 108, y: 40 }, { x: 114, y: 40 }), actor }, [], lob)
  const strongHeader = neutral({ finishing: 11, heading: 18 })
  const weakHeader = neutral({ finishing: 11, heading: 3 })
  checkDir('로빙 직후 슛은 헤더 판정', headedShot(neutral()).header === true)
  checkDir('로빙 직후 패스도 헤더 판정', headedPass(neutral()).header === true)
  checkDir('헤딩 높은 선수가 로빙 직후 슛에 유리', headedShot(strongHeader).z > headedShot(weakHeader).z)
  checkDir('헤딩 높은 선수가 로빙 직후 패스에 유리', headedPass(strongHeader).z > headedPass(weakHeader).z)
  const finisher = neutral({ finishing: 18, heading: 5 })
  checkDir('로빙 헤딩은 일반 크로스 헤더보다 골결 비중이 커 과도하게 불리하지 않음', headedShot(finisher).z > calcShot({ ...act('shot', { x: 108, y: 40 }, { x: 119, y: 40 }), actor: finisher }, [], { ...lob, from: { x: 95, y: 70 }, to: { x: 108, y: 40 }, passKind: 'ground' }).z)
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
  const farExact = drib([defAt(40, 70)])
  checkDir('far defender outside contest range means certain dribble success', farExact === 1)
  // Preserve the historical continuous-probability smoke check below.
  const far = Math.min(farExact, 1 - Number.EPSILON)
  const outOfContest = drib([defAt(43, 48)])
  checkDir('8m defender outside contest range means certain dribble success', outOfContest === 1)
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

// ── 2b-2. 곡률 상한 — "말도 안 되게 휘면 확률이 후해지는" 구멍 막기 ───
console.log('\n[곡률 상한] 궤적을 무한히 휘어 수비를 우회할 수 없는가')
{
  const sag = (a, b, c) => {
    const h = handleFromCtrl(a, c, b)
    const m = midpoint(a, b)
    return Math.hypot(h.x - m.x, h.y - m.y)
  }
  // 곡률 핸들(곡선 중점)을 hx,hy로 끌었을 때의 제어점
  const ctrlAt = (a, b, hx, hy) => ({ x: 2 * hx - (a.x + b.x) / 2, y: 2 * hy - (a.y + b.y) / 2 })

  const a = { x: 40, y: 40 }
  const b = { x: 60, y: 40 } // 20m
  const wild = ctrlAt(a, b, 50, 28) // 12m 휘게 끌기
  for (const kind of ['pass', 'shot', 'dribble']) {
    const got = sag(a, b, clampCtrl(a, b, wild, kind))
    check(`20m ${kind} 최대 휨`, got, maxBend(20, kind), 0.02)
  }
  checkDir('휨 방향은 유지된다 (끈 쪽으로 휜다)', handleFromCtrl(a, clampCtrl(a, b, wild, 'pass'), b).y < 40)
  checkDir('ctrl 없으면 직선(중점)', Math.abs(clampCtrl(a, b, null).y - 40) < 1e-9)
  checkDir(
    `가까우면 적게, 멀수록 크게 (6m→${maxBend(6, 'pass').toFixed(1)}m · 20m→${maxBend(20, 'pass').toFixed(1)}m · 45m→${maxBend(45, 'pass').toFixed(1)}m)`,
    maxBend(6, 'pass') < maxBend(20, 'pass') && maxBend(20, 'pass') < maxBend(45, 'pass'),
  )
  checkDir('절대 상한이 없어 롱패스도 계속 커진다', maxBend(80, 'pass') > maxBend(45, 'pass'))
  checkDir('최대로 휘어도 반원(50%)까지는 안 간다', maxBend(30, 'pass') < 0.5 * 30)

  // 공의 조절점은 가운데 고정 — 좌우(휨)로만 움직이고 앞뒤로는 못 끈다 (사용자 요청 2026-07-27)
  for (const kind of ['pass', 'shot']) {
    const fwd = ctrlAt(a, b, 58, 36) // 앞으로 8m + 옆으로 4m 끌기
    const h = handleFromCtrl(a, clampCtrl(a, b, fwd, kind), b)
    checkDir(`${kind} 조절점은 앞뒤로 안 밀린다 (x ${h.x.toFixed(2)} = 중점 50)`, Math.abs(h.x - 50) < 1e-6)
    checkDir(`${kind} 좌우(휨)는 그대로 먹는다 (y ${h.y.toFixed(2)})`, Math.abs(h.y - 36) < 1e-6)
  }
  {
    // 드리블·런은 사람이 달리는 경로라 앞뒤 치우침을 조금 허용한다
    const h = handleFromCtrl(a, clampCtrl(a, b, ctrlAt(a, b, 58, 36), 'dribble'), b)
    checkDir(`드리블은 앞뒤 치우침 허용 (x ${h.x.toFixed(2)} ≠ 50)`, h.x > 50)
  }

  // 핵심 회귀: 예전엔 슛이 휘어도 거리 감쇠가 직선 D 그대로여서, 크게 휘어
  // 블로커만 피하면 "수비 없는 직선 슛"과 같은 xG가 나왔다.
  const from = { x: 100, y: 40 }
  const to = { x: 119, y: 40 }
  const def = defAt(109.5, 40) // 슛길 한가운데
  const shotAt = (ctrl) => ({ type: 'shot', from, to, ctrl, actor: neutral() })
  const xg = (ctrl, opp) => sigmoid(calcShot(shotAt(ctrl), opp).z)
  const open = xg(midpoint(from, to), [])
  const blocked = xg(midpoint(from, to), [def])
  const bent = xg(clampCtrl(from, to, ctrlAt(from, to, 109.5, 30), 'shot'), [def])
  checkDir(`막힌 직선 슛 ${(blocked * 100).toFixed(1)}% < 열린 직선 슛 ${(open * 100).toFixed(1)}%`, blocked < open)
  checkDir(
    `휘어서 우회해도 열린 슛만큼은 안 된다 (${(bent * 100).toFixed(1)}% < ${(open * 100).toFixed(1)}%)`,
    bent < open,
  )
  checkDir(`그래도 우회는 이득이다 (${(bent * 100).toFixed(1)}% > 막힘 ${(blocked * 100).toFixed(1)}%)`, bent > blocked)
  // 휜 만큼 비행 거리가 늘어 xG가 깎인다 (같은 궤적, 수비 없음)
  const bentOpen = xg(clampCtrl(from, to, ctrlAt(from, to, 109.5, 30), 'shot'), [])
  checkDir(`휘어 차면 거리값을 문다 (${(bentOpen * 100).toFixed(1)}% < 직선 ${(open * 100).toFixed(1)}%)`, bentOpen < open)
}

// ── 2c. 스루패스 도착점 — "공과 사람이 같이 도착" ────────────────────
console.log('\n[스루패스] 도착점이 리시버 가동범위 안에 들어오는가')
{
  const runnerFrom = { x: 53, y: 46 }
  const ballFrom = { x: 48, y: 34 }
  const player = neutral({ pace: 15, acceleration: 15 })
  const speed = runSpeedOf(player)
  // 공이 도착하는 시간 안에 리시버가 그 지점까지 갈 수 있어야 한다
  const feasible = (p, passKind = 'through') => {
    const runT = Math.hypot(p.x - runnerFrom.x, p.y - runnerFrom.y) / speed
    const ballT = throughBallDuration({ runnerFrom, ballFrom, to: p, player, passKind })
    return runT <= ballT + 1e-6
  }
  // 너무 먼 지점(47m)을 찍으면 성립하는 데까지 당겨야 한다 — 예전엔 그대로 통과해
  // 리시버가 자기 동심원 밖에 놓였고, 유저가 손으로 다시 옮겨야 했다 (회귀 방지)
  const want = { x: 100, y: 52 }
  checkDir(`찍은 지점(47.4m)은 원래 성립 불가`, !feasible(want))
  const got = throughTarget({ runnerFrom, ballFrom, want, player })
  const d = Math.hypot(got.x - runnerFrom.x, got.y - runnerFrom.y)
  checkDir(`당겨진 도착점 ${d.toFixed(1)}m → 성립`, feasible(got))
  const ground = throughTarget({ runnerFrom, ballFrom, want, player, passKind: 'ground' })
  const dGround = Math.hypot(ground.x - runnerFrom.x, ground.y - runnerFrom.y)
  const nearMin = throughSpeedLimits(5, 'through').min
  const farMin = throughSpeedLimits(50, 'through').min
  checkDir(`far through ball minimum keeps more force (${farMin.toFixed(1)} > ${nearMin.toFixed(1)} m/s)`, farMin > nearMin)
  checkDir(`느린 스루패스가 일반 패스보다 더 넓은 침투 공간을 허용 (${d.toFixed(1)}m > ${dGround.toFixed(1)}m)`, d > dGround)
  checkDir('원래 찍은 방향 위에 있다', Math.abs((got.x - runnerFrom.x) * (want.y - runnerFrom.y) - (got.y - runnerFrom.y) * (want.x - runnerFrom.x)) < 1e-6)
  // 가까운 지점은 손대지 않는다
  const near = { x: 56.5, y: 46 }
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

console.log('[수비 복귀] 코너 종료 뒤에는 자기 진영으로, 코너 중에는 대형 유지')
{
  const advanced = initDefense([{ ...defAt(12, 40), id: 'advanced_df', position: 'DF' }])
  const counter = advanceDefense(advanced, {
    from: { x: 59, y: 23 },
    to: { x: 95, y: 26 },
    durSec: 5.5,
    attackers: [],
  })
  const corner = advanceDefense(advanced, {
    from: { x: 112, y: 3 },
    to: { x: 108, y: 36 },
    durSec: 5.5,
    attackers: [],
  })
  const counterMove = counter[0].x - advanced[0].x
  const cornerMove = Math.hypot(corner[0].x - advanced[0].x, corner[0].y - advanced[0].y)
  checkDir(`역습 시작 시 전진한 DF가 자기 진영 쪽으로 복귀 (${counterMove.toFixed(1)}m)`, counterMove > 18)
  checkDir(`코너킥 진행 중에는 과도하게 이동하지 않음 (${cornerMove.toFixed(1)}m)`, cornerMove <= K.DEF.MOVE_CAP * K.DEF.SET_PIECE_MOVE_SCALE + 0.01)
}

// ── 3b. 오프사이드 (순수 기하) ───────────────────────────────────────
console.log('\n[오프사이드] 최후방 2번째 수비수 라인 판정')
{
  // 백4(x=90,92,94,96) + GK(116.5). 내림차순 116.5, 96, 94, 92, 90 → 라인 = 96
  const line4 = [defAt(90, 30), defAt(92, 38), defAt(94, 46), defAt(96, 54), { ...defAt(116.5, 40), position: 'GK' }]
  check('라인 = 최후방 2번째 (GK 포함 정렬)', offsideLineX(line4), 96 - K.OFFSIDE.PLAYER_RADIUS, 0.001)

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

  const movedBackAtKick = {
    ...mkPass(104),
    receiverFrom: { x: 95.9, y: 40 },
  }
  const movedBack = resolveSequence([movedBackAtKick], { opponents: defs, players: standingOff, seed: 1 })
  checkDir('runner returned behind line at kick is onside', movedBack.steps[0].offside === false)
  checkDir('plan warning uses the runner position at kick', planOffside([movedBackAtKick], { opponents: defs, players: standingOff }).length === 0)

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
    // 퇴장이 있었으면 그 팀은 11명이 아니다 (2026 결승: 엔소 페르난데스 퇴장으로
    // 아르헨티나가 연장을 10명으로 치렀다). moment.sentOff에 적힌 만큼만 깎아준다 —
    // 그냥 "11명 이하"로 풀면 좌표를 빠뜨린 진짜 실수를 못 잡는다.
    const sentOff = moment.sentOff ?? []
    const expected = (team) => 11 - sentOff.filter((id) => byId[id]?.team === team).length
    const note = sentOff.length ? ` · 퇴장 ${sentOff.length}명` : ''
    checkDir(
      `${scn.match_id}: ${scn.home} ${home.length}명 vs ${scn.away} ${away.length}명 (기대 ${expected(scn.home)}/${expected(scn.away)}${note})`,
      home.length === expected(scn.home) && away.length === expected(scn.away),
    )
    // sentOff에 적은 선수가 실수로 온필드에 남아 있으면 안 된다
    const stillOn = sentOff.filter((id) => ids.includes(id))
    if (sentOff.length) checkDir(`${scn.match_id}: 퇴장 선수가 온필드에 없음`, stillOn.length === 0, stillOn.join(', '))
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
    { type: 'pass', receiverId: 'kor_11', to: null, ctrl: { x: 90.5, y: 30.2 }, passKind: 'lob' }, // 곡선 로빙패스
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
  checkDir('로빙패스 종류 왕복', back.chainActs[1].passKind === 'lob')
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


// ── 재현(이스터에그) 판정 ────────────────────────────────────────────
console.log('\n[재현 판정] 순서 + 타원 구역 (engine/replay.js)')
{
  const egg = { sequence: ['a', 'b'], shot: { x: 106, y: 44, rx: 18, ry: 8 } }
  const leg = (type, actorId, from) => ({ type, actorId, from })
  const chainOf = (shotFrom) => [leg('dribble', 'a', { x: 60, y: 40 }), leg('pass', 'a', { x: 80, y: 40 }), leg('shot', 'b', shotFrom)]
  const hit = (from, outcome = 'GOAL') => isReplayMatch({ egg, chain: chainOf(from), outcome })

  checkDir('정확한 순서 + 중심에서 슛 → 성공', hit({ x: 106, y: 44 }))
  checkDir('골이 아니면 실패', !hit({ x: 106, y: 44 }, 'MISS'))
  checkDir('같은 선수 연속 액션은 한 번으로', touchOrder(chainOf({ x: 106, y: 44 })).join() === 'a,b')
  checkDir('순서가 다르면 실패',
    !isReplayMatch({ egg, chain: [leg('dribble', 'b', { x: 60, y: 40 }), leg('shot', 'a', { x: 106, y: 44 })], outcome: 'GOAL' }))
  checkDir('거쳐간 선수가 하나 더 많으면 실패',
    !isReplayMatch({ egg, chain: [leg('dribble', 'a', { x: 60, y: 40 }), leg('pass', 'c', { x: 80, y: 40 }), leg('shot', 'b', { x: 106, y: 44 })], outcome: 'GOAL' }))

  // 타원으로 바꾼 이유 — 원이었다면 통과했을 지점이 좌우로는 걸러져야 한다
  checkDir('거리축 17m 뒤 → 성공 (중거리는 거리가 자유)', hit({ x: 89, y: 44 }))
  checkDir('좌우 11m 옆 → 실패 (반경 18 원이었다면 통과했다)', !hit({ x: 106, y: 55 }))
  checkDir('거리축 19m 뒤 → 실패', !hit({ x: 87, y: 44 }))
  checkDir('좌우 7.5m 옆 → 성공', hit({ x: 106, y: 51.5 }))
  checkDir('타원 경계 위 → 성공', inShotZone({ x: 124, y: 44 }, egg.shot))
  checkDir('두 축이 섞인 대각선은 원보다 좁다', !inShotZone({ x: 93, y: 50 }, egg.shot))

  // 구 데이터 폴백
  checkDir('tol만 있으면 원 (rx=ry=tol)', eggRadii({ tol: 9 }).rx === 9 && eggRadii({ tol: 9 }).ry === 9)
  checkDir('구역 데이터가 없으면 순서만으로 인정',
    isReplayMatch({ egg: { sequence: ['a', 'b'] }, chain: chainOf({ x: 5, y: 5 }), outcome: 'GOAL' }))
}

console.log('[재현 판정] 실제 데이터 — egg-shots.json이 원본인가')
{
  const load = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf-8'))
  const scns = [load('../src/data/scenarios.json'), load('../src/data/kor_ita_2002.json'), ...load('../src/data/scenes-2026.json').matches]
  const store = load('../src/data/egg-shots.json').shots
  for (const scn of scns) {
    const shot = scn.moments[0].easterEgg?.shot
    if (!shot) continue
    const src = store[scn.match_id]
    checkDir(`${scn.match_id}: rx·ry 보유, 좌우축 ≤ 거리축`,
      Number.isFinite(shot.rx) && Number.isFinite(shot.ry) && shot.ry <= shot.rx)
    checkDir(`${scn.match_id}: 원본(egg-shots.json)과 일치`,
      !!src && src.x === shot.x && src.y === shot.y && src.rx === shot.rx && src.ry === shot.ry)
  }
}

console.log('[재현 판정] 실제 데이터 — sequence가 재현 가능한 순서인가')
// sequence는 손으로 적는 값이다 (생성기의 자동 계산은 ball·passer·scorer 셋뿐이라
// 3명이 한계라, 경유자가 있는 장면은 장면 정의에 직접 적는다). 오타가 나도 빌드와
// 린트는 통과하고, 그 이스터에그만 조용히 재현 불가능해진다 — 그걸 여기서 잡는다.
// 규칙은 전부 isReplayMatch/touchOrder가 실제로 요구하는 것들이다.
{
  const load = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf-8'))
  const players = load('../src/data/players.json')
  const byId = Object.fromEntries(players.map((p) => [p.id, p]))
  const scns = [load('../src/data/scenarios.json'), load('../src/data/kor_ita_2002.json'), ...load('../src/data/scenes-2026.json').matches]

  for (const scn of scns) {
    const moment = scn.moments[0]
    const seq = moment.easterEgg?.sequence
    // sequence가 없는 장면은 구 방식(passer/scorer) 폴백이라 검사 대상이 아니다.
    if (!seq) continue
    const { passerId, scorerId } = moment.easterEgg
    const id = `${scn.match_id}`

    // chain의 첫 액터는 공을 가진 선수다. 여기가 어긋나면 무슨 수를 써도 매칭되지 않는다.
    checkDir(`${id}: sequence가 공 소유자(${moment.ball})로 시작`, seq[0] === moment.ball, seq[0] === moment.ball ? '' : seq[0])
    // touchOrder가 같은 선수의 연속 액션을 하나로 접으므로, 연속 중복은 길이가 영영 안 맞는다.
    const dup = seq.findIndex((p, i) => i > 0 && p === seq[i - 1])
    checkDir(`${id}: 연속 중복 없음`, dup === -1, dup === -1 ? '' : `${dup}번째 ${seq[dup]}`)
    checkDir(`${id}: 마지막이 득점자(${scorerId})`, seq.at(-1) === scorerId, seq.at(-1) === scorerId ? '' : seq.at(-1))
    checkDir(`${id}: 패서(${passerId})가 순서에 포함`, seq.includes(passerId))
    // 유령 id는 판정을 막을 뿐 아니라 화면의 "재현 순서" 힌트에도 그대로 노출된다.
    const ghost = seq.filter((p) => !byId[p] || moment.positions?.[p] == null)
    checkDir(`${id}: ${seq.length}명 전원 온필드 실존`, ghost.length === 0, ghost.join(', '))
  }
}

console.log(fails === 0 ? '\n모든 검증 통과 ✅' : `\n${fails}건 실패 ❌`)
process.exit(fails === 0 ? 0 : 1)
