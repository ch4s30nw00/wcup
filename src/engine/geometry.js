// engine/geometry.js — 궤적(2차 베지어)과 거리 계산 공통 부품.
// UI(궤적 렌더링·핸들)와 판정 엔진이 같은 수식을 쓰도록 한 곳에 모아둔다.

import { K } from './constants.js'

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

// --- 곡률 상한 -------------------------------------------------------------
// 곡률 핸들에 상한이 없으면 반원에 가까운 궤적으로 수비를 통째로 우회할 수 있다.
// 판정은 그 궤적을 그대로 믿으므로(수비 압박 = 경로까지의 거리) "말도 안 되게 휘면
// 확률이 후해지는" 구멍이 된다. 그래서 여기서 물리적으로 가능한 만큼만 남기고 자른다.
//
// 자르는 위치는 이 함수 하나 — UI(드래그), 체인 유도(공유 링크·옛 저장분), 판정이
// 전부 같은 상한을 통과한 ctrl을 본다. 화면의 궤적과 판정의 궤적은 언제나 같다.

// 감아 차는 폭의 개인차 계수 — 벽을 넘겨 감는 건 기술이다 (K.BEND.SKILL_* 참고).
// player를 안 주면 1을 돌려주므로, 기하만 알면 되는 호출부(검증 하네스 등)는
// 예전 그대로 쓸 수 있다.
// norm()은 resolve.js에도 있지만 여기서 가져오면 순환 import가 된다 (resolve → geometry).
const normStat = (v) => K.STAT_FLOOR + (1 - K.STAT_FLOOR) * (v / K.STAT.FM_MAX)
const bendSkill = (player) => {
  const mix = K.BEND.SKILL_MIX
  return normStat(mix.crossing * player.stats.crossing + mix.flair * player.stats.flair)
}
export function bendSkillFactor(player, kind = 'pass') {
  const B = K.BEND
  if (!B.SKILL_KINDS[kind] || !player?.stats) return 1
  const f = 1 + B.SKILL_GAIN * (bendSkill(player) - K.STAT.MID)
  return Math.min(B.SKILL_MAX, Math.max(B.SKILL_MIN, f))
}

// 휜 만큼 늘어난 거리에 곱하는 대가 계수 — 발기술이 좋으면 같은 휨이 싸다.
// 상한(bendSkillFactor)과 반대 방향이다: 스킬이 높을수록 1보다 **작아진다**.
export function bendCostFactor(player) {
  const B = K.BEND
  if (!player?.stats) return 1
  const f = 1 - B.COST_GAIN * (bendSkill(player) - K.STAT.MID)
  return Math.min(B.COST_MAX, Math.max(B.COST_MIN, f))
}

// 이 액션이 허용하는 최대 새지타(현 중점 ↔ 곡선 중점 거리) m.
// 거리 비례라 가까우면 조금, 멀수록 크게 휜다 — 절대 상한은 두지 않는다.
export function maxBend(chordLen, kind = 'pass', player = null) {
  const B = K.BEND
  const ratio = (B.RATIO[kind] ?? B.RATIO.pass) * bendSkillFactor(player, kind)
  return Math.max(B.MIN_M, ratio * chordLen)
}

// 곡률 핸들 위치를 허용 범위 안으로 당긴다.
// 휨(좌우) 방향은 유지하고 깊이만 상한까지, 앞뒤(현 방향)는 K.BEND.ALONG까지 —
// 패스·슛은 ALONG=0이라 핸들이 궤적 가운데에 고정되고 좌우로만 움직인다.
export function clampHandle(a, b, h, kind = 'pass', player = null) {
  const m = midpoint(a, b)
  const dx = b.x - a.x
  const dy = b.y - a.y
  const chord = Math.hypot(dx, dy)
  if (chord < 1e-6) return m // 시작=끝이면 휨을 정의할 수 없다
  const ux = dx / chord
  const uy = dy / chord
  const ox = h.x - m.x
  const oy = h.y - m.y
  // 현 방향(along)과 수직 방향(perp = 휨)으로 분해 — 부호를 남겨 좌/우 방향은 보존
  const lim = (v, max) => Math.min(max, Math.max(-max, v))
  const along = lim(ox * ux + oy * uy, (K.BEND.ALONG[kind] ?? 0) * chord)
  const perp = lim(-ox * uy + oy * ux, maxBend(chord, kind, player))
  return { x: m.x + ux * along - uy * perp, y: m.y + uy * along + ux * perp }
}

// 제어점을 허용 범위 안으로. ctrl이 없으면 직선(중점)을 돌려주므로
// `ctrl ?? midpoint(from, to)` 자리를 그대로 대체할 수 있다.
export function clampCtrl(a, b, ctrl, kind = 'pass', player = null) {
  if (!ctrl) return midpoint(a, b)
  return ctrlFromHandle(a, b, clampHandle(a, b, handleFromCtrl(a, ctrl, b), kind, player))
}
