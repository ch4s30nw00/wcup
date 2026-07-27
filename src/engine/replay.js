// engine/replay.js — 재현(이스터에그) 판정.
//
// "그날 실제로 있었던 골과 같은 전개였는가"를 본다. 판정 기준은 딱 둘이다:
//   ① 공을 잡은 선수의 순서
//   ② 마지막 슛이 나온 구역
// 궤적은 보지 않는다. 실제 경기의 정확한 경로는 측정 비용이 감당이 안 돼서
// 애초에 데이터로 갖지 않기로 했고, 감독이 축구를 보는 단위도 밀리미터가 아니라
// 순서와 구역이기 때문이다.
//
// 판정 로직이 화면(App.jsx)에 있으면 검증 스크립트가 못 본다. 확률 엔진과 같은 이유로
// 여기 둔다 — 밸런스에 직접 닿는 규칙은 전부 테스트가 붙는 자리에 있어야 한다.

// 구역의 두 반경. 거리축(rx)과 좌우축(ry)이 따로다.
//
// 왜 원이 아니라 타원인가: 중거리 슛은 25m에서 차든 28m에서 차든 그냥 중거리라
// 거리축은 넉넉해야 하지만, 정면에서 찬 것과 완전히 측면에서 찬 건 다른 골이라
// 좌우축은 좁아야 한다. 원은 두 축을 같은 값으로 늘려 이 차이를 뭉갠다 —
// 반경 18m 원이면 측면 17m에서 찬 것도 "엔소의 중거리 재현"으로 통과했다.
//
// tol은 원이던 시절의 단일 반경. 옛 데이터가 남아 있어도 원으로 해석되게 남겨둔다.
export const eggRadii = (shot) => ({
  rx: shot?.rx ?? shot?.tol ?? 12,
  ry: shot?.ry ?? shot?.rx ?? shot?.tol ?? 8,
})

// 슛 지점이 구역 안인가. 축 정렬 타원이다 — 골문이 x=120에 있어 거리축이 곧 x축이다.
export function inShotZone(from, shot) {
  if (!shot || !from) return false
  const { rx, ry } = eggRadii(shot)
  const nx = (from.x - shot.x) / rx
  const ny = (from.y - shot.y) / ry
  return nx * nx + ny * ny <= 1
}

// 공을 잡은 선수 순서. 같은 선수의 연속 액션(드리블 후 패스 등)은 한 번으로 친다 —
// "누구를 거쳐 갔는가"가 기준이지 액션을 몇 번 했는가가 아니다.
export function touchOrder(chain) {
  const out = []
  for (const leg of chain) if (out[out.length - 1] !== leg.actorId) out.push(leg.actorId)
  return out
}

// 재현 성공 여부. chain은 App이 유도한 공 전개 legs, outcome은 판정 결과.
//   egg.sequence 가 있으면 새 방식(순서 + 구역),
//   없으면 구 방식 폴백(골 + 득점자 + 마지막 패스가 passer→scorer).
// shotOverride: 개발 모드에서 마커를 끌어 옮기는 중인 좌표 (없으면 데이터 원본).
export function isReplayMatch({ egg, chain, outcome, shot: shotOverride = null }) {
  if (!egg || outcome !== 'GOAL') return false
  const shotLeg = chain[chain.length - 1]
  if (shotLeg?.type !== 'shot') return false

  if (egg.sequence) {
    const touchers = touchOrder(chain)
    if (touchers.length !== egg.sequence.length) return false
    if (!touchers.every((id, i) => id === egg.sequence[i])) return false
    const zone = shotOverride ?? egg.shot
    // 구역 데이터가 없는 경기는 순서만으로 인정한다 — 좌표를 아직 못 찍었다고
    // 재현 자체가 불가능해지면 안 된다.
    if (zone && !inShotZone(shotLeg.from, zone)) return false
    return true
  }

  if (shotLeg.actorId !== egg.scorerId) return false
  const lastPass = chain.findLast((l) => l.type === 'pass')
  return lastPass?.actorId === egg.passerId && lastPass?.receiverId === egg.scorerId
}
