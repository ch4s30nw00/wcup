import { useRef, useState } from 'react'
import { quadPoint, handleFromCtrl } from '../engine/geometry'

// StatsBomb 좌표계와 동일한 120x80 피치. x: 0(우리 골대) → 120(상대 골대)
const PITCH_W = 120
const PITCH_H = 80
const DOT_R = 1.4
const LEG_COLOR = { dribble: '#dbe4f2', pass: '#ffd23e', shot: '#ff6b5e' }
const LEG_MARKER = { dribble: 'url(#ah-move)', pass: 'url(#ah-pass)', shot: 'url(#ah-shot)' }

// 터치 화면은 손가락 기준 — 보이지 않는 히트 영역과 클릭/드래그 판정 거리를 키운다.
// 공은 소유자에게서 조금 더 떨어뜨려 그려 드리블(선수)과 패스(공) 터치를 분리한다.
const COARSE = window.matchMedia?.('(pointer: coarse)').matches ?? false
const BALL_OFFSET = COARSE ? { x: 2.3, y: -2.3 } : { x: 1.3, y: -1.3 } // 공을 소유자 발밑에 그리는 오프셋
const HIT = COARSE
  ? { player: DOT_R + 3.2, ball: 2.5, handle: 3.2, slopPx: 7 }
  : { player: DOT_R + 1.4, ball: 1.5, handle: 2, slopPx: 4 }

// 슛 조준: 골문 안 y 범위(기존 드롭존과 같은 클램프) + 조준 히트 영역.
// 히트 영역을 골문보다 넉넉히 잡아 손가락으로도 겨눌 수 있게 한다.
const GOAL_AIM = { y0: 36.5, y1: 43.5, hitX: 108, hitY0: 28, hitY1: 52 }
// 액션 메뉴 한 칸 크기 (피치 단위) — 2×2 배치
const MENU = COARSE ? { w: 15, h: 7.5 } : { w: 13, h: 6.5 }

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v))
}

function qPath(from, ctrl, to) {
  return `M ${from.x} ${from.y} Q ${ctrl.x} ${ctrl.y} ${to.x} ${to.y}`
}

