// engine/resolve.js — 확률 판정 엔진 (CALC_SPEC v2.1, 로그오즈 가법 + 로지스틱).
// 산식확정 보고서 v2(2026-07-18) + 데이터담당 요청사항(16스탯 1~20 스케일)을 구현한다. 계수는 constants.js 한 파일에.
//
// 구조: 모든 항(거리·각도·스킬·수비압박)을 로그오즈 z에 더하고 마지막에 σ(z) 1회,
// 전역 clamp(0.02, 0.97). 수비는 오라 이진판정 대신 연속 소프트 프레셔 e^(−d/R).
//
// v2 → v2.1 (데이터담당 요청사항 반영):
//   슛(발)   — S_eff = 골결(finishing). 중거리(longshots)가 거리 감쇠를 완화.
//   슛(헤더) — 크로스 수신 직후의 슛은 헤더: 골결:헤더 = 3:7 + 공중 듀얼(점프+키+몸싸움).
//   크로스   — 측면→박스 장거리 패스는 패스 대신 크로스 스탯 + 예측력 보정.
//   드리블   — 공격 개인기+드리블(+예측력) vs 수비 일대일마크+태클, 몸싸움+균형 듀얼 상시.
//   수비압박 — β를 수비수별로 스케일: 패스 차단 = 수비위치선정, 드리블 = 마크+태클,
//              슛 블록 = 일대일마크. 예측력은 전 상황 50% 혼합(상시 보정, 데이터 요청 §7).
//   수비이동 — 액션마다 defense.js가 수비 좌표를 갱신 → 다음 액션은 새 좌표로 판정.
//              SEQ.FLOW는 0.25→0.1 축소 (붕괴는 위치 재계산에서 창발, 잔여 기세만 상수).
//
//   resolveSequence(actions, ctx) → { pTotal, outcome, steps, reason, seed }
//
//   actions[k]: { type: 'dribble'|'pass'|'shot', actor, actorId, receiverId?, from, to, ctrl }
//   ctx: { opponents: [{id, x, y, stats, ...}], players?: [{id, x, y}], seed: number }
//
//   steps[k]: { type, p, success, header?, cross?, offside?, offsideLineX?, defPos,
//               interceptorId?, interceptPoint?, interceptFrac? }
//     defPos — 이 액션이 끝난 시점의 수비수 좌표 {id: {x, y}} (연출·다음 판정 공유)
//     실패 스텝에는 누가(interceptorId), 어디서(interceptPoint, interceptFrac) 끊었는지가 담긴다.
//     offside — 이 패스가 오프사이드였는지 (확률과 무관한 확정 실패, offside.js)
//     첫 실패 이후의 스텝은 success: null (미실행, p만 계산됨).
//   outcome: 'GOAL' | 'ADVANCE'(슛 없이 전개 성공) | 'INTERCEPTED' | 'MISS' | 'OFFSIDE'
//
// 보류 항: PK 특례 0.76 (PK 상황 미도입) · 컨디션/체력 스케일

import { samplePath, pathLength, minDistToPath, bendCostFactor } from './geometry.js'
import { initDefense, advanceDefense } from './defense.js'
// 차단 지점 도달 가능성 판정에 쓴다 (reachableHit). sheets → defense/geometry/constants 뿐이라 순환 아님.
import { runSpeedOf } from './sheets.js'
import { checkOffside, offsideWarnings } from './offside.js'
import { K, actionSpeed, isLobPass } from './constants.js'

// 시드 PRNG (mulberry32) — 같은 시드 + 같은 전술 = 항상 같은 결과 (공유 링크 재현)
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// UI 표시용 수비 반경 — 궤적 입력 중 오라. 판정은 액션별 R(2.0/3.0/4.0)의 연속 감쇠를
// 쓰므로 "경계"는 없지만, 가장 넓은 리시버 압박 반경을 시각 안내로 보여준다.
export const DEF_RADIUS = K.PASS.R_RECV

// 어댑터: 1~20 스탯 → [0.335, 1.0] (부록 A — v/20 채택)
const norm = (v) => K.STAT_FLOOR + (1 - K.STAT_FLOOR) * (v / K.STAT.FM_MAX)
// 키(cm) → [0.3, 1.0] (165~200cm 구간)
const normH = (h) => K.STAT_FLOOR + (1 - K.STAT_FLOOR) * Math.min(1, Math.max(0, (h - K.STAT.H_MIN) / K.STAT.H_RANGE))

const sigmoid = (z) => 1 / (1 + Math.exp(-z))
const clampP = (p) => Math.min(K.P_MAX, Math.max(K.P_MIN, p))

// 경합 게이트 (v2.2) — 압박이 0이면 실패도 0. gate(0)=0, press↑ → gate→1.
// **드리블 전용**이다 (constants.js CONTEST 주석 참고).
export const contestGate = (press) => 1 - Math.exp(-Math.max(0, press) / K.CONTEST.KAPPA)

