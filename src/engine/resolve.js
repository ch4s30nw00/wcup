// engine/resolve.js — 확률 판정 엔진 (CALC_SPEC v2.1, 로그오즈 가법 + 로지스틱).
// 산식확정 보고서 v2(2026-07-18) + 데이터담당 요청사항(FM 1~20 CSV)을 구현한다. 계수는 constants.js 한 파일에.
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
//   steps[k]: { type, p, success, header?, cross?, defPos, interceptorId?, interceptPoint?, interceptFrac? }
//     defPos — 이 액션이 끝난 시점의 수비수 좌표 {id: {x, y}} (연출·다음 판정 공유)
//     실패 스텝에는 누가(interceptorId), 어디서(interceptPoint, interceptFrac) 끊었는지가 담긴다.
//     첫 실패 이후의 스텝은 success: null (미실행, p만 계산됨).
//   outcome: 'GOAL' | 'ADVANCE'(슛 없이 전개 성공) | 'INTERCEPTED' | 'MISS'
//
// 보류 항: PK 특례 0.76 (PK 상황 미도입) · 컨디션/체력 스케일

import { samplePath, pathLength, minDistToPath } from './geometry.js'
import { initDefense, advanceDefense } from './defense.js'
import { K } from './constants.js'

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

// 어댑터: FM 1~20 스탯 → [0.335, 1.0] (부록 A — 데이터담당 CSV 이관으로 v/20 채택)
const norm = (v) => K.STAT_FLOOR + (1 - K.STAT_FLOOR) * (v / K.STAT.FM_MAX)
// 키(cm) → [0.3, 1.0] (165~200cm 구간)
const normH = (h) => K.STAT_FLOOR + (1 - K.STAT_FLOOR) * Math.min(1, Math.max(0, (h - K.STAT.H_MIN) / K.STAT.H_RANGE))

const sigmoid = (z) => 1 / (1 + Math.exp(-z))
const clampP = (p) => Math.min(K.P_MAX, Math.max(K.P_MIN, p))

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
  for (const o of opponents) {
    if (excludeGK && o.position === 'GK') continue
    if (o.id === excludeId) continue
    const { d, point, frac } = minDistToPath(pts, o)
    const pr = pressure(d, R)
    if (sum) z += beta * (betaScale ? betaScale(o) : 1) * pr
    if (!worst || pr > worst.pr) worst = { pr, id: o.id, point, frac, o }
  }
  if (!sum && worst) z = beta * (betaScale ? betaScale(worst.o) : 1) * worst.pr
  if (worst && worst.pr < ATTRIBUTION_MIN) worst = null
  return { z, worst }
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
// z = B0 + B_DIST·lsFactor·D + B_ANG·θ + B_SKILL·(S_eff − SEFF0) + Σ B_BLOCK·defScale·e^(−d/R_BLOCK)
// GK 제외 = 이중계상 방지 (로지스틱 xG는 이미 "평균 키퍼 모집단"에서 캘리브레이션된 값)
// prev(직전 액션)가 크로스면 헤더 슛: 골결:헤더 = 3:7 + 공중 듀얼 (데이터 요청 §2·3)
export function calcShot(action, opponents, prev = null) {
  const C = K.SHOT
  const st = action.actor.stats
  const from = action.from
  const header = !!(prev && prev.type === 'pass' && isCrossGeometry(prev))

  // 발: 골결 단독 (데이터 요청 §4 "발로 찰 땐 골결"). 헤더: 골결 3 : 헤더 7.
  const sEff = header
    ? C.HEAD_FIN * norm(st.finishing) + (1 - C.HEAD_FIN) * norm(st.heading)
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
  const block = pathPressure(pts, opponents, C.B_BLOCK, C.R_BLOCK, {
    excludeGK: true,
    betaScale: (o) => defScale(o, DEF_PRIMARY.shot(o)),
  })
  let z = C.B0 + C.B_DIST * lsFactor * D + C.B_ANG * theta + C.B_SKILL * (sEff - C.SEFF0) + block.z

  // 헤더 공중 듀얼: 슛 지점 최근접 수비수와 점프+키+몸싸움 경합 (예측력 50% 혼합은 defScale 몫)
  if (header) {
    let nearest = null
    for (const o of opponents) {
      if (o.position === 'GK') continue
      const dd = Math.hypot(o.x - from.x, o.y - from.y)
      if (!nearest || dd < nearest.dd) nearest = { o, dd }
    }
    if (nearest && nearest.dd < C.R_BLOCK * 2) z += C.B_AIR * (airOf(action.actor) - airOf(nearest.o))
  }
  return { z, worst: block.worst, header }
}

