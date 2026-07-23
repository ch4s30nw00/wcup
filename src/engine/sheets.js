// engine/sheets.js — 시트(페이즈) 단위 설계의 순수 계산부.
//
// 시트 = "공 액션 1개 + 그에 딸린 오프볼 런들". 1번 무브를 끝내면 시트1이 굳고
// 시트2가 생기고, 거기서 다시 그리고… 하는 식의 설계 흐름 (사용자 요청, 2026-07-19).
//
// 중요 — 시트는 **새로운 데이터 모델이 아니라 기존 체인의 뷰**다.
//   시트 k = chainActs[k] + { r ∈ runs | r.afterIndex === k }
// 이미 App이 chainActs·runs로 모든 좌표를 유도하고 있으므로, 시트 모드는 그 위에
// "어디까지 확정됐는지(확정 시트 수)"만 얹는다. 그래서 resolveSequence에 넘기는
// actions 형식이 원샷 모드와 완전히 동일하고, 판정 엔진은 시트를 알 필요가 없다.
//
// 가동범위 동심원: 이번 시트의 공 액션이 걸리는 시간 동안 그 선수가 갈 수 있는 거리.
//   r = speedOf(선수) × durSec
//   speedOf는 defense.js와 같은 공식 — 보이는 반경과 수비가 실제로 따라잡는 거리가
//   어긋나면 "왜 저기까지 못 가지?"가 되므로 반드시 공유한다.

import { midpoint, samplePath, pathLength } from './geometry.js'
import { K } from './constants.js'

// 이 액션이 소비하는 시간(초). resolve.js actionSeconds와 같은 정의 —
// 패스류는 비행시간 + 인지 반응시간, 드리블은 주행시간.
export function actionDuration(action) {
  if (!action) return 0
  const pts = samplePath(action.from, action.ctrl ?? midpoint(action.from, action.to), action.to)
  const L = pathLength(pts)
  const isPass = action.type === 'pass' || action.type === 'cross'
  const v = isPass ? K.PLAY.PASS_SPEED : (K.SPEED[action.type] ?? K.SPEED.pass)
  const flight = Math.max(L / v, isPass ? K.PLAY.PASS_MIN_MS / 1000 : 0)
  return flight + (action.type === 'dribble' ? 0 : K.DEF.REACT)
}

// 전력(100%)으로 갈 수 있는 반경(m). 여유 링은 SHEET.EASY_FRAC 배.
const stat01 = (player, key) => Math.min(1, Math.max(0, (player?.stats?.[key] ?? K.STAT.FM_MAX / 2) / K.STAT.FM_MAX))

// Runners start from rest: acceleration matters over short moves and pace sets
// their top speed once they are up to speed. This is deliberately separate from
// the defensive AI speed calculation.
export function movementProfile(player) {
  const pace = stat01(player, 'pace')
  const acceleration = stat01(player, 'acceleration')
  return {
    topSpeed: K.SHEET.RUN_SPEED_MIN + (K.SHEET.RUN_SPEED_MAX - K.SHEET.RUN_SPEED_MIN) * pace,
    acceleration: K.SHEET.ACCEL_MIN + (K.SHEET.ACCEL_MAX - K.SHEET.ACCEL_MIN) * acceleration,
  }
}

export function movementDistance(player, durSec) {
  const t = Math.max(0, durSec)
  const { topSpeed, acceleration } = movementProfile(player)
  const rampTime = topSpeed / acceleration
  if (t <= rampTime) return 0.5 * acceleration * t * t
  return 0.5 * acceleration * rampTime * rampTime + topSpeed * (t - rampTime)
}

// Inverse of movementDistance; playback uses the same stats as the editor ring.
export function movementDuration(player, distance) {
  const d = Math.max(0, distance)
  if (d === 0) return 0
  const { topSpeed, acceleration } = movementProfile(player)
  const rampTime = topSpeed / acceleration
  const rampDistance = 0.5 * acceleration * rampTime * rampTime
  if (d <= rampDistance) return Math.sqrt((2 * d) / acceleration)
  return rampTime + (d - rampDistance) / topSpeed
}

