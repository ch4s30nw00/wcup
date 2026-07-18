// engine/resolve.js — 확률 판정 엔진 (CALC_SPEC v2, 로그오즈 가법 + 로지스틱).
// 산식확정 보고서 v2(2026-07-18)의 확정 산식을 구현한다. 계수는 constants.js 한 파일에.
//
// 구조: 모든 항(거리·각도·스킬·수비압박)을 로그오즈 z에 더하고 마지막에 σ(z) 1회,
// 전역 clamp(0.02, 0.97). 수비는 오라 이진판정 대신 연속 소프트 프레셔 e^(−d/R).
//
//   resolveSequence(actions, ctx) → { pTotal, outcome, steps, reason, seed }
//
//   actions[k]: { type: 'dribble'|'pass'|'shot', actor, from, to, ctrl }
//     actor    — players.json 선수 객체 (능력치 포함)
//     from/to  — 피치 좌표 (120x80, 대략 미터 단위)
//     ctrl     — 곡률 제어점 (2차 베지어. 직선이면 시작·끝의 중점)
//   ctx: { opponents: [{id, x, y, attributes, ...}], seed: number }
//
//   steps[k]: { type, p, success, interceptorId?, interceptPoint?, interceptFrac? }
//     실패 스텝에는 누가(interceptorId), 경로의 어느 지점(interceptPoint,
//     진행률 interceptFrac ∈ [0,1])에서 끊었는지가 담긴다 → 차단 연출 좌표로 사용.
//     첫 실패 이후의 스텝은 success: null (미실행, p만 계산됨).
//   outcome: 'GOAL' | 'ADVANCE'(슛 없이 전개 성공) | 'INTERCEPTED' | 'MISS'
//
// 보류 항 (데이터·팀 확정 대기, 보고서 로드맵):
//   곡선 κ 트릭샷(technique) · tackle 스탯의 β 스케일 · finishing/heading 슛 분기 · PK 특례 0.76

import { samplePath, pathLength, minDistToPath } from './geometry.js'
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

// 어댑터: 0~100 스탯 → [0.3, 1.0]. FM 1~20 데이터로 이관 시 이 한 줄만 v/20으로 교체 (부록 A).
const norm = (v) => K.STAT_FLOOR + (1 - K.STAT_FLOOR) * (v / 100)

const sigmoid = (z) => 1 / (1 + Math.exp(-z))
const clampP = (p) => Math.min(K.P_MAX, Math.max(K.P_MIN, p))

// 소프트 프레셔 — 모든 액션이 공용하는 연속 감쇠. 로그오즈에 β(<0)·pressure로 가산.
// TODO(보류): tackle 스탯 확정 시 β를 β·norm(tackle)로 스케일 (계수 재캘리브레이션 필요해 미적용)
const pressure = (d, R) => Math.exp(-d / R)

// 차단 연출 귀속 기준: 이보다 압박이 약한 수비수는 "끊은 사람"으로 지목하지 않는다
const ATTRIBUTION_MIN = 0.15

// 수비수들의 경로 압박 로그오즈 합 + 가장 위협적인 수비수(연출용) 추적.
// sum 옵션이 꺼지면(드리블) 최근접 1명만 반영 — 1v1 대면 간격 모델.
function pathPressure(pts, opponents, beta, R, { sum = true, excludeGK = false, excludeId = null } = {}) {
  let z = 0
  let worst = null
  for (const o of opponents) {
    if (excludeGK && o.position === 'GK') continue
    if (o.id === excludeId) continue
    const { d, point, frac } = minDistToPath(pts, o)
    const pr = pressure(d, R)
    if (sum) z += beta * pr
    if (!worst || pr > worst.pr) worst = { pr, id: o.id, point, frac }
  }
  if (!sum && worst) z = beta * worst.pr
  if (worst && worst.pr < ATTRIBUTION_MIN) worst = null
  return { z, worst }
}

// --- 슈팅: 로지스틱 xG ------------------------------------------------------
// z = B0 + B_DIST·D + B_ANG·θ + B_SKILL·(S_eff − SEFF0) + Σ B_BLOCK·e^(−d/R_BLOCK)
// GK 제외 = 이중계상 방지 (로지스틱 xG는 이미 "평균 키퍼 모집단"에서 캘리브레이션된 값)
export function calcShot(action, opponents) {
  const C = K.SHOT
  const s = action.actor.attributes
  const from = action.from
  const sEff = norm(s.technical.shooting) * (0.7 + 0.3 * norm(s.mental.composure))
  const D = Math.hypot(K.GOAL.x - from.x, K.GOAL.y - from.y)
  // 각도 개방도: 양 포스트 사잇각 (라디안)
  const a1 = Math.atan2(K.GOAL.postA - from.y, K.GOAL.x - from.x)
  const a2 = Math.atan2(K.GOAL.postB - from.y, K.GOAL.x - from.x)
  let theta = Math.abs(a1 - a2)
  if (theta > Math.PI) theta = 2 * Math.PI - theta

  const pts = samplePath(from, action.ctrl, action.to)
  const block = pathPressure(pts, opponents, C.B_BLOCK, C.R_BLOCK, { excludeGK: true })
  const z = C.B0 + C.B_DIST * D + C.B_ANG * theta + C.B_SKILL * (sEff - C.SEFF0) + block.z
  return { z, worst: block.worst }
}