// calc*()의 결과를 최종 성공 확률로.
//   press가 주어지면(드리블): p = 1 − (1 − clamp(σ(z))) · gate(press)
//     → 무압박이면 1.0(확정 성공), 압박이 붙을수록 기존 로지스틱 값으로 수렴.
//     clamp는 "경합 상태의 확률"에만 걸린다 — 무압박 확정 성공이 P_MAX(0.97)에 깎이면
//     "수비수 없으면 실패 없어야 한다"는 요구를 만족하지 못하기 때문.
//   press가 없으면(패스·슛): 기존 그대로 clamp(σ(z)).
export function probOf({ z, press = null }) {
  const raw = clampP(sigmoid(z))
  return press == null ? raw : 1 - (1 - raw) * contestGate(press)
}

// 소프트 프레셔 — 모든 액션이 공용하는 연속 감쇠. 로그오즈에 β(<0)·pressure로 가산.
const pressure = (d, R) => Math.exp(-d / R)

// 수비 스탯 스케일 — 압박 β를 수비수 개인의 능력으로 조절 (보고서 §4.4 보류분 해제).
// primary(상황별 주 스탯)와 예측력을 반반 섞는다: "예측력은 상시 보정값" (데이터 요청 §7).
// 중심 MID(0.7)에서 1.0 — 검증 앵커는 중립 스탯 기준 그대로 유지된다.
const defScale = (o, primaryVal) => {
  const mix = 0.5 * norm(primaryVal) + 0.5 * norm(o.stats.anticipation)
  const f = 1 + K.STAT.DEF_GAIN * (mix - K.STAT.MID)
  return Math.min(K.STAT.DEF_MAX, Math.max(K.STAT.DEF_MIN, f))
}
const DEF_PRIMARY = {
  pass: (o) => o.stats.positioning, // 수비위치선정 = 패스 끊을 확률 (데이터 요청 §6)
  dribble: (o) => (o.stats.marking + o.stats.tackle) / 2, // 일대일마크·태클 (데이터 요청 §1)
  shot: (o) => o.stats.marking, // 슛 블록은 대인 마크
}

// 차단 연출 귀속 기준: 이보다 압박이 약한 수비수는 "끊은 사람"으로 지목하지 않는다
const ATTRIBUTION_MIN = 0.15

// 수비수들의 경로 압박 로그오즈 합 + 가장 위협적인 수비수(연출용) 추적.
// sum 옵션이 꺼지면(드리블) 최근접 1명만 반영 — 1v1 대면 간격 모델.
// betaScale: 수비수별 β 스케일 (defScale) — 없으면 전원 1.
function pathPressure(pts, opponents, beta, R, { sum = true, excludeGK = false, excludeId = null, betaScale = null } = {}) {
  let z = 0
  let worst = null
  const all = [] // 압박 큰 순 — 드리블 포위처럼 "2번째 이후"가 필요한 곳에서 쓴다
  for (const o of opponents) {
    if (excludeGK && o.position === 'GK') continue
    if (o.id === excludeId) continue
    const { d, point, frac } = minDistToPath(pts, o)
    const pr = pressure(d, R)
    all.push({ d, pr, id: o.id, point, frac, o })
    if (sum) z += beta * (betaScale ? betaScale(o) : 1) * pr
    if (!worst || pr > worst.pr) worst = { pr, id: o.id, point, frac, o }
  }
  all.sort((a, b) => b.pr - a.pr)
  if (!sum && worst) z = beta * (betaScale ? betaScale(worst.o) : 1) * worst.pr
  if (worst && worst.pr < ATTRIBUTION_MIN) worst = null
  return { z, worst, all }
}

// 차단 지점 — "경로에서 가장 가까운 점"이 아니라 **그가 실제로 닿을 수 있는 가장 이른 점**.
//
// 시간을 안 보면, 옆에 서 있던 수비수가 공이 0.25초 만에 지나가는 자리로 순간이동해
// 끊는 그림이 된다. 2002 이영표 패스에서 디리비오가 그랬다 — 그 지점에 가려면 10.9 m/s가
// 필요한데 그의 주력은 6.6이고, 실은 그 경로 어디에도 시간 안에 닿지 못하는데도
// 끊긴 211건 전부가 그의 몫이었다(경로에서 가장 가까운 사람이었기 때문).
//
// 어디에도 못 닿으면 null을 돌려준다 → 차단자를 지목하지 않고 "빠진 패스" 연출로 넘어간다.
// 못 막을 사람이 막은 걸로 그리느니 아무도 못 건드린 게 낫다 — 수비 붕괴가 좌표에서
// 창발해야지 연출이 메워주면 안 된다(사용자 확정 2026-07-31).
//
// **확률은 건드리지 않는다.** 주사위는 이미 굴렸고 여기서 정하는 건 연출 좌표뿐이다.
function reachableHit(action, defender) {
  if (!defender) return null
  const pts = samplePath(action.from, action.ctrl, action.to)
  const total = pathLength(pts) || 1
  const ballV = actionSpeed(action)
  const defV = runSpeedOf(defender)
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    const tDef = Math.hypot(defender.x - pts[i].x, defender.y - pts[i].y) / defV
    if (tDef <= acc / ballV) return { point: pts[i], frac: acc / total }
  }
  return null
}

