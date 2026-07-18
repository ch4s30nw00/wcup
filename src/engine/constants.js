// engine/constants.js — CALC_SPEC v2 확정 초기값 (산식확정 보고서 §6, 2026-07-18).
// 모든 매직넘버는 이 한 파일에 모은다. 전부 밸런싱 대상(플레이테스트로 조정).
// 변수(거리·각도·스탯 등)는 여기 없다 — 보드·players.json에서 실시간 계산. 여기엔 가중치만.

export const K = {
  // 전역
  STAT_FLOOR: 0.3, // norm() 하한 — 저능력도 최소 기여 (게임디자인 floor, 보고서 부록 B)
  P_MIN: 0.02, // 전역 clamp — 0%·100% 없음 (기적·실수의 여지)
  P_MAX: 0.97,
  GOAL: { x: 120, y: 40, postA: 43.66, postB: 36.34 },

  // 슈팅 — 로지스틱 xG. z = B0 + B_DIST·D + B_ANG·θ + B_SKILL·(S_eff−SEFF0) + Σ B_BLOCK·e^(−d/R_BLOCK)
  SHOT: {
    B0: -0.03, // 오픈플레이 절편 (앵커 fit)
    B_DIST: -0.2, // 거리 감쇠 /m. 문헌 범위 [−0.1, −0.3] 중앙
    B_ANG: 1.3, // 각도 개방도 /rad (양 포스트 사잇각)
    B_SKILL: 2.0, // 스킬 로그오즈 가중
    SEFF0: 0.7, // 스킬 중심점
    B_BLOCK: -2.5, // 블로커 강도 (라인 위 d=0 → odds ×0.08)
    R_BLOCK: 2.0, // 블로커 위협 반경 m
    PENALTY_XG: 0.76, // D=11 페널티킥 특례 상수 (코어 fit 제외 — PK 상황 도입 시 사용)
  },

  // 패스 — 로그오즈, 리시버 근접 수비가 지배.
  // z = Z0 + B_LEN·L + B_PASS·(S_pass−0.70) + B_RECV·e^(−d_recv/R_RECV) + Σ B_LANE·e^(−d/R_LANE)
  PASS: {
    Z0: 2.933, // 무압박 앵커 절편 (8m→0.90, 20m→0.75, 30m→0.55)
    B_LEN: -0.0917, // 호 길이 감쇠 /m (곡선은 L이 길어져 자연 페널티)
    B_PASS: 1.5,
    B_RECV: -2.0, // 리시버 압박 (지배 레버)
    R_RECV: 4.0,
    B_LANE: -1.0, // 경로 압박 (수비수당, 보조)
    R_LANE: 3.0,
  },

  // 드리블 — 1v1 기하 지배, 능력치는 약한 modifier (근접 1v1 ≈ 0.5)
  DRIB: { Z0: 2.2, B_SKILL: 1.2, B_LEN: -0.06, B_DEF: -2.2, R_DEF: 3.0 },

  // 시퀀스 — 수비 붕괴 계수: 연속 성공당 다음 액션 로그오즈 +FLOW (상한 FLOW_MAX)
  SEQ: { FLOW: 0.25, FLOW_MAX: 2.0 },

  // 궤적 매칭 — 가우시안 커널, 1m 등간격 리샘플링, 임계 ≥90 완전 / 70~90 부분
  MATCH: { SIGMA: 3.0, RESAMPLE_M: 1.0, FULL: 90, PARTIAL: 70 },
}
