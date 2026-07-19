// engine/xt.js — Expected Threat (xT) 정적 그리드 + 플레이 설계 점수(PlanScore).
//
// 목적: "이 설계가 얼마나 좋은 전개인가"를 판정(확률)과 **독립적으로** 보여준다.
// 주사위가 어떻게 굴렀든, 위협적인 위치로 공을 옮긴 설계는 좋은 설계다.
// 실시간 성공률 % 프리뷰를 넣지 않기로 한 것과 같은 결 — 확률은 감추되,
// "공간을 얼마나 잘 만들었나"라는 축은 보여준다.
//
//   PlanScore = Σ_k ( xT[도착 존] − xT[출발 존] )   (체인 각 스텝의 델타 합)
//
// xT 정의 (Karun Singh, 2019)의 벨만 재귀:
//   xT(z) = s_z·g_z + m_z·ρ·Σ_z' T(z→z')·xT(z')
//     s_z — 그 존에서 슛을 시도할 확률,  g_z — 슛했을 때 득점 확률
//     m_z — 공을 옮길 확률(= 1 − s_z),  T  — 이동 전이 행렬
//     ρ   — 액션 1회를 버티고 공을 지킬 확률 (K.XT.RETAIN)
//
// ⚠️ ρ(소유 유지율)가 왜 필요한가 — 처음엔 원식 그대로 ρ 없이 짰는데, 그리드가
//   x=10부터 x=100까지 전부 0.178로 **평평하게** 나왔다. 소유권을 잃는 항이 없으면
//   "언젠가는 반드시 슛까지 간다"는 뜻이 되어, 몇 번을 거쳐 가든 기대값이 같아지고
//   값이 균일점으로 확산돼 버린다. 실측 xT는 T를 실제 데이터에서 뽑기 때문에
//   턴오버가 자연히 반영되지만, 여기선 T를 모수화했으므로 명시적으로 넣어야 한다.
//   ρ를 넣으면 골문에서 먼 존일수록 "더 많은 액션 = 더 많은 상실 위험"을 거쳐야 해
//   값이 기하급수적으로 감쇠하고, 비로소 전진에 의미 있는 기울기가 생긴다.
//
// ⚠️ 데이터 출처에 대한 정직한 기록:
//   원래 xT는 실제 경기 이벤트 데이터로 s·g·T를 추정한다. 이 프로젝트에는 그 데이터가
//   없으므로, **이 엔진 자신의 슛 모델(K.SHOT 로지스틱)에서 g_z를 뽑고**, s_z와 T는
//   축구의 일반적 경향(골에 가까울수록 슛 시도↑, 이동은 전진 편향 + 거리 감쇠)을
//   모수화해 만들었다. 즉 이 그리드는 "실측 xT"가 아니라 **이 게임의 슛 모델과
//   일관된 위협 지도**다. 실제 이벤트 데이터가 확보되면 s_z·T를 교체하면 된다.
//   (판정에는 전혀 쓰이지 않으므로 교체해도 앵커·밸런스에 영향이 없다.)

import { K } from './constants.js'

const NX = K.XT.NX // 16 (x 방향 존 수)
const NY = K.XT.NY // 12 (y 방향)
const CW = 120 / NX // 존 하나의 가로 (m)
const CH = 80 / NY // 세로

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const sigmoid = (z) => 1 / (1 + Math.exp(-z))

// (x, y) → 존 인덱스. 피치 밖 좌표는 가장자리로 클램프.
export function zoneOf(x, y) {
  const ix = clamp(Math.floor(x / CW), 0, NX - 1)
  const iy = clamp(Math.floor(y / CH), 0, NY - 1)
  return iy * NX + ix
}
// 존 인덱스 → 존 중심 좌표
export function zoneCenter(z) {
  const ix = z % NX
  const iy = Math.floor(z / NX)
  return { x: (ix + 0.5) * CW, y: (iy + 0.5) * CH }
}

// g_z — 그 존 중심에서 무압박·중립 스탯으로 쐈을 때의 득점 확률.
// resolve.js calcShot과 같은 식(K.SHOT)을 쓰되 수비·스킬 항을 중립으로 둔다.
// (스킬 중립 = S_eff가 SEFF0와 같아 스킬 항이 0이 되는 지점)
function goalProbAt({ x, y }) {
  const C = K.SHOT
  const D = Math.hypot(K.GOAL.x - x, K.GOAL.y - y)
  const a1 = Math.atan2(K.GOAL.postA - y, K.GOAL.x - x)
  const a2 = Math.atan2(K.GOAL.postB - y, K.GOAL.x - x)
  let theta = Math.abs(a1 - a2)
  if (theta > Math.PI) theta = 2 * Math.PI - theta
  return clamp(sigmoid(C.B0 + C.B_DIST * D + C.B_ANG * theta), K.P_MIN, K.P_MAX)
}

