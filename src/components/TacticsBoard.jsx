import { useRef, useState } from 'react'
import { quadPoint, handleFromCtrl } from '../engine/geometry'
import { josaGa, josaEun } from '../engine/commentary'
// 킷은 오프닝 화면과 공유한다 (data/kits.js) — 유니폼 색은 한 곳에서만 정한다.
import { kitsFor } from '../data/kits'
import { K } from '../engine/constants'

// StatsBomb 좌표계와 동일한 120x80 피치. x: 0(우리 골대) → 120(상대 골대)
const PITCH_W = 120
const PITCH_H = 80
const DOT_R = 1.4
const LEG_COLOR = { dribble: '#dbe4f2', pass: '#ffd23e', shot: '#ff6b5e' }
const LOB_COLOR = '#8de7ff'
// 시선 규칙은 재생(playback.js)과 같은 값을 써야 계획 화면과 재생이 어긋나 보이지 않는다
const { GAZE_AHEAD, GAZE_MARK_R } = K.PLAY

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

const isLobKind = (passKind) => passKind === 'lob' || passKind === 'lobThrough'
const legColor = (leg) => (leg.type === 'pass' && isLobKind(leg.passKind) ? LOB_COLOR : LEG_COLOR[leg.type])

export default function TacticsBoard({
  players,
  opponents,
  runLegs, // 오프볼 런 legs: [{ id, from, to, ctrl }] — from은 체인 반영 앵커
  chain, // 공 전개 체인 legs (App에서 유도, index 포함)
  planPos, // 계획상 각 선수의 최종 위치 (id → {x,y})
  carrierId, // 체인 끝에서 공을 갖게 될 선수 — 이 선수를 드래그하면 드리블
  shotTaken,
  reachCircles, // 가동범위 동심원: [{ id, x, y, r }] — 마지막 액션 시간 안에 갈 수 있는 거리
  tutFocus, // 튜토리얼 지목: { playerId?, ball?, action? } — 그 단계가 가리키는 대상을 점멸시킨다
  shotZone, // 재현 판정 구역: { x, y, rx, ry, label } — 그날 슛이 나온 지점과 타원 허용 반경
  onEggShotMove, // (pt) — 구역 중심 끌어 옮기기. 있으면 마커가 잡힌다 (개발 전용)
  ghosts, // 실측 기준점: [{ x, y, side, name?, actor?, keeper? }] — 좌표 편집용 (개발 전용)
  ballPos,
  ballTrail, // 재생 중 공 트레일 [{x,y}] — 빠른 패스·슛의 혜성 꼬리 (평시 null)
  displayHome, // 재생 중 애니메이션 위치 (id → {x,y,a}), 평시 null
  displayOpp,
  interactive,
  defRadius,
  offsideIds, // 계획 단계 오프사이드 경고 대상 receiverId Set — 빨간 점멸
  offsideFx, // 재생 중 오프사이드 깃발 효과
  selectedId,
  onPlayerClick,
  runsAllowed, // 오프볼 런을 그릴 수 있는가 — 공 액션이 있는 슬롯에서만 true
  onRunSet,
  onRunRemove,
  onRunHandle,
  onDribbleSet, // (pt, isFirst)
  onDribbleDrop, // (pt)
  onChainHandle, // (chainIndex, handlePt)
  onPassCommit, // (receiverId | 'GOAL', toForGoal)
  onThroughCommit, // (receiverId, 공간 좌표) — 스루패스
  throughTargetOf, // (receiverId, pt) → 실제로 성립하는 도착점 (조준 미리보기용, 확정과 같은 계산)
  offsidePosIds, // 지금 오프사이드 위치에 서 있는 아군 id Set
  flipX, // 보기만 좌우 반전 — 그날 중계에서 홈팀이 왼쪽으로 공격한 경기 (좌표는 그대로)
  matchId, // 킷 색을 고르는 데만 쓴다 (data/kits.js 참고)
  // 좌표 편집 모드(개발 전용). 켜면 전술 조작 대신 양 팀 아무나 끌어서 자리를 옮긴다.
  // 장면 좌표를 중계 화면 보고 맞추는 용도라, 실제 게임 조작과는 완전히 분리한다.
  editMode,
  onEditMove, // (playerId, {x, y})
  onEditBallOwner, // (playerId) — 편집 중 공을 가까이 놓은 공격 선수를 새 시작 소유자로 지정
}) {
  const [homeKit, awayKit] = kitsFor(matchId)
  // 튜토리얼이 가리키는 메뉴 항목. 패스 계열은 두 창에 걸쳐 있다 —
  // 메인 메뉴에서는 [패스](종류 선택)를, 열린 종류 창에서는 그 종류 자체를 깜빡인다.
  const MAIN_MENU_OF = { dribble: 'dribble', shot: 'shot', pass: 'pass-select', lob: 'pass-select', through: 'pass-select' }
  const tutMainMenuKey = tutFocus?.action ? MAIN_MENU_OF[tutFocus.action] : null
  const svgRef = useRef(null)
  const dragRef = useRef(null) // { kind: 'run'|'dribble'|'ball'|'editBall'|'rhandle'|'chandle', key, startX, startY, moved }
  const [ballDrag, setBallDrag] = useState(null)
  const [dragging, setDragging] = useState(false)
  // 공 소유자 탭 → 액션 메뉴. mode는 메뉴에서 고른 뒤 "대상을 찍는" 단계.
  //   null | 'dribble'(도착점 탭) | 'pass'(동료 탭) | 'shot'(골문 안 y 조준)
  const [menuOpen, setMenuOpen] = useState(false)
  const [mode, setMode] = useState(null)
  const [aimY, setAimY] = useState(40)
  // 스루패스는 2단계다: ① 받을 동료 탭 → ② 뛰어들 공간 탭.
  // 이 값이 차 있으면 ②단계(공간 지정)를 기다리는 중.
  const [throughId, setThroughId] = useState(null)
  // 조준 중 커서 위치 — 찍기 전에 "실제로 어디에 확정되는지"를 미리 보여주기 위해
  const [throughHover, setThroughHover] = useState(null)

  const closeMenu = () => {
    setMenuOpen(false)
    setMode(null)
    setThroughId(null)
    setThroughHover(null)
  }

  // 액션을 고른 뒤에는 기존 버튼 창을 닫는다. 메뉴가 목표 영역을 덮어
  // 슛·패스 입력을 먹어 버리던 문제를 막고, 선택한 모드만 유지한다.
  const selectActionMode = (nextMode) => {
    setMenuOpen(false)
    setMode(nextMode)
    setThroughId(null)
    setThroughHover(null)
  }

  const baseOf = Object.fromEntries(players.map((p) => [p.id, { x: p.x, y: p.y }]))
  const homePos = (p) => (displayHome ? (displayHome[p.id] ?? baseOf[p.id]) : planPos[p.id])
  const oppPos = (o) => (displayOpp ? (displayOpp[o.id] ?? { x: o.x, y: o.y }) : { x: o.x, y: o.y })
  const nearestBallOwner = (pt, maxDistance = 8) => {
    let best = null
    for (const p of players) {
      const pos = homePos(p)
      const distance = Math.hypot(pos.x - pt.x, pos.y - pt.y)
      if (distance <= maxDistance && (!best || distance < best.distance)) best = { id: p.id, pos, distance }
    }
    return best
  }

  // 바라보는 방향 (도 단위) — 재생 중엔 playback이 넣어준 각도(pos.a), 계획 중엔
  // 공 방향을 본다. 공 소유자는 공이 발밑이라 방향이 무의미 → 상대 골문을 본다.
  const facingDeg = (pos, id, opponent = false) => {
    if (pos.a != null) return (pos.a * 180) / Math.PI
    if (!ballPos) return 0
    const tgt = gazeTarget(pos, id, opponent)
    return (Math.atan2(tgt.y - pos.y, tgt.x - pos.x) * 180) / Math.PI
  }

  // 계획 화면에서 누가 어디를 보는가. 전원이 공만 노려보면 실감이 떨어진다는
  // 평을 받았다 — 실제로는 공을 안 보는 순간이 더 많다.
  //   공 소유자      → 상대 골문 (다음 수를 본다)
  //   앞서 나간 아군  → 골문 (뒷공간·마무리를 노린다)
  //   상대 수비수     → 근처 아군 공격수 (마크 대상에서 눈을 안 뗀다)
  //   그 외          → 공
  function gazeTarget(pos, id, opponent) {
    if (!opponent) {
      if (id === carrierId) return { x: 120, y: 40 }
      return pos.x > ballPos.x + GAZE_AHEAD ? { x: 120, y: 40 } : ballPos
    }
    const o = opponents.find((x) => x.id === id)
    if (o && (o.position === 'DF' || o.position === 'MF')) {
      let near = null
      for (const p of players) {
        const hp = homePos(p)
        const d = Math.hypot(hp.x - pos.x, hp.y - pos.y)
        if (d < GAZE_MARK_R && (!near || d < near.d)) near = { d, hp }
      }
      if (near) return near.hp
    }
    return ballPos
  }

  function toPitch(e) {
    const rect = svgRef.current.getBoundingClientRect()
    // 반전 보기에서는 화면 왼쪽 끝이 x=120이다. 보드를 CSS로 뒤집어 그려도
    // getBoundingClientRect는 그대로라, 여기서 x를 되돌려 데이터 좌표로 맞춘다.
    const vx = ((e.clientX - rect.left) / rect.width) * PITCH_W
    return {
      x: clamp(flipX ? PITCH_W - vx : vx, 1.5, PITCH_W - 1.5),
      y: clamp(((e.clientY - rect.top) / rect.height) * PITCH_H, 1.5, PITCH_H - 1.5),
    }
  }

  function startDrag(e, kind, key) {
    // 재현 구역 마커는 계획/재생과 무관한 개발용 오버레이라 어느 상태에서든 잡힌다
    // (마커가 보이는 것 자체가 이미 개발 모드 + 표시 켬을 뜻한다).
    if (kind === 'eggshot') {
      e.stopPropagation()
      e.target.setPointerCapture(e.pointerId)
      dragRef.current = { kind, key, startX: e.clientX, startY: e.clientY, moved: false }
      return
    }
    // 편집 모드는 interactive를 끈 채로 돌아간다 — 선수와 시작 공 편집만 통과시킨다.
    const editorDrag = kind === 'edit' || kind === 'editBall'
    if (editorDrag ? !editMode : !interactive) return
    e.stopPropagation()
    e.target.setPointerCapture(e.pointerId)
    dragRef.current = { kind, key, startX: e.clientX, startY: e.clientY, moved: false }
  }

  function handleMove(e) {
    // 스루패스 ②단계는 누르지 않고 움직이는 중에도 미리보기를 갱신해야 한다
    // (드래그가 아니라 탭으로 확정되므로 dragRef가 비어 있다)
    if (interactive && (mode === 'through' || mode === 'lobThrough') && throughId) setThroughHover(toPitch(e))
    const d = dragRef.current
    if (!d) return
    // 살짝 흔들린 클릭은 드래그로 치지 않는다
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < HIT.slopPx) return
      d.moved = true
      setDragging(true)
    }
    const pt = toPitch(e)
    if (d.kind === 'eggshot') onEggShotMove(pt)
    else if (d.kind === 'edit') onEditMove(d.key, pt)
    else if (d.kind === 'editBall') setBallDrag(pt)
    else if (d.kind === 'run') {
      // 공 액션이 없는 슬롯에서는 런을 못 그린다 — 끌어도 유령 경로가 남지 않게
      // 여기서 막는다. 탭(선수 선택·패스 대상 지정)은 endDrag가 그대로 처리한다.
      if (!runsAllowed) return
      onRunSet(d.key, pt, !d.began)
      d.began = true
    } else if (d.kind === 'dribble') {
      if (shotTaken) return // 슛으로 끝난 뒤에는 드래그 드리블도 막는다
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
      return commitShotAt(e)
    }
    if (d.kind === 'editBall') {
      setBallDrag(null)
      if (!d.moved) return
      const owner = nearestBallOwner(toPitch(e))
      if (owner) onEditBallOwner(owner.id)
      return
    }
    if (d.kind === 'run') {
      // 패스 조준 중이면 동료 탭이 곧 패스 대상 선택
      if (!d.moved && (mode === 'pass' || mode === 'lob')) {
        closeMenu()
        return onPassCommit(d.key, null, mode === 'lob' ? 'lob' : 'ground')
      }
      // 스루패스 ①단계: 받을 동료 선택 (②단계는 빈 공간 탭 — boardDown)
      if (!d.moved && (mode === 'through' || mode === 'lobThrough') && !throughId) {
        setThroughId(d.key)
        return
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
    // 스루패스 ②단계: 동료가 뛰어들 공간을 찍는다
    if ((mode === 'through' || mode === 'lobThrough') && throughId) {
      onThroughCommit(throughId, toPitch(e), mode)
      closeMenu()
      return
    }
    closeMenu()
  }

  // 슛 조준 — 골문 안 y만 정한다 (기존과 같은 36.5~43.5 클램프)
  const commitShotAt = (e) => {
    const y = clamp(toPitch(e).y, GOAL_AIM.y0, GOAL_AIM.y1)
    dragRef.current = null
    setDragging(false)
    setAimY(y)
    closeMenu()
    onPassCommit('GOAL', { x: 119, y })
  }

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
  const byIdName = (id) => players.find((p) => p.id === id)?.name ?? '동료'
  // 로빙 중인 공은 작게 표시해 평면 보드에서도 높이를 읽을 수 있게 한다.
  const ballHeight = clamp(ballPos?.height ?? 0, 0, 1)
  // 높이 떠 있는 로빙 공은 카메라 쪽으로 가까워진 것처럼 더 크게 보인다.
  const ballRadius = 0.95 * (1 + ballHeight * 0.6)
  const editBallCandidate = editMode && ballDrag ? nearestBallOwner(ballDrag) : null
  const renderedBall = editMode && ballDrag
    ? (editBallCandidate
        ? { x: editBallCandidate.pos.x + BALL_OFFSET.x, y: editBallCandidate.pos.y + BALL_OFFSET.y }
        : ballDrag)
    : ballPos
      ? { x: ballPos.x + BALL_OFFSET.x, y: ballPos.y + BALL_OFFSET.y }
      : null

  return (
    <svg
      ref={svgRef}
      className={`tactics-board${flipX ? ' flip-x' : ''}`}
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
        {/* 재현 구역 그라디언트 — 가장자리를 흐리게 뺀다.
            테두리가 선명하면 "이 선만 넘으면 된다"로 읽히는데, 우리가 아는 건
            "이 언저리"까지다. 판정은 원 안팎으로 딱 갈리지만 그건 근사이고,
            화면은 근사인 걸 근사로 보여야 한다. */}
        <radialGradient id="eggZone">
          <stop offset="0%" stopColor="#ffd23e" stopOpacity="0.30" />
          <stop offset="55%" stopColor="#ffd23e" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#ffd23e" stopOpacity="0" />
        </radialGradient>
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

      {/* 재현 구역 — 그날 슛이 나온 지점과 판정 허용 반경.
          잔디 바로 위, 선수 아래에 깔아 조작을 가리지 않는다. */}
      {shotZone && (
        <g>
          {/* 거리축(rx)과 좌우축(ry)이 다른 타원 — 중거리는 앞뒤로 길고 좌우로는 좁다 */}
          <ellipse
            cx={shotZone.x}
            cy={shotZone.y}
            rx={shotZone.rx}
            ry={shotZone.ry}
            fill="url(#eggZone)"
            pointerEvents="none"
          />
          {/* 실제 슛 지점 — 구역의 중심이자 영상으로 대조할 기준점.
              onEggShotMove가 있으면 끌어서 옮길 수 있다 (개발 모드). */}
          <g pointerEvents="none" stroke="#ffd23e" strokeWidth="0.3" opacity="0.95">
            <line x1={shotZone.x - 1.8} y1={shotZone.y} x2={shotZone.x + 1.8} y2={shotZone.y} />
            <line x1={shotZone.x} y1={shotZone.y - 1.8} x2={shotZone.x} y2={shotZone.y + 1.8} />
          </g>
          <circle cx={shotZone.x} cy={shotZone.y} r="0.55" fill="#ffd23e" pointerEvents="none" />
          {shotZone.label && (
            <text
              x={shotZone.x}
              y={shotZone.y - 2.8}
              textAnchor="middle"
              fontSize="2.2"
              fontWeight="700"
              fill="#ffd23e"
              pointerEvents="none"
            >
              {shotZone.label}
            </text>
          )}
          {onEggShotMove && (
            <circle
              className="egg-anchor"
              cx={shotZone.x}
              cy={shotZone.y}
              r={HIT.handle}
              fill="transparent"
              onPointerDown={(e) => startDrag(e, 'eggshot')}
            />
          )}
        </g>
      )}

      {/* 실측 유령 — StatsBomb이 그 순간에 실제로 기록한 자리.
          좌표 편집 때 "여기 사람이 있었다"는 증거로만 쓴다. 자동으로 끌어다 놓지 않는 이유는
          이름이 붙은 점이 슛 순간 12명뿐이고 나머지는 익명이라, 누가 누구인지는
          영상을 본 사람만 판단할 수 있기 때문이다. 잔디 위·선수 아래에 깔고 클릭도 먹지 않는다. */}
      {ghosts?.length > 0 && (
        <g pointerEvents="none" className="ghosts">
          {ghosts.map((g, i) => {
            const c = g.side === 'home' ? '#ff8a8a' : '#e8eef6'
            return (
              <g key={i} opacity={g.actor ? 0.95 : 0.6}>
                <circle
                  cx={g.x}
                  cy={g.y}
                  r={g.actor ? 1.9 : 1.5}
                  fill="none"
                  stroke={g.actor ? '#ffd23e' : c}
                  strokeWidth={g.actor ? 0.42 : 0.3}
                  strokeDasharray="0.9 0.7"
                />
                {/* 가운데 점 — 정확히 어느 좌표인지 (원 테두리는 두꺼워서 애매하다) */}
                <circle cx={g.x} cy={g.y} r="0.28" fill={g.actor ? '#ffd23e' : c} />
                {g.name && (
                  <text
                    x={g.x}
                    y={g.y - 2.4}
                    textAnchor="middle"
                    fontSize="1.7"
                    fontWeight="600"
                    fill={g.actor ? '#ffd23e' : c}
                  >
                    {g.name}
                  </text>
                )}
              </g>
            )
          })}
        </g>
      )}

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

      {/* 가동범위 동심원 — 마지막 공 액션이 걸리는 시간 동안 그 선수가 갈 수 있는 거리.
          오프볼 런 목표는 이 원 안으로 클램프된다. */}
      {reachCircles?.map((c) => (
        <g key={`reach-${c.id}`} pointerEvents="none">
          <circle
            cx={c.x} cy={c.y} r={c.r}
            fill="rgba(120, 200, 255, 0.05)" stroke="rgba(120, 200, 255, 0.45)"
            strokeWidth="0.22" strokeDasharray="1.2 1"
          />
        </g>
      ))}

      {/* 오프사이드 라인 — 계획 중 경고가 있을 때, 재생 중엔 휘슬 이후 표시.
          최후방 2번째 수비수의 x에 세로선을 긋는다 (판정 기준선의 시각화). */}
      {/* 재생 중 오프사이드 확정 — 부심 깃발 */}
      {offsideFx?.offside && (
        <g pointerEvents="none">
          <rect x={44} y={30} width={32} height={13} rx="2" fill="rgba(16,20,28,0.86)" stroke="#ff3b30" strokeWidth="0.4" />
          <text x={60} y={36.5} textAnchor="middle" fontSize="4.4">🚩</text>
          <text x={60} y={41} textAnchor="middle" fontSize="3.2" fontWeight="700" fill="#ff6b5e">오프사이드</text>
        </g>
      )}

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
        const color = legColor(leg)
        return (
          <g key={`leg-${i}`} pointerEvents="none" opacity={interactive ? 1 : 0.3}>
            <path
              d={qPath(leg.from, leg.ctrl, leg.to)}
              fill="none"
              stroke={color}
              strokeWidth="0.6"
              strokeDasharray={isLobKind(leg.passKind) ? '0.8 0.8' : '1.8 1.1'}
              markerEnd={LEG_MARKER[leg.type]}
            />
            <circle cx={badge.x} cy={badge.y} r="1.1" fill="#10141c" stroke={color} strokeWidth="0.25" />
            <text x={badge.x} y={badge.y + 0.6} textAnchor="middle" fontSize="1.7" fontWeight="700" fill={color}>
              {isLobKind(leg.passKind) ? `↟${i + 1}` : i + 1}
            </text>
          </g>
        )
      })}

      {/* 상대팀 (조작 불가) */}
      {opponents.map((o) => {
        const pos = oppPos(o)
        return (
          <g
            key={o.id}
            className={editMode ? 'player' : undefined}
            transform={`translate(${pos.x}, ${pos.y})`}
            opacity="0.9"
            onPointerDown={editMode ? (e) => startDrag(e, 'edit', o.id) : undefined}
          >
            {/* 편집 모드에서만 상대도 손가락으로 집을 수 있게 히트 영역을 준다 */}
            {editMode && <circle r={HIT.player} fill="transparent" />}
            <path
              d={`M ${DOT_R + 1.35} 0 L ${DOT_R + 0.25} -0.68 L ${DOT_R + 0.25} 0.68 Z`}
              fill="#cdd6e8"
              opacity="0.85"
              transform={`rotate(${facingDeg(pos, o.id, true)})`}
            />
            <circle r={DOT_R} fill={o.position === 'GK' ? awayKit.gk : awayKit.body} stroke={awayKit.ring} strokeWidth="0.28" />
            <text y="0.55" textAnchor="middle" fontSize="1.5" fontWeight="700" fill={awayKit.num}>
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
            onPointerDown={(e) =>
              startDrag(e, editMode ? 'edit' : p.id === carrierId ? 'dribble' : 'run', p.id)
            }
          >
            <circle r={HIT.player} fill="transparent" />
            {/* 튜토리얼 지목 — "화면 어디를 보라"는 말로는 사람마다 배치가 달라 안 통한다.
                점멸은 링에만 건다. 선수 g 전체에 걸면 선수가 같이 깜빡여 사라진다. */}
            {tutFocus?.playerId === p.id && (
              <g className="tut-focus" pointerEvents="none">
                <circle r={DOT_R + 2.2} fill="none" stroke="#ffd23e" strokeWidth="0.5" />
              </g>
            )}
            {/* 오프사이드 경고 — 설계를 막지는 않고, 이대로 실행하면 깃발이 오른다는 신호 */}
            {interactive && offsideIds?.has(p.id) && (
              <g className="offside-warn" pointerEvents="none">
                <circle r={DOT_R + 1.7} fill="none" stroke="#ff3b30" strokeWidth="0.5" />
                <text y={-DOT_R - 2.4} textAnchor="middle" fontSize="2.6">🚩</text>
              </g>
            )}
            {isSelected && <circle r={DOT_R + 0.8} fill="none" stroke="#ffd23e" strokeWidth="0.4" />}
            {interactive && p.id === carrierId && (
              // 킷과 같은 테두리 색 — 흰 킷에서 흰 점선을 쓰면 공 소유자가 보이지 않는다
              <circle r={DOT_R + 0.9} fill="none" stroke={homeKit.ring} strokeWidth="0.25" strokeDasharray="0.9 0.7" />
            )}
            <path
              d={`M ${DOT_R + 1.35} 0 L ${DOT_R + 0.25} -0.68 L ${DOT_R + 0.25} 0.68 Z`}
              fill="#fff"
              opacity="0.85"
              transform={`rotate(${facingDeg(pos, p.id)})`}
            />
            <circle r={DOT_R} fill={isGK ? homeKit.gk : homeKit.body} stroke={homeKit.ring} strokeWidth="0.3" />
            <text y="0.55" textAnchor="middle" fontSize="1.5" fontWeight="700" fill={homeKit.num}>
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
      {ballDrag && !editMode && (
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

      {/* 시작 공 편집 미리보기 — 공격 선수 8m 안에 들어오면 그 선수에게 스냅된다. */}
      {editMode && editBallCandidate && (
        <g pointerEvents="none">
          <circle
            cx={editBallCandidate.pos.x}
            cy={editBallCandidate.pos.y}
            r={DOT_R + 1.4}
            fill="none"
            stroke="#ffd23e"
            strokeWidth="0.45"
            strokeDasharray="1.2 0.8"
          />
          <text
            x={editBallCandidate.pos.x}
            y={editBallCandidate.pos.y - DOT_R - 2.1}
            textAnchor="middle"
            fontSize="1.8"
            fill="#ffd23e"
            stroke="#10141c"
            strokeWidth="0.3"
            paintOrder="stroke"
          >
            시작 소유자
          </text>
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
              r={(0.25 + (0.55 * (i + 1)) / ballTrail.length) * (1 + (p.height ?? 0) * 0.35)}
              fill="#fff"
              opacity={(0.4 * (i + 1)) / ballTrail.length}
            />
          ))}
        </g>
      )}

      {/* 공 — 드래그하면 패스/슛. 소유자 원에 가려지지 않게 발밑으로 살짝 오프셋 */}
      {renderedBall && (
        <g
          className="ball"
          transform={`translate(${renderedBall.x}, ${renderedBall.y})`}
          onPointerDown={(e) => (editMode || !shotTaken) && startDrag(e, editMode ? 'editBall' : 'ball')}
        >
          <circle r={HIT.ball} fill="transparent" />
          {tutFocus?.ball && (
            <g className="tut-focus" pointerEvents="none">
              <circle r={ballRadius + 1.6} fill="none" stroke="#ffd23e" strokeWidth="0.45" />
            </g>
          )}
          <circle r={ballRadius} fill="#fff" stroke="#10141c" strokeWidth="0.25" />
          <circle r={ballRadius * 0.4} fill="#10141c" />
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
            onPointerUp={(e) => {
              e.stopPropagation()
              if (dragRef.current?.kind === 'aim') commitShotAt(e)
            }}
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

      {/* 스루패스 조준 — ①받을 동료 고르기 / ②뛰어들 공간 찍기 */}
      {interactive && (mode === 'through' || mode === 'lobThrough') && (() => {
        const recvOffside = throughId && offsidePosIds?.has(throughId)
        const passKind = mode === 'lobThrough' ? 'lobThrough' : 'through'
        // 커서 지점과 "실제로 확정될 지점"이 다르면(= 당겨지면) 그 차이를 보여준다
        const want = throughHover
        const real = want && throughId && throughTargetOf ? throughTargetOf(throughId, want, passKind) : null
        const pulled = real && want && Math.hypot(real.x - want.x, real.y - want.y) > 0.4
        return (
          <g pointerEvents="none">
            {/* 오프사이드 라인 — 스루패스는 오프사이드가 걸리는 지점이라 조준 중에 늘 보여준다 */}
            {/* 안내 배너 */}
            <rect x={22} y={2.5} width={76} height={7} rx="1.6" fill="rgba(16,20,28,0.88)"
              stroke={recvOffside ? '#ff3b30' : '#7ee0a8'} strokeWidth="0.3" />
            <text x={60} y={7.4} textAnchor="middle" fontSize="3" fill={recvOffside ? '#ff6b5e' : '#7ee0a8'}>
              {!throughId
                ? '스루패스 — 받을 동료를 탭하세요'
                : recvOffside
                  ? `🚩 ${josaEun(byIdName(throughId))} 이미 오프사이드 위치 — 주면 깃발이 오릅니다`
                  : `${josaGa(byIdName(throughId))} 뛰어들 공간을 탭하세요`}
            </text>

            {/* ①단계: 오프사이드 위치의 동료를 미리 빨갛게 */}
            {!throughId &&
              players.map((p) =>
                offsidePosIds?.has(p.id) ? (
                  <circle key={`op-${p.id}`} cx={planPos[p.id].x} cy={planPos[p.id].y}
                    r={DOT_R + 1.7} fill="none" stroke="#ff3b30" strokeWidth="0.45" opacity="0.85" />
                ) : null,
              )}

            {/* ②단계: 선택된 동료 강조 */}
            {throughId && planPos[throughId] && (
              <circle cx={planPos[throughId].x} cy={planPos[throughId].y} r={DOT_R + 1.8}
                fill="none" stroke={recvOffside ? '#ff3b30' : '#7ee0a8'} strokeWidth="0.5" />
            )}

            {/* 도착점 미리보기 — 당겨지면 찍은 자리(흐린 ✕)와 실제 도착점을 잇는다 */}
            {real && (
              <>
                {pulled && (
                  <>
                    <g opacity="0.5">
                      <line x1={want.x - 1.3} y1={want.y - 1.3} x2={want.x + 1.3} y2={want.y + 1.3}
                        stroke="#8892a4" strokeWidth="0.4" />
                      <line x1={want.x + 1.3} y1={want.y - 1.3} x2={want.x - 1.3} y2={want.y + 1.3}
                        stroke="#8892a4" strokeWidth="0.4" />
                    </g>
                    <line x1={real.x} y1={real.y} x2={want.x} y2={want.y}
                      stroke="#8892a4" strokeWidth="0.3" strokeDasharray="0.8 0.9" opacity="0.6" />
                    <text x={(real.x + want.x) / 2} y={(real.y + want.y) / 2 - 1.4} textAnchor="middle"
                      fontSize="2.1" fill="#9aa3b5">
                      여기까진 못 갑니다
                    </text>
                  </>
                )}
                {/* 실제 확정될 도착점 + 리시버의 침투 경로 */}
                {planPos[throughId] && (
                  <line x1={planPos[throughId].x} y1={planPos[throughId].y} x2={real.x} y2={real.y}
                    stroke="#7ee0a8" strokeWidth="0.4" strokeDasharray="1.4 1" opacity="0.9" />
                )}
                {carrierPos && (
                  <line x1={carrierPos.x} y1={carrierPos.y} x2={real.x} y2={real.y}
                    stroke="#ffd23e" strokeWidth="0.4" strokeDasharray="1.8 1.1" opacity="0.75" />
                )}
                <circle cx={real.x} cy={real.y} r="1.2" fill="none" stroke="#7ee0a8" strokeWidth="0.45" />
                <circle cx={real.x} cy={real.y} r="0.4" fill="#7ee0a8" />
              </>
            )}
          </g>
        )
      })()}

      {/* ── 액션 메뉴 — 공 소유자를 탭하면 열린다 ────────────────────── */}
      {interactive && mode === 'pass-select' && carrierPos && (
        <g>
          {(() => {
            const items = [
              { key: 'pass', label: '패스', hint: '낮게 동료에게', color: '#ffd23e' },
              { key: 'lob', label: '로빙패스', hint: '높게 동료에게', color: LOB_COLOR },
              { key: 'through', label: '스루패스', hint: '동료 → 공간', color: '#7ee0a8' },
              { key: 'lobThrough', label: '로빙스루', hint: '높게 → 공간', color: LOB_COLOR },
            ]
            const mx = clamp(carrierPos.x - MENU.w, 2, PITCH_W - MENU.w * 2 - 2)
            const my = clamp(carrierPos.y - MENU.h - 2, 2, PITCH_H - MENU.h * 2 - 2)
            return (
              <>
                <line x1={carrierPos.x} y1={carrierPos.y} x2={mx + MENU.w} y2={my + MENU.h}
                  stroke="#3d4a63" strokeWidth="0.3" pointerEvents="none" />
                {items.map((it, i) => {
                  const bx = mx + (i % 2) * MENU.w
                  const by = my + Math.floor(i / 2) * MENU.h
                  return (
                    <g key={it.key} className="menu-item" onPointerDown={(e) => {
                      e.stopPropagation()
                      selectActionMode(it.key)
                    }}>
                      <rect x={bx} y={by} width={MENU.w - 0.6} height={MENU.h - 0.6} rx="1.2"
                        fill="rgba(16,20,28,0.92)" stroke="#3d4a63" strokeWidth="0.3" />
                      {tutFocus?.action === it.key && (
                        <rect className="tut-focus" x={bx} y={by} width={MENU.w - 0.6} height={MENU.h - 0.6}
                          rx="1.2" fill="none" stroke="#ffd23e" strokeWidth="0.6" pointerEvents="none" />
                      )}
                      <text x={bx + (MENU.w - 0.6) / 2} y={by + MENU.h / 2 - 0.3}
                        textAnchor="middle" fontSize="2.35" fontWeight="700" fill={it.color} pointerEvents="none">
                        {it.label}
                      </text>
                      <text x={bx + (MENU.w - 0.6) / 2} y={by + MENU.h - 1.7}
                        textAnchor="middle" fontSize="1.55" fill="#6b7385" pointerEvents="none">
                        {it.hint}
                      </text>
                    </g>
                  )
                })}
              </>
            )
          })()}
        </g>
      )}

      {interactive && menuOpen && carrierPos && (
        <g>
          {(() => {
            // 슛으로 전개가 끝나면 더 이상 액션을 붙일 수 없다 — 능력치 보기만 남긴다.
            const items = [
              { key: 'dribble', label: '드리블', hint: '도착점 탭', color: '#dbe4f2', disabled: shotTaken },
              { key: 'pass-select', label: '패스', hint: '종류 선택', color: '#ffd23e', disabled: shotTaken },
              // 슛은 잠그지 않는다 — 새 액션이 붙는 게 아니라 이미 찬 슛의 목적지를
              // 다시 겨누는 것이라, 막으면 한 번 찍은 코스를 영영 못 고친다.
              { key: 'shot', label: '슛', hint: shotTaken ? '다시 조준' : '골문 조준', color: '#ff6b5e' },
              { key: 'stats', label: '능력치', hint: '카드 보기', color: '#9aa3b5' },
            ]
            const rows = Math.ceil(items.length / 2)
            const mx = clamp(carrierPos.x - MENU.w, 2, PITCH_W - MENU.w * 2 - 2)
            const my = clamp(carrierPos.y - MENU.h - 2, 2, PITCH_H - MENU.h * rows - 2)
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
                          selectActionMode(it.key)
                        }
                      }}
                    >
                      <rect
                        x={bx} y={by} width={MENU.w - 0.6} height={MENU.h - 0.6} rx="1.2"
                        fill={active ? 'rgba(255,210,62,0.18)' : 'rgba(16,20,28,0.92)'}
                        stroke={active ? '#ffd23e' : '#3d4a63'}
                        strokeWidth={active ? 0.45 : 0.3}
                      />
                      {tutMainMenuKey === it.key && !it.disabled && (
                        <rect className="tut-focus" x={bx} y={by} width={MENU.w - 0.6} height={MENU.h - 0.6}
                          rx="1.2" fill="none" stroke="#ffd23e" strokeWidth="0.6" pointerEvents="none" />
                      )}
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
                        {it.disabled ? '슛으로 종료' : it.hint}
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