export default function TacticsBoard({
  players,
  opponents,
  runLegs, // 오프볼 런 legs: [{ id, from, to, ctrl }] — from은 체인 반영 앵커
  chain, // 공 전개 체인 legs (App에서 유도, index 포함)
  planPos, // 계획상 각 선수의 최종 위치 (id → {x,y})
  carrierId, // 체인 끝에서 공을 갖게 될 선수 — 이 선수를 드래그하면 드리블
  shotTaken,
  ballPos,
  ballTrail, // 재생 중 공 트레일 [{x,y}] — 빠른 패스·슛의 혜성 꼬리 (평시 null)
  displayHome, // 재생 중 애니메이션 위치 (id → {x,y,a}), 평시 null
  displayOpp,
  interactive,
  defRadius,
  selectedId,
  onPlayerClick,
  onRunSet,
  onRunRemove,
  onRunHandle,
  onDribbleSet, // (pt, isFirst)
  onDribbleDrop, // (pt)
  onChainHandle, // (chainIndex, handlePt)
  onPassCommit, // (receiverId | 'GOAL', toForGoal)
}) {
  const svgRef = useRef(null)
  const dragRef = useRef(null) // { kind: 'run'|'dribble'|'ball'|'rhandle'|'chandle', key, startX, startY, moved }
  const [ballDrag, setBallDrag] = useState(null)
  const [dragging, setDragging] = useState(false)
  // 공 소유자 탭 → 액션 메뉴. mode는 메뉴에서 고른 뒤 "대상을 찍는" 단계.
  //   null | 'dribble'(도착점 탭) | 'pass'(동료 탭) | 'shot'(골문 안 y 조준)
  const [menuOpen, setMenuOpen] = useState(false)
  const [mode, setMode] = useState(null)
  const [aimY, setAimY] = useState(40)

  const closeMenu = () => {
    setMenuOpen(false)
    setMode(null)
  }

  const baseOf = Object.fromEntries(players.map((p) => [p.id, { x: p.x, y: p.y }]))
  const homePos = (p) => (displayHome ? (displayHome[p.id] ?? baseOf[p.id]) : planPos[p.id])
  const oppPos = (o) => (displayOpp ? (displayOpp[o.id] ?? { x: o.x, y: o.y }) : { x: o.x, y: o.y })

  // 바라보는 방향 (도 단위) — 재생 중엔 playback이 넣어준 각도(pos.a), 계획 중엔
  // 공 방향을 본다. 공 소유자는 공이 발밑이라 방향이 무의미 → 상대 골문을 본다.
  const facingDeg = (pos, id) => {
    if (pos.a != null) return (pos.a * 180) / Math.PI
    if (!ballPos) return 0
    const tgt = id === carrierId ? { x: 120, y: 40 } : ballPos
    return (Math.atan2(tgt.y - pos.y, tgt.x - pos.x) * 180) / Math.PI
  }

  function toPitch(e) {
    const rect = svgRef.current.getBoundingClientRect()
    return {
      x: clamp(((e.clientX - rect.left) / rect.width) * PITCH_W, 1.5, PITCH_W - 1.5),
      y: clamp(((e.clientY - rect.top) / rect.height) * PITCH_H, 1.5, PITCH_H - 1.5),
    }
  }

  function startDrag(e, kind, key) {
    if (!interactive) return
    e.stopPropagation()
    e.target.setPointerCapture(e.pointerId)
    dragRef.current = { kind, key, startX: e.clientX, startY: e.clientY, moved: false }
  }

  function handleMove(e) {
    const d = dragRef.current
    if (!d) return
    // 살짝 흔들린 클릭은 드래그로 치지 않는다
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < HIT.slopPx) return
      d.moved = true
      setDragging(true)
    }
    const pt = toPitch(e)
    if (d.kind === 'run') {
      onRunSet(d.key, pt, !d.began)
      d.began = true
    } else if (d.kind === 'dribble') {
      onDribbleSet(pt, !d.began)
      d.began = true
    } else if (d.kind === 'ball') setBallDrag(pt)
    else if (d.kind === 'rhandle') onRunHandle(d.key, pt)
    else if (d.kind === 'chandle') onChainHandle(d.key, pt)
    else if (d.kind === 'aim') setAimY(clamp(pt.y, GOAL_AIM.y0, GOAL_AIM.y1))
  }

  function endDrag(e) {
    const d = dragRef.current
    dragRef.current = null
    setDragging(false)
    if (!d) return
    if (d.kind === 'aim') {
      // 조준을 놓는 순간 슛 확정 — 골문 안 y로 클램프된 좌표를 그대로 넘긴다
      closeMenu()
      return onPassCommit('GOAL', { x: 119, y: clamp(aimY, GOAL_AIM.y0, GOAL_AIM.y1) })
    }
    if (d.kind === 'run') {
      // 패스 조준 중이면 동료 탭이 곧 패스 대상 선택
      if (!d.moved && mode === 'pass') {
        closeMenu()
        return onPassCommit(d.key, null)
      }
      if (!d.moved) return onPlayerClick(d.key)
      // 목표 원을 출발 지점(앵커) 근처로 되돌리면 지시 취소 — 방금 편집한(마지막) 런 기준
      const rls = runLegs.filter((r) => r.id === d.key)
      const rl = rls[rls.length - 1]
      if (rl && Math.hypot(rl.to.x - rl.from.x, rl.to.y - rl.from.y) < 3.5) onRunRemove(rl.key)
    } else if (d.kind === 'dribble') {
      // 공 소유자 탭(드래그 아님) = 액션 메뉴. 드래그는 기존대로 즉시 드리블.
      if (!d.moved) {
        setMenuOpen((v) => !v)
        setMode(null)
        return
      }
      closeMenu()
      onDribbleDrop(toPitch(e))
    } else if (d.kind === 'ball') {
      setBallDrag(null)
      if (!d.moved) return
      // 공 드래그는 패스 전용 — "골문 앞에 놓으면 슛"은 제거됐다(슛은 액션 메뉴로).
      const pt = toPitch(e)
      let best = null
      for (const p of players) {
        if (p.id === carrierId) continue
        const fp = planPos[p.id]
        const dd = Math.hypot(fp.x - pt.x, fp.y - pt.y)
        if (dd < 9 && (!best || dd < best.d)) best = { d: dd, id: p.id }
      }
      if (best) onPassCommit(best.id, null)
    }
  }

  // 빈 잔디 탭 — 드리블 조준 중이면 그 지점이 도착점, 아니면 메뉴를 닫는다
  function boardDown(e) {
    if (!interactive) return
    if (mode === 'dribble') {
      onDribbleSet(toPitch(e), true)
      closeMenu()
      return
    }
    closeMenu()
  }

  // 슛 조준 — 골문 안 y만 정한다 (기존과 같은 36.5~43.5 클램프)
  function aimDown(e) {
    e.stopPropagation()
    e.target.setPointerCapture(e.pointerId)
    dragRef.current = { kind: 'aim', startX: e.clientX, startY: e.clientY, moved: true }
    setAimY(clamp(toPitch(e).y, GOAL_AIM.y0, GOAL_AIM.y1))
  }

  // 터치가 시스템 제스처 등으로 취소되면 진행 중이던 드래그를 커밋 없이 버린다
  function cancelDrag() {
    dragRef.current = null
    setDragging(false)
    setBallDrag(null)
  }

  const showAuras = interactive && (dragging || ballDrag)
  // 메뉴·조준 UI의 기준점 = 체인 끝에서 공을 갖게 될 선수의 계획상 위치
  const carrierPos = carrierId ? planPos[carrierId] : null

  return (
    <svg
      ref={svgRef}
      className="tactics-board"
      viewBox={`0 0 ${PITCH_W} ${PITCH_H}`}
      onPointerDown={boardDown}
      onPointerMove={handleMove}
      onPointerUp={endDrag}
      onPointerCancel={cancelDrag}
    >
      <defs>
        {['ah-pass', 'ah-move', 'ah-shot'].map((id) => (
          <marker
            key={id}
            id={id}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="4"
            markerHeight="4"
            orient="auto-start-reverse"
          >
            <path
              d="M 0 0 L 10 5 L 0 10 z"
              fill={id === 'ah-pass' ? '#ffd23e' : id === 'ah-shot' ? '#ff6b5e' : '#dbe4f2'}
            />
          </marker>
        ))}
        <filter id="ghostBlur" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="0.3" />
        </filter>
      </defs>

      {/* 잔디 */}
      <rect width={PITCH_W} height={PITCH_H} fill="#2f7d3f" />
      {[0, 2, 4, 6, 8].map((i) => (
        <rect key={i} x={i * 24} width={12} height={PITCH_H} fill="#2a7339" />
      ))}

      {/* 라인 */}
      <g stroke="#e6f2e6" strokeWidth="0.5" fill="none" opacity="0.9">
        <rect x="1" y="1" width={PITCH_W - 2} height={PITCH_H - 2} />
        <line x1="60" y1="1" x2="60" y2={PITCH_H - 1} />
        <circle cx="60" cy="40" r="9.15" />
        <circle cx="60" cy="40" r="0.6" fill="#e6f2e6" />
        {/* 페널티박스 (좌/우) */}
        <rect x="1" y="18" width="17" height="44" />
        <rect x={PITCH_W - 18} y="18" width="17" height="44" />
        <rect x="1" y="30" width="5.5" height="20" />
        <rect x={PITCH_W - 6.5} y="30" width="5.5" height="20" />
        <circle cx="13" cy="40" r="0.6" fill="#e6f2e6" />
        <circle cx={PITCH_W - 13} cy="40" r="0.6" fill="#e6f2e6" />
      </g>

      {/* 상대 골문 */}
      <rect x={118.6} y={36.34} width={1.4} height={7.32} fill="#10141c" stroke="#e6f2e6" strokeWidth="0.35" />

      {/* 수비 반경 오라 — 궤적 입력 중에만 흐리게 표시 */}
      {showAuras &&
        opponents.map((o) => {
          const pos = oppPos(o)
          return (
            <circle
              key={`aura-${o.id}`}
              cx={pos.x}
              cy={pos.y}
              r={defRadius}
              fill="rgba(255, 107, 94, 0.10)"
              stroke="rgba(255, 107, 94, 0.4)"
              strokeWidth="0.25"
              strokeDasharray="1.4 1"
            />
          )
        })}

      {/* 오프볼 런 지시 (점선) — 앵커(체인 반영 위치)에서 출발 */}
      {runLegs.map((rl) => (
        <path
          key={`run-${rl.key}`}
          d={qPath(rl.from, rl.ctrl, rl.to)}
          fill="none"
          stroke="#dbe4f2"
          strokeWidth="0.5"
          strokeDasharray="1.5 1.1"
          markerEnd="url(#ah-move)"
          opacity={interactive ? 0.85 : 0.25}
          pointerEvents="none"
        />
      ))}

      {/* 공 전개 체인 (드리블/패스/슛) */}
      {chain.map((leg, i) => {
        const badge = quadPoint(leg.from, leg.ctrl, leg.to, 0.3)
        return (
          <g key={`leg-${i}`} pointerEvents="none" opacity={interactive ? 1 : 0.3}>
            <path
              d={qPath(leg.from, leg.ctrl, leg.to)}
              fill="none"
              stroke={LEG_COLOR[leg.type]}
              strokeWidth="0.6"
              strokeDasharray="1.8 1.1"
              markerEnd={LEG_MARKER[leg.type]}
            />
            <circle cx={badge.x} cy={badge.y} r="1.1" fill="#10141c" stroke={LEG_COLOR[leg.type]} strokeWidth="0.25" />
            <text x={badge.x} y={badge.y + 0.6} textAnchor="middle" fontSize="1.7" fontWeight="700" fill={LEG_COLOR[leg.type]}>
              {i + 1}
            </text>
          </g>
        )
      })}

      {/* 상대팀 (조작 불가) */}
      {opponents.map((o) => {
        const pos = oppPos(o)
        return (
          <g key={o.id} transform={`translate(${pos.x}, ${pos.y})`} opacity="0.9">
            <path
              d={`M ${DOT_R + 1.35} 0 L ${DOT_R + 0.25} -0.68 L ${DOT_R + 0.25} 0.68 Z`}
              fill="#cdd6e8"
              opacity="0.85"
              transform={`rotate(${facingDeg(pos, o.id)})`}
            />
            <circle r={DOT_R} fill={o.position === 'GK' ? '#3f6f2f' : '#1e3a6e'} stroke="#cdd6e8" strokeWidth="0.28" />
            <text y="0.55" textAnchor="middle" fontSize="1.5" fontWeight="700" fill="#fff">
              {o.number}
            </text>
            <text y={DOT_R + 2} textAnchor="middle" fontSize="1.6" fill="#dde4f0" stroke="#1a3a22" strokeWidth="0.25" paintOrder="stroke">
              {o.name}
            </text>
          </g>
        )
      })}

      {/* 지시로 자리를 옮긴 선수의 원래 자리 = 고스트 */}
      {interactive &&
        players.map((p) => {
          const moved = Math.hypot(planPos[p.id].x - p.x, planPos[p.id].y - p.y) > 0.5
          return moved ? (
            <g
              key={`ghost-${p.id}`}
              transform={`translate(${p.x}, ${p.y})`}
              filter="url(#ghostBlur)"
              opacity="0.45"
              pointerEvents="none"
            >
              <circle r={DOT_R} fill="#8892a4" stroke="#c3cad8" strokeWidth="0.35" strokeDasharray="1.1 0.8" />
              <text y="0.55" textAnchor="middle" fontSize="1.5" fontWeight="700" fill="#e8ecf4">
                {p.number}
              </text>
            </g>
          ) : null
        })}

      {/* 아군 선수 — 공 가진 선수 드래그 = 드리블, 나머지 = 오프볼 이동 */}
      {players.map((p) => {
        const isGK = p.position === 'GK'
        const isSelected = p.id === selectedId
        const pos = homePos(p)
        return (
          <g
            key={p.id}
            className="player"
            transform={`translate(${pos.x}, ${pos.y})`}
            onPointerDown={(e) => startDrag(e, p.id === carrierId ? 'dribble' : 'run', p.id)}
          >
            <circle r={HIT.player} fill="transparent" />
            {isSelected && <circle r={DOT_R + 0.8} fill="none" stroke="#ffd23e" strokeWidth="0.4" />}
            {interactive && p.id === carrierId && (
              <circle r={DOT_R + 0.9} fill="none" stroke="#fff" strokeWidth="0.25" strokeDasharray="0.9 0.7" />
            )}
            <path
              d={`M ${DOT_R + 1.35} 0 L ${DOT_R + 0.25} -0.68 L ${DOT_R + 0.25} 0.68 Z`}
              fill="#fff"
              opacity="0.85"
              transform={`rotate(${facingDeg(pos, p.id)})`}
            />
            <circle r={DOT_R} fill={isGK ? '#e8a020' : '#c8102e'} stroke="#fff" strokeWidth="0.3" />
            <text y="0.55" textAnchor="middle" fontSize="1.5" fontWeight="700" fill="#fff">
              {p.number}
            </text>
            <text y={DOT_R + 2} textAnchor="middle" fontSize="1.6" fill="#f0f4f0" stroke="#1a3a22" strokeWidth="0.25" paintOrder="stroke">
              {p.name}
            </text>
          </g>
        )
      })}

      {/* 곡률 핸들 (궤적 가운데 점 — 끌면 휘어짐) */}
      {interactive && (
        <g>
          {runLegs.map((rl) => {
            const h = handleFromCtrl(rl.from, rl.ctrl, rl.to)
            return (
              <g key={`rh-${rl.key}`} className="handle" onPointerDown={(e) => startDrag(e, 'rhandle', rl.key)}>
                <circle cx={h.x} cy={h.y} r={HIT.handle} fill="transparent" />
                <circle cx={h.x} cy={h.y} r="0.75" fill="#fff" stroke="#10141c" strokeWidth="0.25" />
              </g>
            )
          })}
          {chain.map((leg, i) => {
            const h = handleFromCtrl(leg.from, leg.ctrl, leg.to)
            return (
              <g key={`ch-${i}`} className="handle" onPointerDown={(e) => startDrag(e, 'chandle', leg.index)}>
                <circle cx={h.x} cy={h.y} r={HIT.handle} fill="transparent" />
                <circle cx={h.x} cy={h.y} r="0.75" fill={LEG_COLOR[leg.type]} stroke="#10141c" strokeWidth="0.25" />
              </g>
            )
          })}
        </g>
      )}

      {/* 패스 드래그 미리보기 */}
      {ballDrag && (
        <g pointerEvents="none">
          <line
            x1={ballPos.x + BALL_OFFSET.x}
            y1={ballPos.y + BALL_OFFSET.y}
            x2={ballDrag.x}
            y2={ballDrag.y}
            stroke="#ffd23e"
            strokeWidth="0.45"
            strokeDasharray="1.3 1"
            opacity="0.8"
          />
          <circle cx={ballDrag.x} cy={ballDrag.y} r="0.95" fill="#fff" stroke="#10141c" strokeWidth="0.25" opacity="0.7" />
        </g>
      )}

      {/* 볼 트레일 — 빠른 패스·슛의 혜성 꼬리 (재생 중 연출) */}
      {ballTrail?.length > 1 && (
        <g pointerEvents="none">
          {ballTrail.map((p, i) => (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={0.25 + (0.55 * (i + 1)) / ballTrail.length}
              fill="#fff"
              opacity={(0.4 * (i + 1)) / ballTrail.length}
            />
          ))}
        </g>
      )}

      {/* 공 — 드래그하면 패스/슛. 소유자 원에 가려지지 않게 발밑으로 살짝 오프셋 */}
      {ballPos && (
        <g
          className="ball"
          transform={`translate(${ballPos.x + BALL_OFFSET.x}, ${ballPos.y + BALL_OFFSET.y})`}
          onPointerDown={(e) => !shotTaken && startDrag(e, 'ball')}
        >
          <circle r={HIT.ball} fill="transparent" />
          <circle r="0.95" fill="#fff" stroke="#10141c" strokeWidth="0.25" />
          <circle r="0.38" fill="#10141c" />
        </g>
      )}

      {/* 터치 전용: 공 히트 영역이 소유자 점을 가리지 않도록, 소유자 중심을 최상위에서 드리블로 잡는다 */}
      {COARSE && interactive && ballPos && carrierId && planPos[carrierId] && (
        <circle
          className="player"
          cx={planPos[carrierId].x}
          cy={planPos[carrierId].y}
          r={DOT_R + 0.7}
          fill="transparent"
          onPointerDown={(e) => startDrag(e, 'dribble', carrierId)}
        />
      )}

      {/* ── 슛 조준 단계 — 골문 안 y만 겨눈다 ─────────────────────────── */}
      {interactive && mode === 'shot' && carrierPos && (
        <g>
          {/* 조준 히트 영역 (넉넉하게 — 손가락 기준) */}
          <rect
            x={GOAL_AIM.hitX}
            y={GOAL_AIM.hitY0}
            width={PITCH_W - GOAL_AIM.hitX}
            height={GOAL_AIM.hitY1 - GOAL_AIM.hitY0}
            fill="rgba(255, 107, 94, 0.07)"
            onPointerDown={aimDown}
          />
          <g pointerEvents="none">
            {/* 골문 안 조준 가능 구간 */}
            <rect
              x={118.2} y={GOAL_AIM.y0} width={1.8} height={GOAL_AIM.y1 - GOAL_AIM.y0}
              fill="rgba(255, 107, 94, 0.35)" stroke="#ff6b5e" strokeWidth="0.3"
            />
            {/* 조준선 */}
            <line
              x1={carrierPos.x} y1={carrierPos.y} x2={119} y2={aimY}
              stroke="#ff6b5e" strokeWidth="0.5" strokeDasharray="1.8 1.1" markerEnd="url(#ah-shot)"
            />
            <circle cx={119} cy={aimY} r="1.1" fill="#ff6b5e" stroke="#10141c" strokeWidth="0.25" />
            <text x={112} y={GOAL_AIM.hitY0 - 1.2} textAnchor="middle" fontSize="2.4" fill="#ff6b5e">
              골문을 겨눠 놓으면 슛
            </text>
          </g>
        </g>
      )}

      {/* ── 액션 메뉴 — 공 소유자를 탭하면 열린다 ────────────────────── */}
      {interactive && menuOpen && carrierPos && (
        <g>
          {(() => {
            const mx = clamp(carrierPos.x - MENU.w, 2, PITCH_W - MENU.w * 2 - 2)
            const my = clamp(carrierPos.y - MENU.h - 2, 2, PITCH_H - MENU.h * 2 - 2)
            const items = [
              { key: 'dribble', label: '드리블', hint: '도착점 탭', color: '#dbe4f2' },
              { key: 'pass', label: '패스', hint: '동료 탭', color: '#ffd23e' },
              { key: 'shot', label: '슛', hint: '골문 조준', color: '#ff6b5e', disabled: shotTaken },
              { key: 'stats', label: '능력치', hint: '카드 보기', color: '#9aa3b5' },
            ]
            return (
              <>
                <line
                  x1={carrierPos.x} y1={carrierPos.y} x2={mx + MENU.w} y2={my + MENU.h}
                  stroke="#3d4a63" strokeWidth="0.3" pointerEvents="none"
                />
                {items.map((it, i) => {
                  const bx = mx + (i % 2) * MENU.w
                  const by = my + Math.floor(i / 2) * MENU.h
                  const active = mode === it.key
                  return (
                    <g
                      key={it.key}
                      className={it.disabled ? undefined : 'menu-item'}
                      opacity={it.disabled ? 0.35 : 1}
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        if (it.disabled) return
                        if (it.key === 'stats') {
                          closeMenu()
                          onPlayerClick(carrierId)
                        } else {
                          setMode(it.key)
                        }
                      }}
                    >
                      <rect
                        x={bx} y={by} width={MENU.w - 0.6} height={MENU.h - 0.6} rx="1.2"
                        fill={active ? 'rgba(255,210,62,0.18)' : 'rgba(16,20,28,0.92)'}
                        stroke={active ? '#ffd23e' : '#3d4a63'}
                        strokeWidth={active ? 0.45 : 0.3}
                      />
                      <text
                        x={bx + (MENU.w - 0.6) / 2} y={by + MENU.h / 2 - 0.3}
                        textAnchor="middle" fontSize="2.7" fontWeight="700" fill={it.color}
                        pointerEvents="none"
                      >
                        {it.label}
                      </text>
                      <text
                        x={bx + (MENU.w - 0.6) / 2} y={by + MENU.h - 1.7}
                        textAnchor="middle" fontSize="1.8" fill="#6b7385" pointerEvents="none"
                      >
                        {it.disabled ? '슛 완료' : it.hint}
                      </text>
                    </g>
                  )
                })}
              </>
            )
          })()}
        </g>
      )}
    </svg>
  )
}
