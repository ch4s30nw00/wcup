// engine/resolve.js — 확률 판정 엔진 (임시 구현).
// 계산식 담당 팀원의 "산술식" 스펙을 코드 계약으로 옮겨둔 자리.
// 스탯 스키마/스케일이 확정되면 norm()만, 공식이 확정되면 각 p*() 내부만 교체한다.
// UI는 resolveSequence의 시그니처(입력/출력 형태)에만 의존한다.
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

import { samplePath, pathLength, minDistToPath } from './geometry.js'

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

// 어댑터 패턴: 현재 더미 데이터는 0~100 스케일 → [0.3, 1.0] 계수로 정규화.
// 팀원 스펙은 FM 1~20 기준(S/20)이므로 데이터가 확정되면 여기만 바꾼다.
const norm = (v) => 0.3 + 0.7 * (v / 100)

// 밸런싱 상수 — 피치 단위는 대략 미터
export const DEF_RADIUS = 6 // 수비 오라 반경 R. TODO: 선수 데이터 필드로 (일단 전원 동일)
const ALPHA_PASS = 0.008 // 패스 거리 감쇠
const ALPHA_DRIBBLE = 0.02 // 드리블 거리 감쇠 (길게 끌수록 위험)
const BETA_PASS = 0.35 // 패스 차단 강도
const BETA_DRIBBLE = 0.3 // 드리블 압박 강도
const D0_SHOT = 25 // 슛 거리 특성 상수
const R_BLOCK = 2.5 // 슛 블로커 위협 반경
const SHOT_SCALE = 2.2 // 게임 재미용 보정 (순수 xG는 너무 짜서)
const POSTS = [
  { x: 120, y: 36.34 },
  { x: 120, y: 43.66 },
]

// 경로 주변 수비수들의 차단 페널티.
// 스펙 ②의 M_def는 식이 뒤집혀 있어(d=0에서 페널티가 사라짐) 보정:
// 수비수가 경로에 붙을수록(d→0) 계수가 작아지도록 M = e^(-β·tackle·(R-d))
function defenseFactor(pts, opponents, beta) {
  let factor = 1
  let worst = null // 가장 위협적인 수비수 → 실패 시 차단 연출의 주인공
  for (const o of opponents) {
    const { d, point, frac } = minDistToPath(pts, o)
    if (d > DEF_RADIUS) continue
    const tackle = norm(o.attributes.mental.decisions) // TODO: tackle 스탯 생기면 교체
    const m = Math.exp(-beta * tackle * (DEF_RADIUS - d))
    factor *= m
    if (!worst || m < worst.m) worst = { m, id: o.id, point, frac }
  }
  return { factor, worst }
}

// 스펙 ②(직선)·③(곡선)을 하나로: 직선이든 곡선이든 샘플링한 경로 기준으로
// 거리 감쇠 + 수비 차단을 계산한다 (직선은 L=D라서 자연히 ②와 일치).
// 스펙 ③은 곡선에 M_def를 빼는 대신 트릭샷 페널티 (1-κ), κ=e^(-λ·S_technique)를
// 곱하는데, technique 스탯이 데이터에 없어 보류 — 곡선도 경로 기준 수비 판정으로 대체 중.
// TODO: technique 스탯 확정 시 κ 항 추가 여부 팀원과 결정
function calcPass(action, opponents) {
  const s = action.actor.attributes
  const pts = samplePath(action.from, action.ctrl, action.to)
  const L = pathLength(pts) // 곡선이면 호 길이 — 휘어 갈수록 거리 페널티 (스펙 ③)
  const acc = norm(s.technical.passing)
  const vision = norm(s.mental.decisions) // TODO: vision 스탯 생기면 교체
  const mDist = Math.exp(-(ALPHA_PASS / vision) * L)
  const def = defenseFactor(pts, opponents, BETA_PASS)
  return { p: acc * mDist * def.factor, worst: def.worst }
}

function calcDribble(action, opponents) {
  const s = action.actor.attributes
  const pts = samplePath(action.from, action.ctrl, action.to)
  const L = pathLength(pts)
  const base = norm((s.physical.pace + s.mental.composure) / 2)
  const mDist = Math.exp(-ALPHA_DRIBBLE * L)
  const def = defenseFactor(pts, opponents, BETA_DRIBBLE)
  return { p: base * mDist * def.factor, worst: def.worst }
}

function calcShot(action, opponents) {
  const s = action.actor.attributes
  const from = action.from
  // 침착성 보정 (스펙 ④): S_eff = S_shot × (0.7 + 0.3 × S_composure)
  const sEff = norm(s.technical.shooting) * (0.7 + 0.3 * norm(s.mental.composure))
  // 거리 감쇠 (가우시안)
  const D = Math.hypot(120 - from.x, 40 - from.y)
  const fDist = Math.exp(-((D / D0_SHOT) ** 2))
  // 각도 개방도: 골 양 포스트 사잇각 θ → sin(θ/2) (xG 모델 표준)
  const a1 = Math.atan2(POSTS[0].y - from.y, POSTS[0].x - from.x)
  const a2 = Math.atan2(POSTS[1].y - from.y, POSTS[1].x - from.x)
  let theta = Math.abs(a1 - a2)
  if (theta > Math.PI) theta = 2 * Math.PI - theta
  const fAngle = Math.sin(theta / 2)
  // 블로커 방해: 슛 라인 최단거리 재활용, f = ∏(1 - e^(-d/R_block))
  // GK는 제외 — 키퍼 세이브는 SHOT_SCALE에 흡수 (라인 위 GK가 모든 중앙 슛을 0%로 만드는 것 방지)
  const pts = samplePath(from, action.ctrl, action.to)
  let fBlock = 1
  let worst = null
  for (const o of opponents) {
    if (o.position === 'GK') continue
    const { d, point, frac } = minDistToPath(pts, o)
    if (d > R_BLOCK * 3) continue
    const m = 1 - Math.exp(-d / R_BLOCK)
    fBlock *= m
    if (!worst || m < worst.m) worst = { m, id: o.id, point, frac }
  }
  const p = Math.min(0.95, sEff * fDist * fAngle * fBlock * SHOT_SCALE)
  return { p, worst }
}

const CALC = { pass: calcPass, dribble: calcDribble, shot: calcShot }
const LABEL = { pass: '패스', dribble: '드리블', shot: '슛' }

export function resolveSequence(actions, ctx) {
  const rng = mulberry32(ctx.seed)
  // 1) 모든 액션의 확률을 먼저 계산 (패널 표시용)
  const calcs = actions.map((a) => CALC[a.type](a, ctx.opponents))
  // 스펙 ⑤(감쇠형 곱셈)는 자체 검증 예시(0.7⁵→0.55)와 식이 안 맞아 확인 대기 중.
  // 확정되면 이 한 줄만 교체하면 된다 — 지금은 순수 곱 ∏Pₖ.
  const pTotal = calcs.reduce((m, c) => m * c.p, 1)

  // 2) 순서대로 굴려서 첫 실패 지점 결정
  const steps = []
  let failIndex = -1
  for (let i = 0; i < actions.length; i++) {
    const { p, worst } = calcs[i]
    const step = { type: actions[i].type, p, success: null }
    if (failIndex === -1) {
      step.success = rng() < p
      if (!step.success) {
        failIndex = i
        // 오라 안에 수비수가 있었으면 그 수비수가 끊은 것으로
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
