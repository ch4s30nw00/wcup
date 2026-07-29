// engine/sheets.js — 액션 단위 시간·거리 계산.
//
// 한 공 액션(드리블/패스/슛)이 걸리는 시간과, 그동안 각 선수가 갈 수 있는 거리를 낸다.
// 화면의 가동범위 동심원, 오프볼 런 목표 제한, 스루패스의 "공과 사람이 같이 도착하는
// 지점" 계산이 전부 여기 값을 공유한다 — 갈라 두면 보이는 반경과 실제로 걸리는 제한이
// 어긋나 "왜 저기까지밖에 안 가지"가 된다.
//
// (한때 여기 '시트 모드'라는 별도 설계 모드가 얹혀 있었지만, 원샷 모드와 실질 차이가
//  없어 통합했다. 남은 함수들은 모드와 무관한 순수 계산이다.)
//
// 가동범위 동심원: 마지막 공 액션이 걸리는 시간 동안 그 선수가 갈 수 있는 거리.
//   r = speedOf(선수) × durSec
//   speedOf는 defense.js와 같은 공식 — 보이는 반경과 수비가 실제로 따라잡는 거리가
//   어긋나면 "왜 저기까지 못 가지?"가 되므로 반드시 공유한다.

import { speedOf } from './defense.js'
import { samplePath, pathLength } from './geometry.js'
import { K, actionSpeed } from './constants.js'

// Shared physical duration used by both playback and reach calculations.
// It deliberately excludes tactical reaction time: a user-assigned run starts
// immediately with the ball action, so it must reach the same on-screen time.
export function movementDuration(distance, speed) {
  return Math.max(K.PLAY.ACTION_MIN_MS / 1000, distance / speed)
}

// 이 액션이 소비하는 시간(초). resolve.js actionSeconds와 같은 정의 —
// 패스류는 비행시간 + 인지 반응시간, 드리블은 주행시간.
export function actionDuration(action) {
  if (!action) return 0
  const pts = samplePath(action.from, action.ctrl, action.to)
  const L = pathLength(pts)
  const v = actionSpeed(action)
  // Long actions keep their real duration so the displayed radius and playback stay aligned.
  const flight = movementDuration(L, v)
  return flight + (action.type === 'dribble' ? 0 : K.DEF.REACT)
}

// 전력(100%)으로 갈 수 있는 반경(m).
export function runSpeedOf(player) {
  const base = speedOf(player)
  const acceleration = Math.min(1, Math.max(0, (player?.stats?.acceleration ?? 10) / K.STAT.FM_MAX))
  return base * (1 + acceleration * 0.25)
}

export function reachRadius(player, durSec) {
  return runSpeedOf(player) * Math.max(0, durSec)
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

const isThroughPassKind = (passKind) => passKind === 'through' || passKind === 'lobThrough'

// A through pass is not fixed to one slow speed. Its speed is chosen from
// the requested runner/ball arrival time. The lower speed limit rises as the
// ball travels farther, because a longer pass needs more force.
export function throughSpeedLimits(ballDistance, passKind) {
  const ratio = Math.min(1, Math.max(0, ballDistance / K.THROUGH.FAR_DISTANCE))
  const lobbed = passKind === 'lobThrough'
  const nearMin = lobbed ? K.THROUGH.LOB_NEAR_MIN : K.THROUGH.GROUND_NEAR_MIN
  const farMin = lobbed ? K.THROUGH.LOB_FAR_MIN : K.THROUGH.GROUND_FAR_MIN
  return {
    min: nearMin + (farMin - nearMin) * ratio,
    max: lobbed ? K.THROUGH.LOB_MAX : K.THROUGH.GROUND_MAX,
  }
}

export function throughPassSpeed({ runnerFrom, ballFrom, to, player, passKind = 'through' }) {
  if (!isThroughPassKind(passKind)) return actionSpeed({ type: 'pass', passKind })
  const ballDistance = Math.hypot(to.x - ballFrom.x, to.y - ballFrom.y)
  const runnerDistance = Math.hypot(to.x - runnerFrom.x, to.y - runnerFrom.y)
  const runnerTime = Math.max(K.PLAY.ACTION_MIN_MS / 1000, runnerDistance / runSpeedOf(player))
  const wantedSpeed = ballDistance / runnerTime
  const limits = throughSpeedLimits(ballDistance, passKind)
  return Math.min(limits.max, Math.max(limits.min, wantedSpeed))
}

export function throughBallDuration({ runnerFrom, ballFrom, to, player, passKind = 'through' }) {
  const ballDistance = Math.hypot(to.x - ballFrom.x, to.y - ballFrom.y)
  return movementDuration(ballDistance, throughPassSpeed({ runnerFrom, ballFrom, to, player, passKind }))
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
export function throughTarget({ runnerFrom, ballFrom, want, player, passKind = 'through' }) {
  const speed = runSpeedOf(player)
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
    // The runner and ball start together.  Do not add DEF.REACT here: that
    // delay is for defenders reading a pass, not a user-directed runner.
    const ballT = throughBallDuration({ runnerFrom, ballFrom, to: p, player, passKind })
    return d / speed - ballT
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
