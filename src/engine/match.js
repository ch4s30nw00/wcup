// engine/match.js — 궤적 매칭 (가우시안 커널, CALC_SPEC v2 §4.6).
// "정답 궤적"과 유저 궤적의 유사도를 0~100%로 산출한다.
// 튜토리얼 스테이지(예: 안정환 골든골 재현)의 재현 점수에 쓸 예정 — 아직 UI 미연결.
//
//   matchScore(userPts, answerPts, sigma) → 0~100
//
//   양쪽 궤적을 1m 등간격으로 리샘플링($1 Recognizer 방식 — 간격이 다르면 점수 왜곡)한 뒤,
//   각 유저 포인트 k의 최근접 정답점 거리 d_k로 s_k = e^(-d_k²/2σ²) 신뢰도 평균 × 100.
//   σ=3m 확정: 편차 1/2/3/5m → 0.95/0.80/0.61/0.25. 2σ=6m(명백한 빗나감)가 실패 임계 근처.
//   임계: ≥K.MATCH.FULL 완전 재현 · K.MATCH.PARTIAL~ 부분 재현.

import { K } from './constants.js'

// 폴리라인을 등간격(spacing, 미터)으로 리샘플링. 시작·끝점은 보존된다.
export function resampleEquidistant(pts, spacing = K.MATCH.RESAMPLE_M) {
  if (!pts?.length) return []
  const out = [pts[0]]
  let carry = 0 // 직전 세그먼트에서 소비하고 남은 거리
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1]
    const b = pts[i]
    let seg = Math.hypot(b.x - a.x, b.y - a.y)
    while (carry + seg >= spacing) {
      const t = (spacing - carry) / seg
      a = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      out.push(a)
      seg = Math.hypot(b.x - a.x, b.y - a.y)
      carry = 0
    }
    carry += seg
  }
  const last = pts[pts.length - 1]
  const tail = out[out.length - 1]
  if (Math.hypot(last.x - tail.x, last.y - tail.y) > 1e-9) out.push(last)
  return out
}

export function matchScore(userPts, answerPts, sigma = K.MATCH.SIGMA) {
  const user = resampleEquidistant(userPts)
  const answer = resampleEquidistant(answerPts)
  if (!user.length || !answer.length) return 0
  let sum = 0
  for (const u of user) {
    let d2 = Infinity
    for (const a of answer) {
      const dx = u.x - a.x
      const dy = u.y - a.y
      const dd = dx * dx + dy * dy
      if (dd < d2) d2 = dd
    }
    sum += Math.exp(-d2 / (2 * sigma * sigma))
  }
  return (sum / user.length) * 100
}