// 크로스 기하 판정: 측면에서 MIN_L 이상 날아와 박스 안에 떨어지는 패스 (데이터 요청 §2·3·7)
function isCrossGeometry(action) {
  const C = K.CROSS
  const L = Math.hypot(action.to.x - action.from.x, action.to.y - action.from.y)
  return (
    L >= C.MIN_L &&
    Math.abs(action.from.y - 40) >= C.WIDE_Y &&
    action.to.x >= C.BOX_X &&
    action.to.y >= C.BOX_Y0 &&
    action.to.y <= C.BOX_Y1
  )
}

// 공중 듀얼 능력: 점프 50% + 키 30% + 몸싸움 20% ("점프+키", 몸싸움 상시 — 데이터 요청 §2·5)
const airOf = (p) => 0.5 * norm(p.stats.jumping) + 0.3 * normH(p.heightCm) + 0.2 * norm(p.stats.strength)
// 몸싸움 듀얼 능력: 몸싸움+균형감각 반반 (데이터 요청 §5)
const bodyOf = (p) => 0.5 * norm(p.stats.strength) + 0.5 * norm(p.stats.balance)

// --- 슈팅: 로지스틱 xG ------------------------------------------------------
// z = B0 + B_DIST·lsFactor·(D + bend) + B_ANG·θ + B_SKILL·(S_eff − SEFF0) + Σ B_BLOCK·defScale·e^(−d/R_BLOCK)
//   bend = 호 길이 − 현 길이 (휘어 찬 만큼 실제 비행 거리가 늘어난다. 직선 슛이면 0)
// GK 제외 = 이중계상 방지 (로지스틱 xG는 이미 "평균 키퍼 모집단"에서 캘리브레이션된 값)
// prev(직전 액션)가 크로스면 헤더 슛: 골결:헤더 = 3:7 + 공중 듀얼 (데이터 요청 §2·3)
export function calcShot(action, opponents, prev = null) {
  const C = K.SHOT
  const st = action.actor.stats
  const from = action.from
  const cross = !!(prev && prev.type === 'pass' && isCrossGeometry(prev))
  // 로빙을 받은 뒤 바로 패스·슛하면 공이 아직 떠 있어 헤더 동작으로 판정한다.
  // 크로스보다 헤딩 비중과 공중 경합 보정을 낮춰, 짧은 로빙 연계가 지나치게 불리하지 않다.
  const lobHeader = !!(prev && isLobPass(prev))
  const header = cross || lobHeader
  const headWeight = cross ? 1 - C.HEAD_FIN : C.LOB_HEAD_WEIGHT

  // 발: 골결 단독 (데이터 요청 §4 "발로 찰 땐 골결"). 헤더: 골결 3 : 헤더 7.
  const sEff = header
    ? (1 - headWeight) * norm(st.finishing) + headWeight * norm(st.heading)
    : norm(st.finishing)

  const D = Math.hypot(K.GOAL.x - from.x, K.GOAL.y - from.y)
  // 중거리 스탯: 거리 감쇠 완화 — "거리값에서 빠지는 값 적어지게" (데이터 요청 §8). 헤더는 근거리라 미적용.
  const lsFactor = header
    ? 1
    : Math.min(C.LS_MAX, Math.max(C.LS_MIN, 1 - C.LS_RELIEF * (norm(st.longshots) - K.STAT.MID)))

  // 각도 개방도: 양 포스트 사잇각 (라디안)
  const a1 = Math.atan2(K.GOAL.postA - from.y, K.GOAL.x - from.x)
  const a2 = Math.atan2(K.GOAL.postB - from.y, K.GOAL.x - from.x)
  let theta = Math.abs(a1 - a2)
  if (theta > Math.PI) theta = 2 * Math.PI - theta

  const pts = samplePath(from, action.ctrl, action.to)
  // 휘어 찬 슛은 공이 실제로 더 멀리 난다. 거리 감쇠를 직선 D로만 매기면
  // "크게 휘려 그려서 블로커만 피하고 xG는 직선 슛 그대로"가 성립해버린다.
  // 호 길이가 현보다 길어진 만큼을 거리에 더해 그 공짜를 없앤다.
  // (곡률 자체는 geometry.clampCtrl이 이미 상한을 씌운 상태 — 여기선 남은 휨의 값을 매긴다)
  const bendExtra =
    Math.max(0, pathLength(pts) - Math.hypot(action.to.x - from.x, action.to.y - from.y)) *
    bendCostFactor(action.actor)
  const block = pathPressure(pts, opponents, C.B_BLOCK, C.R_BLOCK, {
    excludeGK: true,
    betaScale: (o) => defScale(o, DEF_PRIMARY.shot(o)),
  })
  let z = C.B0 + C.B_DIST * lsFactor * (D + bendExtra) + C.B_ANG * theta + C.B_SKILL * (sEff - C.SEFF0) + block.z

  // 조준 — 골문 안 어디를 노렸는가. 0 = 정중앙, 1 = 포스트 바로 옆.
  // 구석은 키퍼가 못 닿지만 빗나가기도 쉽다. 그 차이를 마무리 스탯이 가른다 —
  // 중립 스탯에서는 정확히 0이라 "구석 조준 = 공짜 보너스"가 되지 않는다 (K.SHOT.AIM_GAIN 참고).
  // 조준은 게임에서 실제로 쥐어 준 조작(슛 재조준)인데 확률에는 아무 영향이 없었다.
  const halfGoal = Math.abs(K.GOAL.postA - K.GOAL.postB) / 2
  const aim = action.to ? Math.min(1, Math.abs(action.to.y - K.GOAL.y) / halfGoal) : 0
  z += C.AIM_GAIN * (header ? C.AIM_HEADER : 1) * aim * (sEff - C.SEFF0)

  // 일반 xG는 평균 골키퍼를 이미 포함한다. 다만 슈터와 GK만 남은 1대1은
  // 공간·각도 우위가 크므로 별도 보너스를 준다. 슛길 중간에 필드 수비수가 있으면
  // 단독 찬스가 아니므로 이 보너스를 적용하지 않는다.
  const goalkeeper = opponents.find((o) => o.position === 'GK')
  const fieldBlocker = opponents.some((o) => {
    if (o.position === 'GK') return false
    const hit = minDistToPath(pts, o)
    return hit.frac > 0.12 && hit.d < C.ONE_ON_ONE_BLOCK_CLEARANCE
  })
  const oneOnOne =
    !header &&
    D <= C.ONE_ON_ONE_MAX_DIST &&
    goalkeeper != null &&
    goalkeeper.x >= K.GOAL.x - C.ONE_ON_ONE_GK_GOAL_DEPTH &&
    !fieldBlocker
  if (oneOnOne) {
    // 가까울수록 BONUS 전액, MAX_DIST로 갈수록 FAR_BONUS로 선형 감쇠.
    const t = Math.min(1, Math.max(0, (D - C.ONE_ON_ONE_FULL_BONUS_DIST) / (C.ONE_ON_ONE_MAX_DIST - C.ONE_ON_ONE_FULL_BONUS_DIST)))
    z += C.ONE_ON_ONE_BONUS + (C.ONE_ON_ONE_FAR_BONUS - C.ONE_ON_ONE_BONUS) * t
    // 사용자 규칙: 막는 사람 없는 진짜 1대1은 마무리=1이어도 최소 40%. 이 바닥은
    // 이 상황에만 적용되고, 막힌 슛·일반 슛은 기존 모델 그대로다.
    z = Math.max(z, Math.log(C.ONE_ON_ONE_MIN_XG / (1 - C.ONE_ON_ONE_MIN_XG)))
  }

  // 헤더 공중 듀얼: 슛 지점 최근접 수비수와 점프+키+몸싸움 경합 (예측력 50% 혼합은 defScale 몫)
  if (header) {
    let nearest = null
    for (const o of opponents) {
      if (o.position === 'GK') continue
      const dd = Math.hypot(o.x - from.x, o.y - from.y)
      if (!nearest || dd < nearest.dd) nearest = { o, dd }
    }
    if (nearest && nearest.dd < C.R_BLOCK * 2) {
      z += (cross ? C.B_AIR : C.LOB_HEAD_AIR) * (airOf(action.actor) - airOf(nearest.o))
    }
    // 골문 코앞의 완전히 열린 헤더만 별도 바닥을 둔다. 실제 슛길에 수비
    // 블로커가 있으면 이 보정을 적용하지 않아 막힌 헤더까지 과장하지 않는다.
    if (D <= C.HEADER_CLOSE_DIST && !block.worst) {
      z = Math.max(z, Math.log(C.HEADER_CLOSE_MIN_XG / (1 - C.HEADER_CLOSE_MIN_XG)))
    }
  }
  // 선방 연출은 슈팅 경로에 실제로 걸쳐 있는 골키퍼에게만 허용한다.
  // 이 값은 xG 계산에 쓰지 않고, 이미 실패한 슛의 결과만 나누는 데 쓴다.
  const gkHit = goalkeeper ? minDistToPath(pts, goalkeeper) : null
  const save =
    goalkeeper &&
    gkHit &&
    gkHit.d <= C.SAVE_PATH_RADIUS &&
    gkHit.frac >= 0.08 &&
    gkHit.frac <= 0.98
      ? { id: goalkeeper.id, point: gkHit.point, frac: gkHit.frac }
      : null
  return { z, worst: block.worst, header, cross, oneOnOne, save }
}

