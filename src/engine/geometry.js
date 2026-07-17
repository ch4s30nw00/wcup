// engine/geometry.js — 궤적(2차 베지어)과 거리 계산 공통 부품.
// UI(궤적 렌더링·핸들)와 판정 엔진이 같은 수식을 쓰도록 한 곳에 모아둔다.

export function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

// 2차 베지어 위의 점 (a: 시작, c: 제어점, b: 끝, t ∈ [0,1])
export function quadPoint(a, c, b, t) {
  const u = 1 - t
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  }
}

// 곡선을 폴리라인으로 근사 — 판정(수비수 거리)과 애니메이션(공 이동)이 공용
export function samplePath(a, c, b, n = 32) {
  const pts = []
  for (let i = 0; i <= n; i++) pts.push(quadPoint(a, c, b, i / n))
  return pts
}

export function pathLength(pts) {
  let len = 0
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  }
  return len
}

// 경로 시작점에서 dist만큼 진행한 지점 (dist가 전체 길이를 넘으면 끝점)
export function pointAtLength(pts, dist) {
  if (dist <= 0) return pts[0]
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    if (acc + seg >= dist) {
      const t = seg === 0 ? 0 : (dist - acc) / seg
      return {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t,
      }
    }
    acc += seg
  }
  return pts[pts.length - 1]
}

// 점-선분 최단거리 (산술식 문서 ①: 벡터 내적 사영, t는 [0,1] clamp)
export function segPointDist(a, b, c) {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const len2 = abx * abx + aby * aby
  const raw = len2 === 0 ? 0 : ((c.x - a.x) * abx + (c.y - a.y) * aby) / len2
  const t = Math.min(1, Math.max(0, raw))
  const p = { x: a.x + t * abx, y: a.y + t * aby }
  return { d: Math.hypot(c.x - p.x, c.y - p.y), point: p, t }
}

// 폴리라인 전체에서 점 c까지 최단거리 + 그 지점이 경로의 몇 % 지점인지(frac)
export function minDistToPath(pts, c) {
  const total = pathLength(pts) || 1
  let best = { d: Infinity, point: pts[0], frac: 0 }
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    const r = segPointDist(pts[i - 1], pts[i], c)
    if (r.d < best.d) best = { d: r.d, point: r.point, frac: (acc + r.t * seg) / total }
    acc += seg
  }
  return best
}

// 곡률 핸들(곡선 위 t=0.5 지점) ↔ 베지어 제어점 변환
export function handleFromCtrl(a, c, b) {
  return quadPoint(a, c, b, 0.5)
}
export function ctrlFromHandle(a, b, h) {
  return { x: 2 * h.x - (a.x + b.x) / 2, y: 2 * h.y - (a.y + b.y) / 2 }
}
