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

// 선수 이동 속도: 주력+가속도 평균(FM 1~20)을 [SPD_MIN, SPD_MAX]로 보간.
// 수비 재배치와 시트 UI의 가동범위 동심원이 같은 공식을 써야 "보이는 반경"과
// "실제로 수비가 따라잡는 거리"가 어긋나지 않는다 → export.
export function speedOf(o) {
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

// 압박 대열에서 rank번째 자리.
//
// rank 0 = 볼에 직접 붙는 사람. 1부터는 **커버**다 — 볼-골문 축을 기준으로 좌우로
// 벌리고 조금 더 뒤에 선다. 패스 나갈 길을 막는 자리이지 공을 뺏는 자리가 아니다.
//
// 왜 나누는가: 예전에는 압박조 전원이 goalSide(볼, 1.8) 한 점을 목표로 했다.
// 그래서 인원을 늘리면 같은 자리에 몸이 겹치고, 압박 합산이 같은 공간을 N번 세어
// 박스 안 패스 성공률이 57% → 38%로 내려앉았다. 인원 상한 2는 그 증상을 가린 뚜껑이었다.
// 자리를 나누면 인원을 늘려도 각자 다른 공간을 막으므로 이중계상이 생기지 않는다.
export function pressSlot(pt, rank) {
  const C = K.DEF
  if (rank === 0) return goalSide(pt, C.GOALSIDE)
  const gx = K.GOAL.x - pt.x
  const gy = K.GOAL.y - pt.y
  const gl = Math.hypot(gx, gy) || 1
  const ux = gx / gl
  const uy = gy / gl
  const side = rank % 2 === 1 ? 1 : -1 // 좌우 번갈아
  const tier = Math.ceil(rank / 2) // 1, 1, 2, 2, ...
  const depth = C.GOALSIDE + C.COVER_DEPTH * tier
  const spread = C.COVER_SPREAD * tier
  return { x: pt.x + ux * depth - uy * side * spread, y: pt.y + uy * depth + ux * side * spread }
}

export function isSetPieceAction({ from } = {}) {
  const C = K.DEF
  return !!from && from.x >= C.SET_PIECE_X && (from.y <= C.SET_PIECE_EDGE_Y || from.y >= 80 - C.SET_PIECE_EDGE_Y)
}

export function advanceDefense(defs, { from = null, to, durSec, attackers = [] }) {
  const C = K.DEF
  const special = isSetPieceAction({ from })
  const adv = Math.max(0, to.x - 60) // 하프라인 기준 볼 전진량 → 라인 후퇴

  // 압박 대열: 볼 도착점에서 PRESS_R 안에 있는 수비수들 (GK 제외), 가까운 순으로 자리를 받는다.
  // 인원 상한(PRESS_N)은 "몇 명이 압박하는가"가 아니라 "압박 자리가 몇 개인가"다 —
  // 그 뒤 순번은 압박이 아니라 마킹·조널로 간다. 실제 수비도 전원이 공에 달려들지 않는다.
  const pressRank = new Map()
  defs
    .filter((d) => d.position !== 'GK')
    .map((d) => ({ id: d.id, dist: Math.hypot(d.x - to.x, d.y - to.y) }))
    .filter((e) => e.dist < C.PRESS_R)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, special ? C.SET_PIECE_PRESS_N : C.PRESS_N)
    .forEach((e, i) => pressRank.set(e.id, i))

  // 공에 붙을 수 있는 기존 압박조가 없으면, 복귀 중인 선수 가운데 공과 가장
  // 가까운 한 명만 볼 소유자를 맡는다. 나머지는 자기 수비 대형을 회복한다.
  const recoveryMarkerId = !special && pressRank.size === 0
    ? defs
        .filter((d) => d.position !== 'GK')
        .filter((d) => {
          const roleFloorX = C.FORMATION_X[d.position] ?? d.anchor.x
          return d.x < roleFloorX - C.FORMATION_RECOVERY_DISTANCE
        })
        .map((d) => ({ id: d.id, dist: Math.hypot(d.x - to.x, d.y - to.y) }))
        .sort((a, b) => a.dist - b.dist)[0]?.id ?? null
    : null

  return defs.map((d) => {
    let formationTarget = null
    let target
    const roleFloorX = C.FORMATION_X[d.position] ?? d.anchor.x
    const needsDeepRecovery =
      !special &&
      d.position !== 'GK' &&
      d.x < roleFloorX - C.FORMATION_RECOVERY_DISTANCE &&
      !pressRank.has(d.id)
    if (d.position === 'GK') {
      // GK: 골문 근처에서 볼 y를 따라 슬라이드
      target = { x: C.GK_X, y: clamp(40 + (to.y - 40) * C.GK_TRACK, 35, 45) }
    } else if (pressRank.has(d.id)) {
      // 압박 대열: 0번은 볼에 붙고, 뒤 순번은 좌우로 벌려 커버한다 (pressSlot 참고)
      target = pressSlot(to, pressRank.get(d.id))
    } else if (d.id === recoveryMarkerId) {
      target = goalSide(to, C.RECOVERY_MARK_GOALSIDE)
    } else {
      // 마킹(DF·MF만 — FW는 수비 가담 대신 조널): MARK_R 안 최근접 공격수의 골사이드.
      // 없으면 조널(라인 후퇴 + 볼사이드 시프트) — 볼사이드로 쏠린 만큼 반대편이 빈다.
      formationTarget = {
        x: special
          ? d.anchor.x + C.K_LINE * adv * 0.25
          : Math.max(d.anchor.x + C.K_LINE * adv, roleFloorX + C.FORMATION_BALL_SHIFT * adv),
        y: d.anchor.y + C.K_SIDE * (to.y - 40) * (special ? 0.25 : 1),
      }
      let mark = null
      if (!needsDeepRecovery && (d.position === 'DF' || d.position === 'MF')) {
        for (const a of attackers) {
          const dd = Math.hypot(a.x - d.x, a.y - d.y)
          if (dd < C.MARK_R && (!mark || dd < mark.dd)) mark = { a, dd }
        }
      }
      const markTarget = mark ? goalSide(mark.a, C.MARK_GOALSIDE) : null
      target = markTarget && special
        ? {
            x: formationTarget.x + (markTarget.x - formationTarget.x) * C.SET_PIECE_MARK_BLEND,
            y: formationTarget.y + (markTarget.y - formationTarget.y) * C.SET_PIECE_MARK_BLEND,
          }
        : markTarget ?? formationTarget
    }

    // 이동 시간 예산 안에서만 목표로 접근 — 여기서 "따라잡지 못한 거리"가 공간이 된다.
    // MOVE_CAP: 아무리 긴 액션이라도 한 액션당 회복 거리는 상한 (공격 우위 유지)
    const tx = clamp(target.x, 1.5, 118.5)
    const ty = clamp(target.y, 1.5, 78.5)
    const formationGap = formationTarget ? Math.hypot(formationTarget.x - d.x, formationTarget.y - d.y) : 0
    const recoveryBoost = needsDeepRecovery ||
      (!special && !pressRank.has(d.id) && formationGap > C.FORMATION_RECOVERY_DISTANCE)
      ? C.FORMATION_RECOVERY_BOOST
      : 1
    const moveCap = needsDeepRecovery ? C.RECOVERY_MOVE_CAP : C.MOVE_CAP
    const maxMove = Math.min(
      d.spd * C.EFF * recoveryBoost * Math.max(durSec, 0.15),
      moveCap * (special ? C.SET_PIECE_MOVE_SCALE : 1),
    )
    const dx = tx - d.x
    const dy = ty - d.y
    const dist = Math.hypot(dx, dy)
    const k = dist <= maxMove ? 1 : maxMove / dist
    return { ...d, x: d.x + dx * k, y: d.y + dy * k }
  })
}