// --- 패스: 로그오즈 (리시버 지배) -------------------------------------------
// z = Z0 + B_LEN·L + B_PASS·(S_pass − 0.70) + B_RECV·defScale·e^(−d_recv/R_RECV) + Σ B_LANE·defScale·e^(−d/R_LANE)
// 지배 레버는 경로가 아니라 도착점 근처 수비 기하 (리서치 합의).
// 곡선은 호 길이 L이 길어져 B_LEN으로 자연 페널티.
// 크로스 기하면 패스 스킬 대신 크로스 스탯 + 예측력 보정 ("크로스 올릴 때", 데이터 요청 §7).
export function calcPass(action, opponents, prev = null) {
  const C = K.PASS
  const st = action.actor.stats
  const pts = samplePath(action.from, action.ctrl, action.to)
  const L = pathLength(pts)
  const cross = isCrossGeometry(action)
  const header = !!(prev && isLobPass(prev))
  const sPass = header
    ? (1 - C.LOB_HEAD_WEIGHT) * norm(st.passing) + C.LOB_HEAD_WEIGHT * norm(st.heading)
    : cross
      ? norm(st.crossing) * (0.85 + 0.15 * norm(st.anticipation))
      : norm(st.passing)

  // 리시버 압박: 도착점 최근접 수비수. 이 수비수는 경로(lane) 합산에서 제외 — 이중계상 방지
  // (보고서 검증표 0.34/0.47/0.70이 리시버 항 단독 기준).
  //
  // 다만 "도착점 최근접"이 곧 "리시버 마크맨"은 아니다. 근처에 수비수가 하나뿐이면,
  // 리시버에서 한참 떨어진 채 **패스 길 한복판에 서 있는** 수비수도 최근접이 된다.
  // 그러면 레인 합산에서 빠진 데다 리시버 압박도 거의 0이라 통째로 사라졌다 —
  // 측정: 경로상 거리 0m인 수비수가 성공률을 65.5%→63.5%로 2%p밖에 못 깎았고,
  // 차단자로 지목되지도 않았다(worst=undefined). 리시버 옆에 한 명만 더 세우면
  // 같은 수비수가 레인으로 돌아와 12.8%가 됐다.
  //
  // 그래서 두 역할 중 **실제로 더 크게 작용하는 쪽으로 한 번만** 센다. 이중계상 방지라는
  // 원래 목적은 그대로고(여전히 한 번만 센다), 어느 쪽으로 셀지만 고정 대신 비교로 정한다.
  // 앵커(리시버 뒤 0.5/2/8m)는 전부 리시버 항이 더 커서 그대로 유지된다.
  let recv = null
  for (const o of opponents) {
    const dd = Math.hypot(o.x - action.to.x, o.y - action.to.y)
    if (!recv || dd < recv.d) recv = { d: dd, id: o.id, o }
  }
  const laneScale = (o) => defScale(o, DEF_PRIMARY.pass(o))
  // ── 역할 배정 (이 브랜치) ────────────────────────────────────────────────
  // 두 항 다 음수다 — 더 작은(더 음수인) 쪽이 더 크게 작용한다.
  // 비교는 B_RECV(원값) 기준으로 한다. 아래 완화(B_RECV_CLEAR)는 "마크맨으로 정해진
  // 뒤에 통로가 비어 있으면 깎아준다"는 별개 단계라, 역할을 정하는 저울에 섞지 않는다.
  const asRecv = recv ? C.B_RECV * laneScale(recv.o) * pressure(recv.d, C.R_RECV) : 0
  const asLane = recv ? C.B_LANE * laneScale(recv.o) * pressure(minDistToPath(pts, recv.o).d, C.R_LANE) : 0
  const markingRecv = !!recv && asRecv <= asLane
  const lane = pathPressure(pts, opponents, C.B_LANE, C.R_LANE, {
    excludeId: markingRecv ? recv.id : null,
    betaScale: laneScale,
  })
  // ── 통로 완화 (origin/master) ────────────────────────────────────────────
  // 도착점 주변에 상대가 있어도 공이 지나가는 중앙 통로가 비어 있으면
  // 리시버 압박 감점을 완화한다. 반대로 실제 통로에 수비수가 있으면 기존 감점과
  // 경로 감점을 모두 유지한다.
  // 역할 배정과 맞물려 정확도가 올라간다 — 레인 쪽으로 센 수비수는 이제 lane.all에
  // 남아 있으므로, 길을 막고 선 사람이 여기서 통로 차단으로 제대로 잡힌다.
  const laneBlocked = lane.all.some((e) => e.frac > 0.08 && e.frac < 0.92 && e.d <= C.CLEAR_LANE_R)
  // 레인 쪽으로 셌으면 리시버 항은 0 — 그 수비수는 이미 lane에 들어가 있다.
  const recvPr = markingRecv ? pressure(recv.d, C.R_RECV) : 0
  const recvBeta = laneBlocked ? C.B_RECV : C.B_RECV_CLEAR
  const recvZ = markingRecv ? recvBeta * laneScale(recv.o) * recvPr : 0
  const shortBonus = C.SHORT_BONUS * Math.max(0, 1 - L / C.SHORT_DIST)
  // 휘어서 늘어난 거리는 발기술로 값이 달라진다 — 잘 감는 선수는 같은 휨을 더 싸게 친다.
  // 직선이면 늘어난 거리가 0이라 계수와 무관하다(앵커는 전부 직선). K.BEND.COST_* 참고.
  const chord = Math.hypot(action.to.x - action.from.x, action.to.y - action.from.y)
  const effL = chord + Math.max(0, L - chord) * bendCostFactor(action.actor)
  const rawZ = C.Z0 + C.B_LEN * effL + C.B_PASS * (sPass - 0.7) + shortBonus + recvZ + lane.z
  const simpleShort = !cross && !header && !laneBlocked && L <= C.SHORT_DIST
  const shortFloorZ = Math.log(C.SHORT_CLEAR_FLOOR / (1 - C.SHORT_CLEAR_FLOOR))
  const z = simpleShort ? Math.max(rawZ, shortFloorZ) : rawZ
  // 연출 귀속: 경로 압박자와 리시버 마크맨 중 압박이 큰 쪽
  let worst = lane.worst
  if (recv && recvPr >= ATTRIBUTION_MIN && (!worst || recvPr > worst.pr)) {
    // o를 함께 실어 보낸다 — resolveSequence가 이 수비수의 좌표로 도달 가능성을 재기 때문
    worst = { pr: recvPr, id: recv.id, point: action.to, frac: 1, o: recv.o }
  }
  return { z, worst, cross, header, laneBlocked, simpleShort }
}

