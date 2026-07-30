// engine/offside.js — 오프사이드 판정 (순수 기하, 난수·상태 없음).
//
// 하이브리드 방식 (사용자 확정, 2026-07-19):
//   (a) 계획 단계 — 오프사이드 위치의 리시버에게 빨간 점멸 경고만. 패스 설계 자체는 허용한다.
//       ("설계는 자유, 대가는 실행에서" — 실시간 성공률 프리뷰를 넣지 않는 것과 같은 결.)
//   (b) 실행 단계 — 확률 판정과 무관하게 즉시 실패. 휘슬 + 턴오버 연출.
//
// 판정 시점은 "패스가 출발하는 순간"이다. 리시버가 공을 받는 위치(action.to)와,
// 그 시점의 수비 좌표(= 이 액션의 advanceDefense 적용 *전* 좌표)를 쓴다.
// 실축 규칙과 같은 순간을 본다: 공이 떠난 순간의 정지 화면.
//
// 오프사이드 위치 = 아래 셋을 모두 만족:
//   1. 상대 진영 (x > HALFWAY_X)
//   2. 최후방 2번째 수비수보다 상대 골문 쪽 (x > offsideLine)
//   3. 공보다 상대 골문 쪽 (x > ball.x)
// 동일선상(EPS 이내)은 온사이드 — 실축 규칙과 같다.
//
// 적용 대상은 패스뿐이다. 드리블은 본인이 공을 갖고 가므로 2번을 만족해도 공보다 앞설 수 없고,
// 슛은 리시버가 없다. 골키퍼도 수비수 11명 중 하나로 그냥 x 정렬에 포함된다
// (GK가 나와 있으면 필드 플레이어가 최후방이 되는 실제 상황이 자연히 재현된다).

import { K } from './constants.js'

// 최후방 2번째 수비수의 x. 수비수가 2명 미만이면 오프사이드가 성립하지 않으므로 null.
// (골문 쪽 = x가 큰 쪽. 내림차순 정렬 후 index 1 = 뒤에서 2번째.)
export function offsideLineX(opponents) {
  if (!opponents || opponents.length < 2) return null
  const radius = K.OFFSIDE.PLAYER_RADIUS
  const xs = opponents.map((o) => o.x - radius).sort((a, b) => b - a)
  return xs[1]
}

// 리시버 1명의 오프사이드 여부.
//   receiver — 공을 받는 지점 {x, y}
//   opponents — 판정 시점의 상대 좌표 [{x, y, ...}]
//   ball — 패스가 출발하는 지점 {x, y}
// → { offside, lineX, marginM }
//   marginM: 오프사이드 라인을 넘어선 거리(m). 음수면 온사이드(라인까지 남은 여유).
export function checkOffside({ receiver, opponents, ball }) {
  const O = K.OFFSIDE
  const lineX = offsideLineX(opponents)
  // Players are discs on the board.  For attacks toward x=120, use the
  // non-goalward (rear) edge consistently for both the defender line and
  // receiver.  A runner whose circle has come back behind the line is onside.
  const receiverRearX = receiver.x - O.PLAYER_RADIUS
  const marginM = lineX == null ? -Infinity : receiverRearX - lineX
  const offside =
    lineX != null &&
    receiverRearX > O.HALFWAY_X + O.EPS &&
    marginM > O.EPS &&
    receiverRearX > ball.x + O.EPS
  return { offside, lineX, marginM }
}

// 체인 전체를 훑어 오프사이드인 패스의 인덱스를 모은다 (계획 단계 경고용).
//   legs — [{ type, from, to, receiverId, ... }] (App이 유도한 체인)
//   defsAt(index) — 그 액션 판정 시점의 수비 좌표 배열
//   receiverAt(index) — 패스가 떠나는 순간 리시버가 서 있는 좌표 (없으면 도착점으로 근사)
// → [{ index, receiverId, lineX, marginM }]
export function offsideWarnings(legs, defsAt, receiverAt = null) {
  const out = []
  legs.forEach((leg, index) => {
    if (leg.type !== 'pass') return
    const receiver = receiverAt?.(index) ?? leg.to
    const r = checkOffside({ receiver, opponents: defsAt(index), ball: leg.from })
    if (r.offside) out.push({ index, receiverId: leg.receiverId, lineX: r.lineX, marginM: r.marginM })
  })
  return out
}