// s_z — 슛 시도 확률. 골에 가까울수록 급격히 커진다 (지수 감쇠, SHOT_R로 조절).
// 상대 진영이 아니면 사실상 0 — 자기 진영에서 슛하는 설계를 보상하지 않는다.
function shotRateAt({ x, y }) {
  const D = Math.hypot(K.GOAL.x - x, K.GOAL.y - y)
  const base = K.XT.SHOT_MAX * Math.exp(-D / K.XT.SHOT_R)
  return clamp(base, 0, K.XT.SHOT_MAX)
}

// T(z→z') — 이동 전이 확률. 실제 패스·드리블 분포 대신
// "거리 감쇠 × 전진 편향"으로 근사한다. 행 단위로 정규화.
function buildTransitions() {
  const T = []
  for (let z = 0; z < NX * NY; z++) {
    const a = zoneCenter(z)
    const row = new Float64Array(NX * NY)
    let sum = 0
    for (let z2 = 0; z2 < NX * NY; z2++) {
      if (z2 === z) continue
      const b = zoneCenter(z2)
      const d = Math.hypot(b.x - a.x, b.y - a.y)
      if (d > K.XT.MOVE_MAX) continue // 아주 먼 이동은 후보에서 제외
      // 거리 감쇠 — 짧은 이동이 압도적으로 흔하다
      let w = Math.exp(-d / K.XT.MOVE_R)
      // 전진 편향 — 앞으로 가는 이동에 가중, 뒤로 가는 이동은 감쇠
      const fwd = (b.x - a.x) / (d || 1)
      w *= 1 + K.XT.FWD_BIAS * fwd
      if (w <= 0) continue
      row[z2] = w
      sum += w
    }
    if (sum > 0) for (let i = 0; i < row.length; i++) row[i] /= sum
    T.push(row)
  }
  return T
}

// 벨만 재귀를 수렴할 때까지 반복해 정적 xT 그리드를 만든다.
// 16×12=192존이라 수십 회 반복해도 순식간 — 모듈 로드 시 1회 프리컴퓨트.
function computeGrid() {
  const n = NX * NY
  const T = buildTransitions()
  const s = new Float64Array(n)
  const g = new Float64Array(n)
  for (let z = 0; z < n; z++) {
    const c = zoneCenter(z)
    s[z] = shotRateAt(c)
    g[z] = goalProbAt(c)
  }
  let xt = new Float64Array(n)
  for (let iter = 0; iter < K.XT.ITERS; iter++) {
    const next = new Float64Array(n)
    let maxDelta = 0
    for (let z = 0; z < n; z++) {
      let moveVal = 0
      const row = T[z]
      for (let z2 = 0; z2 < n; z2++) if (row[z2]) moveVal += row[z2] * xt[z2]
      next[z] = s[z] * g[z] + (1 - s[z]) * K.XT.RETAIN * moveVal
      maxDelta = Math.max(maxDelta, Math.abs(next[z] - xt[z]))
    }
    xt = next
    if (maxDelta < K.XT.EPS) break
  }
  return xt
}

// 정적 그리드 — 상수만으로 결정되므로 모듈 로드 시 한 번만 계산한다.
export const XT_GRID = computeGrid()

// 좌표의 xT 값
export function xtAt(pt) {
  return XT_GRID[zoneOf(pt.x, pt.y)]
}

// 체인 각 스텝의 xT 델타와 그 합 = 플레이 설계 점수.
//   legs — [{ type, from, to }] (App이 유도한 체인 그대로)
// → { total, steps: [{ index, type, from, to, delta }] }
// 판정과 완전히 독립 — 확률도, 난수도, 수비 좌표도 보지 않는다.
export function planScore(legs) {
  const steps = (legs ?? []).map((leg, index) => {
    const before = xtAt(leg.from)
    const after = xtAt(leg.to)
    return { index, type: leg.type, delta: after - before, before, after }
  })
  return { total: steps.reduce((m, s) => m + s.delta, 0), steps }
}

// 표시용 등급 — 숫자만 보면 감이 안 오므로 한 줄 평가를 붙인다.
export function planGrade(total) {
  const G = K.XT.GRADES
  if (total >= G.S) return { label: 'S', text: '결정적 — 골문 앞까지 위협을 끌어올렸습니다' }
  if (total >= G.A) return { label: 'A', text: '날카로운 전진 — 위협적인 지역을 만들었습니다' }
  if (total >= G.B) return { label: 'B', text: '무난한 전진' }
  if (total >= G.C) return { label: 'C', text: '위협 증가가 크지 않습니다' }
  return { label: 'D', text: '뒤로 돌거나 제자리 — 위협이 줄었습니다' }
}