// --- 드리블: 1v1 (기하 지배) ------------------------------------------------
// z = Z0d + B_SKILL·(S_drib − 0.70) + B_LEN·L + B_DEF·defScale·e^(−d_def/R_DEF)
//     + B_BODY·e^(−d_def/R_DEF)·(body_att − body_def)
// 1v1은 예측력이 낮다(AUC≈0.69) → 능력치 가중은 의도적으로 약하게, 대면 수비 1명이 지배.
// 공격 스킬 = 개인기 45% + 드리블 45% + 예측력 10% / 수비 = 일대일마크+태클(+예측력 50%) (데이터 요청 §1·7)
// 몸싸움+균형 듀얼은 접촉 강도(근접 압박)에 비례해 상시 적용 (데이터 요청 §5)
export function calcDribble(action, opponents) {
  const C = K.DRIB
  const st = action.actor.stats
  const pts = samplePath(action.from, action.ctrl, action.to)
  const L = pathLength(pts)
  const sDrib = norm(0.45 * st.flair + 0.45 * st.dribbling + 0.1 * st.anticipation)
  const def = pathPressure(pts, opponents, C.B_DEF, C.R_DEF, {
    sum: false,
    betaScale: (o) => defScale(o, DEF_PRIMARY.dribble(o)),
  })
  // 포위 — 최근접 수비수 말고도 붙어 있는 사람들.
  //
  // def는 sum:false라 최근접 1명만 본다("1v1 대면 간격 모델"). 그래서 다섯 명이
  // 둘러싸도 한 명과 대면한 것과 확률이 똑같았다(측정: 1명 48.2% = 5명 48.2%).
  // 둘째부터 별도 항으로 더한다 — 계수를 B_DEF보다 작게 두는 이유는, 둘째 수비수는
  // 공을 뺏으러 들어오는 사람이 아니라 빠져나갈 길을 막는 사람이기 때문이다.
  //
  // 2번째부터만 세므로 **검증 앵커는 하나도 흔들리지 않는다** — 드리블 앵커가 전부 1v1이다.
  // ATTRIBUTION_MIN 아래는 빼서 "붙은 사람이 없으면 실패도 없다"는 경합 게이트 규칙을 지킨다.
  let surroundZ = 0
  for (const e of def.all.slice(1)) {
    if (e.pr < ATTRIBUTION_MIN) continue
    surroundZ += C.B_SURROUND * defScale(e.o, DEF_PRIMARY.dribble(e.o)) * e.pr
  }
  let z = C.Z0 + C.B_SKILL * (sDrib - 0.7) + C.B_LEN * L + def.z + surroundZ
  if (def.worst) z += C.B_BODY * def.worst.pr * (bodyOf(action.actor) - bodyOf(def.worst.o))
  // press = 이 드리블에 걸린 수비 압박의 크기. 0이면 뺏을 사람이 없다는 뜻이라
  // 경합 게이트가 실패 확률을 0으로 만든다 (probOf 참고).
  // 경합 게이트의 press에도 포위를 반영한다 — 둘러싸였으면 압박이 큰 게 맞다.
  //
  // **지목 문턱(ATTRIBUTION_MIN)을 여기 쓰지 않는다.** 그 값은 원래 "누가 끊었는지
  // 화면에 지목할 사람"을 고르는 기준인데, 예전에는 def.worst(= 문턱을 넘은 수비수)가
  // 없으면 press를 통째로 0으로 만들어 확률까지 좌우했다. 그래서 수비수가 경로에서
  // 5m면 82.5%, 6m면 갑자기 100%가 되는 계단이 생겼고, 41m 드리블처럼 최근접이
  // 6.4m(기여 0.119 < 0.15)인 액션은 아무도 못 뺏는 것으로 판정돼 100%가 나왔다 —
  // 화면에서는 달로트가 3.5m까지 붙는데도.
  //
  // 지목은 def.worst 그대로 두고(연출 규칙은 안 바뀐다), press만 연속으로 만든다.
  // 최근접 수비수의 기여를 문턱 없이 그대로 쓰므로 멀수록 매끄럽게 0으로 수렴한다.
  // 드리블 앵커 4개는 전부 문턱 위(간격 0.5~5m)라 값이 바뀌지 않는다.
  // 바닥값(PRESS_FLOOR)은 빼기만 하고 자르지 않는다 — 멀면 정확히 0에 닿되 계단은 없다.
  const nearest = def.all[0]
  const nearPr = nearest ? Math.max(0, nearest.pr - C.PRESS_FLOOR) : 0
  const pressRaw = nearest
    ? -(C.B_DEF * defScale(nearest.o, DEF_PRIMARY.dribble(nearest.o)) * nearPr + surroundZ)
    : 0
  return { z, worst: def.worst, press: Math.max(0, pressRaw) }
}

