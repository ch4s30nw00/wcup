// engine/defense.js — 액션 단위 수비 재배치 (CALC_SPEC v2.1 신규).
// 한 패스(드리블)마다 수비수들이 볼 도착점에 반응해 움직인 "다음 판정용 좌표"를 만든다.
//
// 설계 원리 (FM류 매치엔진의 이산 근사):
//   수비는 매 액션마다 조널/마킹/압박 목표를 재계산하고, 그 목표까지
//   "이동 시간 예산(공 비행시간 + 반응시간) × 선수 속도" 만큼만 실제로 이동한다.
//   공은 22m/s, 수비수는 최대 ~7.6m/s — 볼 스피드가 수비 이동력을 항상 이기므로
//   빠른 연속 패스·사이드 전환은 수비가 따라잡지 못한 공간을 남긴다.
//   → "수비 붕괴"는 보정 상수가 아니라 이 기하에서 창발한다 (resolve.js SEQ.FLOW 축소의 근거).
//
// 결정론: 순수 함수(난수 없음). 같은 체인 → 같은 수비 좌표.
//   판정(resolve.js)과 연출(playback.js)이 같은 좌표를 공유한다.
//
//   initDefense(opponents)                    → 수비 상태 배열 (anchor·spd 부여)
//   advanceDefense(defs, { to, durSec, attackers }) → 액션 1개 반영된 새 배열
//     to        — 이번 액션의 볼 도착점
//     durSec    — 이 액션의 이동 시간 예산 (초)
//     attackers — 공격수 현재 좌표 [{id, x, y}] (마킹 대상)

import { K } from './constants.js'

const clamp = (v, min, max) => Math.min(max, Math.max(min, v))

// 수비수 이동 속도: 주력+가속도 평균(FM 1~20)을 [SPD_MIN, SPD_MAX]로 보간
function speedOf(o) {
  const u = ((o.stats?.pace ?? 10) + (o.stats?.acceleration ?? 10)) / 2 / K.STAT.FM_MAX
  return K.DEF.SPD_MIN + (K.DEF.SPD_MAX - K.DEF.SPD_MIN) * u
}

export function initDefense(opponents) {
  return opponents.map((o) => ({ ...o, anchor: { x: o.x, y: o.y }, spd: speedOf(o) }))
}

// 볼 도착점에서 자기 골문(120, 40) 쪽으로 dist만큼 물러난 "골사이드" 지점
function goalSide(pt, dist) {
  const gx = K.GOAL.x - pt.x
  const gy = K.GOAL.y - pt.y
  const gl = Math.hypot(gx, gy) || 1
  return { x: pt.x + (gx / gl) * dist, y: pt.y + (gy / gl) * dist }
}

export function advanceDefense(defs, { to, durSec, attackers = [] }) {
  const C = K.DEF
  const adv = Math.max(0, to.x - 60) // 하프라인 기준 볼 전진량 → 라인 후퇴

  // 압박조: 볼 도착점에 가장 가까운 PRESS_N명 (GK 제외, PRESS_R 안)
  const pressers = new Set(
    defs
      .filter((d) => d.position !== 'GK')
      .map((d) => ({ id: d.id, dist: Math.hypot(d.x - to.x, d.y - to.y) }))
      .filter((e) => e.dist < C.PRESS_R)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, C.PRESS_N)
      .map((e) => e.id),
  )

  return defs.map((d) => {
    let target
    if (d.position === 'GK') {
      // GK: 골문 근처에서 볼 y를 따라 슬라이드
      target = { x: C.GK_X, y: clamp(40 + (to.y - 40) * C.GK_TRACK, 35, 45) }
    } else if (pressers.has(d.id)) {
      // 압박: 볼 도착점의 골사이드로 붙는다
      target = goalSide(to, C.GOALSIDE)
    } else {
      // 마킹(DF·MF만 — FW는 수비 가담 대신 조널): MARK_R 안 최근접 공격수의 골사이드.
      // 없으면 조널(라인 후퇴 + 볼사이드 시프트) — 볼사이드로 쏠린 만큼 반대편이 빈다.
      let mark = null
      if (d.position === 'DF' || d.position === 'MF') {
        for (const a of attackers) {
          const dd = Math.hypot(a.x - d.x, a.y - d.y)
          if (dd < C.MARK_R && (!mark || dd < mark.dd)) mark = { a, dd }
        }
      }
      target = mark
        ? goalSide(mark.a, C.MARK_GOALSIDE)
        : { x: d.anchor.x + C.K_LINE * adv, y: d.anchor.y + C.K_SIDE * (to.y - 40) }
    }

    // 이동 시간 예산 안에서만 목표로 접근 — 여기서 "따라잡지 못한 거리"가 공간이 된다.
    // MOVE_CAP: 아무리 긴 액션이라도 한 액션당 회복 거리는 상한 (공격 우위 유지)
    const tx = clamp(target.x, 1.5, 118.5)
    const ty = clamp(target.y, 1.5, 78.5)
    const maxMove = Math.min(d.spd * C.EFF * Math.max(durSec, 0.15), C.MOVE_CAP)
    const dx = tx - d.x
    const dy = ty - d.y
    const dist = Math.hypot(dx, dy)
    const k = dist <= maxMove ? 1 : maxMove / dist
    return { ...d, x: d.x + dx * k, y: d.y + dy * k }
  })
}