// --- 패스: 로그오즈 (리시버 지배) -------------------------------------------
// z = Z0 + B_LEN·L + B_PASS·(S_pass − 0.70) + B_RECV·e^(−d_recv/R_RECV) + Σ B_LANE·e^(−d/R_LANE)
// 지배 레버는 경로가 아니라 도착점 근처 수비 기하 (리서치 합의).
// 곡선은 호 길이 L이 길어져 B_LEN으로 자연 페널티 (κ 트릭샷 항은 technique 확정까지 보류).
export function calcPass(action, opponents) {
  const C = K.PASS
  const s = action.actor.attributes
  const pts = samplePath(action.from, action.ctrl, action.to)
  const L = pathLength(pts)
  const sPass = norm(s.technical.passing) * (0.85 + 0.15 * norm(s.mental.vision ?? s.mental.decisions))

  // 리시버 압박: 도착점 최근접 수비수. 이 수비수는 경로(lane) 합산에서 제외 — 이중계상 방지
  // (보고서 검증표 0.34/0.47/0.70이 리시버 항 단독 기준).
  let recv = null
  for (const o of opponents) {
    const dd = Math.hypot(o.x - action.to.x, o.y - action.to.y)
    if (!recv || dd < recv.d) recv = { d: dd, id: o.id, o }
  }
  const lane = pathPressure(pts, opponents, C.B_LANE, C.R_LANE, { excludeId: recv?.id })
  const recvPr = recv ? pressure(recv.d, C.R_RECV) : 0
  const z = C.Z0 + C.B_LEN * L + C.B_PASS * (sPass - 0.7) + C.B_RECV * recvPr + lane.z
  // 연출 귀속: 경로 압박자와 리시버 마크맨 중 압박이 큰 쪽
  let worst = lane.worst
  if (recv && recvPr >= ATTRIBUTION_MIN && (!worst || recvPr > worst.pr)) {
    worst = { pr: recvPr, id: recv.id, point: action.to, frac: 1 }
  }
  return { z, worst }
}

// --- 드리블: 1v1 (기하 지배) ------------------------------------------------
// z = Z0d + B_SKILL·(S_drib − 0.70) + B_LEN·L + B_DEF·e^(−d_def/R_DEF)
// 1v1은 예측력이 낮다(AUC≈0.69) → 능력치 가중은 의도적으로 약하게, 대면 수비 1명이 지배.
export function calcDribble(action, opponents) {
  const C = K.DRIB
  const s = action.actor.attributes
  const pts = samplePath(action.from, action.ctrl, action.to)
  const L = pathLength(pts)
  const sDrib = norm(s.technical.dribbling ?? (s.physical.pace + s.mental.composure) / 2)
  const def = pathPressure(pts, opponents, C.B_DEF, C.R_DEF, { sum: false })
  const z = C.Z0 + C.B_SKILL * (sDrib - 0.7) + C.B_LEN * L + def.z
  return { z, worst: def.worst }
}

const CALC = { pass: calcPass, dribble: calcDribble, shot: calcShot }
const LABEL = { pass: '패스', dribble: '드리블', shot: '슛' }

// 수비 붕괴 보정 — k번째 액션(0부터)까지 전부 성공했다는 전제의 로그오즈 보너스.
// 연속 성공이 쌓이면 수비가 흔들려 다음 액션이 쉬워진다 (∏P의 과도한 붕괴를 조건부 완화).
const flowBonus = (k) => Math.min(K.SEQ.FLOW * k, K.SEQ.FLOW_MAX)

export function resolveSequence(actions, ctx) {
  const rng = mulberry32(ctx.seed)
  // 1) 각 액션의 확률 계산 — z(코어) + 수비 붕괴 보정 → σ → clamp.
  //    보정은 "앞선 액션이 전부 성공했을 때"의 값이라, 첫 실패 전까지는 실제 판정과 동일.
  const calcs = actions.map((a, k) => {
    const { z, worst } = CALC[a.type](a, ctx.opponents)
    return { p: clampP(sigmoid(z + flowBonus(k))), worst }
  })
  // 계획 전체 성공 확률 (첫 실패 없이 끝까지 갔을 때의 ∏) — 패널 표시용
  const pTotal = calcs.reduce((m, c) => m * c.p, 1)

  // 2) 순서대로 굴려서 첫 실패 지점 결정 (첫 실패에서 중단 = 정직한 생존확률)
  const steps = []
  let failIndex = -1
  for (let i = 0; i < actions.length; i++) {
    const { p, worst } = calcs[i]
    const step = { type: actions[i].type, p, success: null }
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
    reason =
      outcome === 'GOAL'
        ? `${last.actor.name}의 슛이 골망을 흔듭니다! (시퀀스 ${actions.length}개 액션 전부 성공)`
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