const LABEL = { pass: '패스', dribble: '드리블', shot: '슛' }

// 잔여 기세 보정 — k번째 액션(0부터)까지 전부 성공했다는 전제의 작은 로그오즈 보너스.
// 수비 붕괴의 주 메커니즘은 defense.js의 위치 재계산이고, 이 상수는 "흐름 탄 팀의 기세"만 남긴다.
const flowBonus = (k) => Math.min(K.SEQ.FLOW * k, K.SEQ.FLOW_MAX)

// 이 액션이 소비하는 시간(초) — 수비 이동 예산. 패스류는 비행시간 + 반응시간, 드리블은 주행시간.
function actionSeconds(action) {
  const pts = samplePath(action.from, action.ctrl, action.to)
  const L = pathLength(pts)
  const v = actionSpeed(action)
  return L / v + (action.type === 'dribble' ? 0 : K.DEF.REACT)
}

// 체인을 따라가며 액션마다 "판정 시점(before)"과 "액션 종료 시점(after)"의 수비 좌표를 만든다.
// 순수·결정론적 — 난수를 쓰지 않으므로 계획 단계(오프사이드 경고)와 실행 판정이 같은 좌표를 본다.
// 첫 실패 전까지는 실제 전개와 동일하다 (조건부 확률의 정직한 전개).
export function defenseTimeline(actions, ctx) {
  // 공격수 현재 좌표 추적 (수비 마킹 대상) — 체인 진행에 따라 액터·리시버 위치 갱신.
  // 오프볼 런은 액션이 아니므로 근사에서 제외 (마킹은 볼 근처 기하가 지배라 영향 작음).
  const atkPos = new Map()
  for (const p of ctx.players ?? []) atkPos.set(p.id, { id: p.id, x: p.x, y: p.y })
  const moveAtk = (id, pt) => id && atkPos.set(id, { id, x: pt.x, y: pt.y })

  let defs = initDefense(ctx.opponents)
  return actions.map((a) => {
    const before = defs
    // 패스가 떠나는 순간 리시버가 서 있는 자리 — 오프사이드는 도착점이 아니라 이 좌표로 판정한다.
    // (아직 이 액션의 이동을 반영하기 전이므로 atkPos가 곧 "그 순간"의 좌표다.)
    const receiverAt = a.receiverId ? (a.receiverFrom ?? atkPos.get(a.receiverId) ?? a.to) : null
    // 액터(드리블)·리시버(패스)가 도착점으로 이동
    if (a.type === 'dribble') moveAtk(a.actorId, a.to)
    else if (a.type === 'pass') moveAtk(a.receiverId, a.to)
    // 수비 재배치: 이 액션의 시간 예산만큼 볼 도착점에 반응해 이동
    defs = advanceDefense(defs, { from: a.from, to: a.to, durSec: actionSeconds(a), attackers: [...atkPos.values()] })
    return { before, after: defs, receiverAt }
  })
}

