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

import { speedOf } from './defense.js'
import { samplePath, pathLength } from './geometry.js'
import { K } from './constants.js'

// 이 액션이 소비하는 시간(초). resolve.js actionSeconds와 같은 정의 —
// 패스류는 비행시간 + 인지 반응시간, 드리블은 주행시간.
export function actionDuration(action) {
  if (!action) return 0
  const pts = samplePath(action.from, action.ctrl, action.to)
  const L = pathLength(pts)
  const v = K.SPEED[action.type] ?? K.SPEED.pass
  return L / v + (action.type === 'dribble' ? 0 : K.DEF.REACT)
}

// 전력(100%)으로 갈 수 있는 반경(m). 여유 링은 SHEET.EASY_FRAC 배.
export function reachRadius(player, durSec) {
  return speedOf(player) * Math.max(0, durSec)
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