// --- 패스: 로그오즈 (리시버 지배) -------------------------------------------
// z = Z0 + B_LEN·L + B_PASS·(S_pass − 0.70) + B_RECV·defScale·e^(−d_recv/R_RECV) + Σ B_LANE·defScale·e^(−d/R_LANE)
// 지배 레버는 경로가 아니라 도착점 근처 수비 기하 (리서치 합의).
// 곡선은 호 길이 L이 길어져 B_LEN으로 자연 페널티.
// 크로스 기하면 패스 스킬 대신 크로스 스탯 + 예측력 보정 ("크로스 올릴 때", 데이터 요청 §7).
export function calcPass(action, opponents) {
  const C = K.PASS
  const st = action.actor.stats
  const pts = samplePath(action.from, action.ctrl, action.to)
  const L = pathLength(pts)
  const cross = isCrossGeometry(action)
  const sPass = cross
    ? norm(st.crossing) * (0.85 + 0.15 * norm(st.anticipation))
    : norm(st.passing)

  // 리시버 압박: 도착점 최근접 수비수. 이 수비수는 경로(lane) 합산에서 제외 — 이중계상 방지
  // (보고서 검증표 0.34/0.47/0.70이 리시버 항 단독 기준).
  let recv = null
  for (const o of opponents) {
    const dd = Math.hypot(o.x - action.to.x, o.y - action.to.y)
    if (!recv || dd < recv.d) recv = { d: dd, id: o.id, o }
  }
  const laneScale = (o) => defScale(o, DEF_PRIMARY.pass(o))
  const lane = pathPressure(pts, opponents, C.B_LANE, C.R_LANE, { excludeId: recv?.id, betaScale: laneScale })
  const recvPr = recv ? pressure(recv.d, C.R_RECV) : 0
  const recvZ = recv ? C.B_RECV * laneScale(recv.o) * recvPr : 0
  const z = C.Z0 + C.B_LEN * L + C.B_PASS * (sPass - 0.7) + recvZ + lane.z
  // 연출 귀속: 경로 압박자와 리시버 마크맨 중 압박이 큰 쪽
  let worst = lane.worst
  if (recv && recvPr >= ATTRIBUTION_MIN && (!worst || recvPr > worst.pr)) {
    worst = { pr: recvPr, id: recv.id, point: action.to, frac: 1 }
  }
  return { z, worst, cross }
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
  let z = C.Z0 + C.B_SKILL * (sDrib - 0.7) + C.B_LEN * L + def.z
  if (def.worst) z += C.B_BODY * def.worst.pr * (bodyOf(action.actor) - bodyOf(def.worst.o))
  return { z, worst: def.worst }
}

const LABEL = { pass: '패스', dribble: '드리블', shot: '슛' }

// 잔여 기세 보정 — k번째 액션(0부터)까지 전부 성공했다는 전제의 작은 로그오즈 보너스.
// 수비 붕괴의 주 메커니즘은 defense.js의 위치 재계산이고, 이 상수는 "흐름 탄 팀의 기세"만 남긴다.
const flowBonus = (k) => Math.min(K.SEQ.FLOW * k, K.SEQ.FLOW_MAX)

// 이 액션이 소비하는 시간(초) — 수비 이동 예산. 패스류는 비행시간 + 반응시간, 드리블은 주행시간.
function actionSeconds(action) {
  const pts = samplePath(action.from, action.ctrl, action.to)
  const L = pathLength(pts)
  const v = K.SPEED[action.type] ?? K.SPEED.pass
  return L / v + (action.type === 'dribble' ? 0 : K.DEF.REACT)
}

export function resolveSequence(actions, ctx) {
  const rng = mulberry32(ctx.seed)

  // 공격수 현재 좌표 추적 (수비 마킹 대상) — 체인 진행에 따라 액터·리시버 위치 갱신.
  // 오프볼 런은 액션이 아니므로 근사에서 제외 (마킹은 볼 근처 기하가 지배라 영향 작음).
  const atkPos = new Map()
  for (const p of ctx.players ?? []) atkPos.set(p.id, { id: p.id, x: p.x, y: p.y })
  const moveAtk = (id, pt) => id && atkPos.set(id, { id, x: pt.x, y: pt.y })

  // 1) 각 액션의 확률 계산 — 액션마다 수비 좌표를 전진시키며 판정.
  //    k번째 판정과 수비 이동 모두 "앞선 액션이 전부 성공했을 때"의 상태라,
  //    첫 실패 전까지는 실제 판정과 동일 (조건부 확률의 정직한 전개).
  let defs = initDefense(ctx.opponents)
  const calcs = actions.map((a, k) => {
    const prev = k > 0 ? actions[k - 1] : null
    const c =
      a.type === 'shot'
        ? calcShot(a, defs, prev)
        : a.type === 'pass'
          ? calcPass(a, defs)
          : calcDribble(a, defs)
    // 액터(드리블)·리시버(패스)가 도착점으로 이동
    if (a.type === 'dribble') moveAtk(a.actorId, a.to)
    else if (a.type === 'pass') moveAtk(a.receiverId, a.to)
    // 수비 재배치: 이 액션의 시간 예산만큼 볼 도착점에 반응해 이동
    defs = advanceDefense(defs, { to: a.to, durSec: actionSeconds(a), attackers: [...atkPos.values()] })
    const defPos = Object.fromEntries(defs.map((d) => [d.id, { x: d.x, y: d.y }]))
    return { p: clampP(sigmoid(c.z + flowBonus(k))), worst: c.worst, header: c.header, cross: c.cross, defPos }
  })
  // 계획 전체 성공 확률 (첫 실패 없이 끝까지 갔을 때의 ∏) — 패널 표시용
  const pTotal = calcs.reduce((m, c) => m * c.p, 1)

  // 2) 순서대로 굴려서 첫 실패 지점 결정 (첫 실패에서 중단 = 정직한 생존확률)
  const steps = []
  let failIndex = -1
  for (let i = 0; i < actions.length; i++) {
    const { p, worst, header, cross, defPos } = calcs[i]
    const step = { type: actions[i].type, p, success: null, header, cross, defPos }
    if (failIndex === -1) {
      step.success = rng() < p
      if (!step.success) {
        failIndex = i
        // 압박 기여가 가장 큰 수비수가 끊은 것으로 (연출 좌표)
        if (worst) {
          step.interceptorId = worst.id
          step.interceptPoint = worst.point
          step.interceptFrac = worst.frac
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
  } else {
    const failed = steps[failIndex]
    const act = actions[failIndex]
    if (failed.interceptorId) {
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