// 계획 단계용 — 체인 전체에서 오프사이드인 패스 목록. 판정을 돌리지 않고도 경고를 띄울 수 있다.
// → [{ index, receiverId, lineX, marginM }]
export function planOffside(actions, ctx) {
  const tl = defenseTimeline(actions, ctx)
  return offsideWarnings(
    actions,
    (i) => tl[i].before,
    (i) => tl[i].receiverAt,
  )
}

export function resolveSequence(actions, ctx) {
  const rng = mulberry32(ctx.seed)
  const timeline = defenseTimeline(actions, ctx)

  // 1) 각 액션의 확률 계산 — 액션마다 수비 좌표를 전진시키며 판정.
  const calcs = actions.map((a, k) => {
    const prev = k > 0 ? actions[k - 1] : null
    const defs = timeline[k].before
    const c =
      a.type === 'shot'
        ? calcShot(a, defs, prev)
        : a.type === 'pass'
          ? calcPass(a, defs, prev)
          : calcDribble(a, defs)
    // 오프사이드는 확률이 아니라 규칙 — 패스가 떠나는 순간의 좌표로 즉시 판정한다.
    // 리시버가 "그 순간 서 있던 자리"가 기준: 뒤에서 출발해 공을 향해 달려드는 침투 패스는
    // 도착점이 라인 뒤여도 온사이드다 (실축 규칙 = 역습 스루패스가 성립하는 이유).
    const off =
      a.type === 'pass'
        ? checkOffside({ receiver: timeline[k].receiverAt ?? a.to, opponents: defs, ball: a.from })
        : { offside: false }
    const defPos = Object.fromEntries(timeline[k].after.map((d) => [d.id, { x: d.x, y: d.y }]))
    // press는 드리블만 실어 온다 → 패스·슛은 기존 산식 그대로 (probOf 참고)
    return {
      p: probOf({ z: c.z + flowBonus(k), press: c.press ?? null }),
      worst: c.worst,
      save: c.save,
      header: c.header,
      cross: c.cross,
      offside: off.offside,
      offsideLineX: off.lineX,
      defPos,
    }
  })
  // 계획 전체 성공 확률 (첫 실패 없이 끝까지 갔을 때의 ∏) — 패널 표시용.
  // 오프사이드가 하나라도 끼면 그 계획은 확률과 무관하게 성립하지 않으므로 0.
  const pTotal = calcs.some((c) => c.offside) ? 0 : calcs.reduce((m, c) => m * c.p, 1)

  // 2) 순서대로 굴려서 첫 실패 지점 결정 (첫 실패에서 중단 = 정직한 생존확률)
  const steps = []
  let failIndex = -1
  let offsideIndex = -1
  for (let i = 0; i < actions.length; i++) {
    const { p, worst, save, header, cross, offside, offsideLineX, defPos } = calcs[i]
    const step = { type: actions[i].type, p, success: null, header, cross, offside, offsideLineX, defPos }
    if (failIndex === -1) {
      // 오프사이드는 주사위를 굴리기 전에 확정 실패 — 휘슬이 먼저 울린다.
      if (offside) {
        step.success = false
        failIndex = i
        offsideIndex = i
      } else {
        step.success = rng() < p
        if (!step.success) {
          failIndex = i
          // 슛의 기본 실패 확률은 바꾸지 않는다. 원래 빗나갈 슛(필드 수비 블록이
          // 없는 실패)만, 골키퍼가 실제 슛선에 있을 때 50:50으로 선방/빗나감 처리한다.
          if (actions[i].type === 'shot' && !worst && save && rng() < K.SHOT.SAVE_OF_MISS) {
            step.savedById = save.id
            step.interceptorId = save.id
            step.interceptPoint = save.point
            step.interceptFrac = save.frac
          // 압박 기여가 가장 큰 필드 수비수가 끊은 것으로 (연출 좌표).
          // 단, 시간 안에 그 경로에 닿을 수 있어야 한다 — 못 닿으면 지목하지 않고
          // 아무도 못 건드린 패스로 둔다 (reachableHit 주석 참고).
          } else if (worst) {
            const hit = reachableHit(actions[i], worst.o)
            if (hit) {
              step.interceptorId = worst.id
              step.interceptPoint = hit.point
              step.interceptFrac = hit.frac
            }
          }
        }
      }
    }
    steps.push(step)
  }

  // 3) 결과 요약
  let outcome
  let reason
  if (failIndex === -1) {
    const last = actions[actions.length - 1]
    outcome = last.type === 'shot' ? 'GOAL' : 'ADVANCE'
    const headed = steps[steps.length - 1].header
    reason =
      outcome === 'GOAL'
        ? `${last.actor.name}의 ${headed ? '헤더가' : '슛이'} 골망을 흔듭니다! (시퀀스 ${actions.length}개 액션 전부 성공)`
        : `${actions.length}개 액션 전부 성공 — 공을 지키며 전개했습니다.`
  } else if (offsideIndex !== -1) {
    const act = actions[offsideIndex]
    const who = ctx.players?.find((p) => p.id === act.receiverId)
    outcome = 'OFFSIDE'
    reason = `🚩 오프사이드 — ${offsideIndex + 1}번째 패스가 떠나는 순간 ${who?.name ?? '리시버'}가 최후방 2번째 수비수보다 앞서 있었습니다. (부심 깃발)`
  } else {
    const failed = steps[failIndex]
    const act = actions[failIndex]
    if (failed.savedById) {
      const who = ctx.opponents.find((o) => o.id === failed.savedById)
      outcome = 'SAVED'
      reason = `${who?.name ?? '골키퍼'}의 선방입니다! ${act.actor.name}의 슛은 골문을 향했지만 골키퍼가 슛선에서 막아냈습니다. (성공 확률 ${(failed.p * 100).toFixed(0)}%)`
    } else if (failed.interceptorId) {
      const who = ctx.opponents.find((o) => o.id === failed.interceptorId)
      outcome = 'INTERCEPTED'
      reason = `${failIndex + 1}번째 ${LABEL[act.type]} 실패 — ${who?.name ?? '수비수'}가 경로를 차단했습니다. (개별 확률 ${(failed.p * 100).toFixed(0)}%)`
    } else {
      outcome = 'MISS'
      reason =
        act.type === 'shot'
          ? `${act.actor.name}의 슛이 골문을 빗나갔습니다. (성공 확률 ${(failed.p * 100).toFixed(0)}%)`
          : `${failIndex + 1}번째 ${LABEL[act.type]}가 무산됐습니다. (성공 확률 ${(failed.p * 100).toFixed(0)}%)`
    }
  }

  return { pTotal, outcome, steps, reason, seed: ctx.seed }
}
