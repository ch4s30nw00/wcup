// engine/match.js — 스펙 ⑥ 궤적 매칭 (가우시안 신뢰도).
// "정답 궤적"과 유저 궤적의 유사도를 0~100%로 산출한다.
// 튜토리얼 스테이지(예: 안정환 골든골 재현)의 재현 점수에 쓸 예정 — 아직 UI 미연결.
//
//   matchScore(userPts, answerPts, sigma) → 0~100
//
//   각 유저 포인트 k에서 가장 가까운 정답 포인트까지 거리 d_k를 구해
//   s_k = e^(-d_k²/2σ²) 신뢰도의 평균 × 100.
//   σ(감정 튜닝 상수): 크면 관대(경계 좌절 감소), 작으면 엄격.
//
// 스펙은 O(1) 공간 해싱을 제안하지만 포인트 수가 수십 개 수준이라
// 지금은 단순 전수 비교로 충분 — 병목이 되면 그때 그리드 해싱으로 교체.

export function matchScore(userPts, answerPts, sigma = 4) {
  if (!userPts?.length || !answerPts?.length) return 0
  let sum = 0
  for (const u of userPts) {
    let d2 = Infinity
    for (const a of answerPts) {
      const dx = u.x - a.x
      const dy = u.y - a.y
      const dd = dx * dx + dy * dy
      if (dd < d2) d2 = dd
    }
    sum += Math.exp(-d2 / (2 * sigma * sigma))
  }
  return (sum / userPts.length) * 100
}