export function reachRadius(player, durSec) {
  return movementDistance(player, durSec)
}

// 오프볼 런 목표를 가동범위 안으로 끌어당긴다 (반경 밖이면 경계로 클램프).
export function clampToReach(from, to, radius) {
  if (!(radius > 0)) return to
  const dx = to.x - from.x
  const dy = to.y - from.y
  const d = Math.hypot(dx, dy)
  if (d <= radius || d === 0) return to
  return { x: from.x + (dx / d) * radius, y: from.y + (dy / d) * radius }
}

// 스루패스가 성립하는 가장 먼 도착점.
//
// 문제: 반경을 먼저 정할 수 없다. 공이 멀리 갈수록 비행시간이 길어져 리시버가 더
// 멀리까지 갈 수 있고, 리시버 목표를 당기면 패스가 짧아져 다시 반경이 줄어든다.
// 즉 "패스 길이 → 비행시간 → 가동반경 → 도착점 → 패스 길이"가 서로 물려 있다.
//
// 성립 조건은 하나뿐이다 — **공과 사람이 같이 도착해야 한다**:
//     d / speed  ≤  |p(d) − ballFrom| / K.SPEED.pass + REACT
//   (좌변 = 리시버가 d만큼 뛰는 시간, 우변 = 공의 비행시간 + 인지 반응)
//
// 좌변은 1/speed(≈0.16 s/m)로, 우변은 최대 1/22(≈0.045 s/m)로 증가하므로
// 차 f(d)는 d에 대해 **단조 증가**다. 그래서 이분탐색으로 안전하게 최대 d를 찾는다.
//
//   runnerFrom — 리시버가 지금 서 있는 자리
//   ballFrom   — 패스가 출발하는 지점(공 소유자)
//   want       — 유저가 찍은 지점
// → want가 이미 성립하면 want 그대로, 아니면 runnerFrom→want 선분 위의 가장 먼 성립점.
export function throughTarget({ runnerFrom, ballFrom, want, player }) {
  const dx = want.x - runnerFrom.x
  const dy = want.y - runnerFrom.y
  const maxD = Math.hypot(dx, dy)
  if (maxD < 1e-6) return want
  const ux = dx / maxD
  const uy = dy / maxD
  const at = (d) => ({ x: runnerFrom.x + ux * d, y: runnerFrom.y + uy * d })
  // f(d) ≤ 0 이면 그 지점은 "공보다 먼저(또는 같이) 도착 가능" = 성립
  const f = (d) => {
    const p = at(d)
    // Match playback exactly: a successful through-ball receiver has to reach
    // the point no later than the displayed ball-flight time.
    const ballT = Math.max(
      Math.hypot(p.x - ballFrom.x, p.y - ballFrom.y) / K.PLAY.PASS_SPEED,
      K.PLAY.PASS_MIN_MS / 1000,
    )
    return movementDuration(player, d) - ballT
  }
  if (f(maxD) <= 0) return want // 찍은 지점이 이미 성립 — 손대지 않는다
  let lo = 0
  let hi = maxD
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (f(mid) <= 0) lo = mid
    else hi = mid
  }
  return at(lo)
}

// 체인·런을 시트 단위로 묶는다 (탭 UI·요약 표시용).
//   → [{ index, act, runs: [{ key, ...run }] }]
// 액션이 아직 없는 마지막 시트(작성 중)도 한 장으로 포함된다.
export function groupSheets(chainActs, runs) {
  const n = Math.max(chainActs.length, ...runs.map((r) => r.afterIndex + 1), 0)
  const total = Math.max(n, chainActs.length)
  const out = []
  for (let i = 0; i < Math.max(total, 1); i++) {
    out.push({
      index: i,
      act: chainActs[i] ?? null,
      runs: runs.map((r, key) => ({ ...r, key })).filter((r) => r.afterIndex === i),
    })
  }
  return out
}
