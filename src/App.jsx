import { useEffect, useMemo, useRef, useState } from 'react'
import TacticsBoard from './components/TacticsBoard'
import { TitleScreen, MatchSelect } from './components/Intro'
import Tutorial from './components/Tutorial'
import { resolveSequence, planOffside, defenseTimeline, DEF_RADIUS } from './engine/resolve'
import { checkOffside, offsideLineX } from './engine/offside'
import { initDefense } from './engine/defense'
import { playSequence } from './engine/playback'
import { midpoint, ctrlFromHandle } from './engine/geometry'
import { actionDuration, reachRadius, clampToReach, throughTarget } from './engine/sheets'
import { planScore, planGrade } from './engine/xt'
import { isMuted, setMuted, resumeAudio, whistle, goalRoar, startMurmur, stopMurmur } from './engine/sound'
import { decodeShare, shareUrl } from './engine/share'
import playersData from './data/players.json'
import formations from './data/formations.json'
import scenario from './data/scenarios.json'
import './App.css'

const slots = formations['4-2-3-1']
const homeSquad = playersData.filter((p) => p.team === scenario.home)
const awaySquad = playersData.filter((p) => p.team === scenario.away)
const moment = scenario.moments[0]
// 모먼트가 위치를 직접 지정하면 그 좌표가 곧 그 시점의 온필드 명단(교체 반영, 로스터의 나머지는 벤치),
// 없으면 로스터 앞 11명을 포메이션 기본값으로 (상대는 좌우 반전)
const onPitch = (squad) => (moment.positions ? squad.filter((p) => moment.positions[p.id]) : squad)
const basePlayers = onPitch(homeSquad).map((p, i) => ({ ...p, x: slots[i]?.x, y: slots[i]?.y, ...moment.positions?.[p.id] }))
const opponents = onPitch(awaySquad).map((p, i) => ({ ...p, x: 120 - (slots[i]?.x ?? 0), y: 80 - (slots[i]?.y ?? 0), ...moment.positions?.[p.id] }))
const byId = Object.fromEntries([...basePlayers, ...opponents].map((p) => [p.id, p]))

// --- 공유 링크 해석 ---
// ?p= 는 "시드 + 전술"을 통째로 담은 공유 링크(engine/share.js). 받은 사람이 내가 짠
// 전술을 그대로 본다. ?seed= 만 있는 옛 링크도 계속 동작한다(시드만 재현).
// 선수 인덱스는 온필드 명단 순서 기준 — 인코딩·디코딩이 같은 배열을 봐야 한다.
const PLAYER_IDS = basePlayers.map((p) => p.id)
const QS = new URLSearchParams(window.location.search)
const SHARED = decodeShare(QS.get('p'), { playerIds: PLAYER_IDS })
const SEED_PARAM = Number(QS.get('seed'))
const HAS_SEED_LINK = !!SHARED || (Number.isFinite(SEED_PARAM) && SEED_PARAM > 0)
const SEED = SHARED ? SHARED.seed : HAS_SEED_LINK ? SEED_PARAM : Math.floor(Math.random() * 1e9)

const TYPE_LABEL = { dribble: '드리블', pass: '패스', shot: '슛' }
const OUTCOME_LABEL = {
  GOAL: '⚽ GOAL!',
  ADVANCE: '✅ 전개 성공',
  INTERCEPTED: '🛡️ 차단당함',
  MISS: '❌ 무산...',
  OFFSIDE: '🚩 오프사이드',
}

function App() {
  // 화면 흐름: intro → select → board. seed 공유 링크는 재현이 목적이므로 인트로를 건너뛴다.
  const [screen, setScreen] = useState(HAS_SEED_LINK ? 'board' : 'intro')
  // 공 전개 체인 (순서 있는 액션 리스트) — 같은 선수가 여러 번 드리블/수신 가능
  // { type:'dribble', to, ctrl } | { type:'pass'|'shot', receiverId, to(슛만), ctrl }
  const [chainActs, setChainActs] = useState(SHARED?.chainActs ?? [])
  // 오프볼 런 리스트: [{ id, to, ctrl|null, afterIndex }] — 선수당 여러 개 가능.
  // afterIndex = "체인의 이 인덱스 액션이 시작되기 전에 출발" — 앵커.
  // 받고→넘기고→또 뛰는 것처럼 같은 선수가 시점이 다른 런을 여러 개 가질 수 있다.
  const [runs, setRuns] = useState(SHARED?.runs ?? [])
  const [selectedId, setSelectedId] = useState(null)
  // 시트(페이즈) 모드 — 기존 원샷 설계와 병행하는 프로토타입 토글.
  // sheetCount = 확정된 시트 수. 그 인덱스의 시트가 지금 편집 중인 시트다.
  // viewSheet = 열람 중인 시트 (null이면 편집 중인 시트를 본다).
  const [sheetMode, setSheetMode] = useState(false)
  const [sheetCount, setSheetCount] = useState(0)
  const [viewSheet, setViewSheet] = useState(null)
  const [phase, setPhase] = useState('plan') // plan | playing | done
  const [result, setResult] = useState(null)
  const [frame, setFrame] = useState(null) // 재생 중 위치: { home, opp, ball, caption }
  const playbackRef = useRef(null) // playSequence가 돌려주는 { cancel }
  const [mutedUI, setMutedUI] = useState(isMuted())
  const [copied, setCopied] = useState(null) // 공유 버튼 피드백: null | 'ok' | 'fail'
  const goalSoundRef = useRef(false) // 재생 1회당 골 함성 1번만

  const basePos = (id) => ({ x: byId[id].x, y: byId[id].y })

  // 체인 + 런을 시간 순서대로 걸어가며 좌표를 유도.
  // 선수 위치가 체인을 따라 갱신되므로 "드리블→패스→되받아→다시 드리블",
  // "드리블→패스→오프볼 런→다시 받기"가 모두 이어진다.
  const { chain, runLegs, planPos, carrierId, snaps, carrierAt } = useMemo(() => {
    const pos = {} // 진행 중 선수별 현재 위치
    const posOf = (id) => pos[id] ?? basePos(id)
    const runLegMap = {}
    const len = chainActs.length
    const applyRunsAt = (i) => {
      runs.forEach((r, key) => {
        if (Math.min(r.afterIndex, len) === i && !runLegMap[key]) {
          const from = posOf(r.id)
          runLegMap[key] = { key, id: r.id, from, to: r.to, ctrl: r.ctrl ?? midpoint(from, r.to), afterIndex: r.afterIndex }
          pos[r.id] = r.to
        }
      })
    }
    // 시트 i가 "시작되기 직전"의 전원 좌표 스냅샷 — 시트 확정 시 위치가 굳는다는 게
    // 곧 이 스냅샷이다. 가동범위 동심원의 중심이자 이전 시트 열람의 표시 좌표.
    const snaps = []
    const carrierAt = []
    const snapshot = () => Object.fromEntries(basePlayers.map((p) => [p.id, posOf(p.id)]))
    let carrier = moment.ball
    const chain = chainActs.map((act, index) => {
      snaps.push(snapshot())
      carrierAt.push(carrier)
      applyRunsAt(index)
      const cur = posOf(carrier)
      if (act.type === 'dribble') {
        const leg = { type: 'dribble', actorId: carrier, from: cur, to: act.to, ctrl: act.ctrl ?? midpoint(cur, act.to), index }
        pos[carrier] = act.to
        return leg
      }
      const to = act.receiverId === 'GOAL' ? act.to : posOf(act.receiverId)
      const leg = { type: act.type, actorId: carrier, receiverId: act.receiverId, from: cur, to, ctrl: act.ctrl ?? midpoint(cur, to), index }
      if (act.receiverId !== 'GOAL') {
        pos[act.receiverId] = to
        carrier = act.receiverId
      }
      return leg
    })
    snaps.push(snapshot())
    carrierAt.push(carrier)
    applyRunsAt(len)
    const planPos = {}
    for (const p of basePlayers) planPos[p.id] = posOf(p.id)
    return { chain, runLegs: Object.values(runLegMap), planPos, carrierId: carrier, snaps, carrierAt }
  }, [chainActs, runs])

  // 플레이 설계 점수 (xT 델타 합) — 판정과 독립이라 계획 단계에서 바로 보여줘도
  // "성공률 프리뷰"가 되지 않는다. 확률이 아니라 "얼마나 위협적인 자리로 옮겼나"의 축.
  const plan = useMemo(() => planScore(chain), [chain])
  const grade = planGrade(plan.total)

  const shotTaken = chainActs.some((a) => a.type === 'shot')
  const ballPlanPos = chain.length ? chain[chain.length - 1].to : basePos(moment.ball)

  // 오프사이드 경고 (하이브리드 (a) 단계) — 설계는 막지 않고 빨간 점멸로만 알린다.
  // 실행 시의 확정 실패 판정과 같은 함수·같은 좌표를 쓴다 (engine/offside.js).
  const offsideWarn = useMemo(
    () => (chain.length ? planOffside(chain, { opponents, players: basePlayers }) : []),
    [chain],
  )
  const offsideIds = useMemo(() => new Set(offsideWarn.map((w) => w.receiverId)), [offsideWarn])

  // --- 스루패스 조준 중 오프사이드 미리보기 ---
  // "다음 액션이 마주할 수비 좌표" = 지금까지의 체인을 다 소화한 뒤의 수비 상태.
  // 실행 판정이 쓰는 defenseTimeline과 같은 함수라 미리보기와 실제 판정이 어긋나지 않는다.
  const pendingDefense = useMemo(() => {
    const tl = defenseTimeline(chain, { opponents, players: basePlayers })
    return tl.length ? tl[tl.length - 1].after : initDefense(opponents)
  }, [chain])
  const pendingOffsideLineX = useMemo(() => offsideLineX(pendingDefense), [pendingDefense])
  // 지금 이 순간 오프사이드 위치에 서 있는 아군 — 이들에게 스루패스를 주면 깃발이 오른다.
  // (뒤에서 출발해 달려드는 침투는 온사이드이므로, 여기 걸리는 건 "이미 넘어가 있는" 선수뿐)
  const offsidePosIds = useMemo(() => {
    const s = new Set()
    for (const p of basePlayers) {
      const at = planPos[p.id]
      if (!at) continue
      if (checkOffside({ receiver: at, opponents: pendingDefense, ball: ballPlanPos }).offside) s.add(p.id)
    }
    return s
  }, [planPos, pendingDefense, ballPlanPos])

  // --- 시트 모드 파생값 ---
  // 편집 중인 시트 = sheetCount 인덱스. 그 시트의 공 액션이 걸리는 시간이
  // 이번 시트에서 모두가 움직일 수 있는 시간 예산 = 동심원 반경의 근거.
  const editIndex = sheetCount
  const editLeg = chain[editIndex] ?? null
  const sheetDur = actionDuration(editLeg)
  const totalSheets = Math.max(chain.length, sheetCount + 1)
  // 열람 중인 시트 (null = 편집 중인 시트). 마지막 시트만 편집 가능.
  const shownSheet = viewSheet ?? editIndex
  const isViewingPast = viewSheet != null && viewSheet < editIndex

  // 가동범위 동심원 — 이번 시트 시작 좌표를 중심으로, 전력(100%)·여유(70%) 두 겹.
  // 공 액션을 아직 안 그렸으면 시간 예산이 0이라 원도 없다 (그리면 그때 나타난다).
  const reachCircles = useMemo(() => {
    if (!sheetMode || isViewingPast || phase !== 'plan' || !(sheetDur > 0)) return null
    const at = snaps[editIndex] ?? planPos
    return basePlayers
      .filter((p) => p.id !== carrierAt[editIndex]) // 공 소유자는 액션 본인이라 제외
      .map((p) => ({ id: p.id, ...at[p.id], r: reachRadius(p, sheetDur) }))
  }, [sheetMode, isViewingPast, phase, sheetDur, snaps, editIndex, planPos, carrierAt])

  // 시트 확정 — 이번 시트에 공 액션이 있어야 넘어갈 수 있다
  const canConfirmSheet = sheetMode && phase === 'plan' && !isViewingPast && chain.length > sheetCount
  const confirmSheet = () => {
    if (!canConfirmSheet) return
    setSheetCount((n) => n + 1)
    setViewSheet(null)
  }
  // 시트 삭제 = 그 시트부터 뒤로 전부 삭제 (체인이므로)
  const deleteSheetFrom = (i) => {
    setChainActs((cs) => cs.slice(0, i))
    setRuns((rs) => rs.filter((r) => r.afterIndex < i))
    setSheetCount(Math.min(sheetCount, i))
    setViewSheet(null)
  }

  // 이스터에그 — 실제 경기 재현 감지: 골로 끝났고, 마지막 슛을 실제 득점자가 쐈고,
  // 그에게 간 마지막 패스를 실제 도움 선수가 줬으면 "그날의 장면" 팝업을 띄운다.
  const egg = moment.easterEgg
  const [eggClosed, setEggClosed] = useState(false)
  const eggMatched = useMemo(() => {
    if (!egg || result?.outcome !== 'GOAL') return false
    const shot = chain[chain.length - 1]
    if (shot?.type !== 'shot' || shot.actorId !== egg.scorerId) return false
    const lastPass = chain.findLast((l) => l.type === 'pass')
    return lastPass?.actorId === egg.passerId && lastPass?.receiverId === egg.scorerId
  }, [egg, result, chain])

  // --- 오프볼 런 지시 ---
  // 드래그 시작(isFirst) 때 한 번만 판단: 이 선수의 마지막 런이 아직 체인에 "소비"되지
  // 않았으면(그 뒤로 받거나 준 적 없음) 그 런을 조정, 소비됐으면 새 런을 추가.
  // 소비된 런을 건드리면 그 위치로 유도된 패스 선들이 전부 따라 움직이기 때문.
  const setRunTarget = (id, to, isFirst) => {
    // 시트 모드: 이번 시트의 런은 이번 시트 시작 좌표에서 출발하고,
    // 공 액션이 걸리는 시간 안에 갈 수 있는 거리(동심원) 밖으로는 못 나간다.
    if (sheetMode) {
      const from = (snaps[editIndex] ?? planPos)[id]
      const player = byId[id]
      if (from && player && sheetDur > 0) to = clampToReach(from, to, reachRadius(player, sheetDur))
      return setRuns((rs) => {
        const mine = rs.findLastIndex((r) => r.id === id && r.afterIndex === editIndex)
        if (mine === -1) return [...rs, { id, to, ctrl: null, afterIndex: editIndex }]
        return rs.map((r, i) => (i === mine ? { ...r, to, ctrl: null } : r))
      })
    }
    setRuns((rs) => {
      const lastIdx = rs.findLastIndex((r) => r.id === id)
      if (isFirst) {
        const consumed =
          lastIdx === -1 ||
          chain.some((leg) => (leg.actorId === id || leg.receiverId === id) && leg.index >= rs[lastIdx].afterIndex)
        if (consumed) return [...rs, { id, to, ctrl: null, afterIndex: chainActs.length }]
      }
      return rs.map((r, i) => (i === lastIdx ? { ...r, to, ctrl: null } : r))
    })
  }
  const removeRun = (key) => setRuns((rs) => rs.filter((_, i) => i !== key))
  const setRunHandle = (key, h) => {
    const leg = runLegs.find((r) => r.key === key)
    if (!leg) return
    setRuns((rs) => rs.map((r, i) => (i === key ? { ...r, ctrl: ctrlFromHandle(leg.from, leg.to, h) } : r)))
  }

  // --- 체인 편집 ---
  // 공 가진 선수 드래그 = 드리블. 드래그 시작(isFirst)에 새 레그 추가, 이후엔 목표만 갱신.
  // 직전 레그가 이미 드리블이면 그 레그를 다시 조정하는 것으로 취급.
  const setDribble = (pt, isFirst) =>
    setChainActs((cs) => {
      const last = cs[cs.length - 1]
      // 시트 모드: 이번 시트에 이미 드리블이 있으면 그걸 조정, 다른 액션이면 무시
      if (sheetMode && cs.length > sheetCount) {
        if (last?.type !== 'dribble') return cs
        return cs.map((c, i) => (i === cs.length - 1 ? { ...c, to: pt, ctrl: isFirst ? null : c.ctrl } : c))
      }
      if (isFirst && last?.type !== 'dribble') return [...cs, { type: 'dribble', to: pt, ctrl: null }]
      return cs.map((c, i) => (i === cs.length - 1 ? { ...c, to: pt, ctrl: isFirst ? null : c.ctrl } : c))
    })
  const dropDribble = (pt) => {
    const leg = chain[chain.length - 1]
    if (leg?.type === 'dribble' && Math.hypot(pt.x - leg.from.x, pt.y - leg.from.y) < 3.5) {
      setChainActs((cs) => cs.slice(0, -1)) // 제자리로 되돌리면 드리블 취소
    }
  }
  // 시트 모드에서는 시트 1장에 공 액션 1개 — 이미 그렸으면 확정하고 넘어가야 한다
  const sheetFull = sheetMode && chain.length > sheetCount
  const addPass = (receiverId, to) => {
    if (sheetFull) return
    setChainActs((cs) => [...cs, { type: receiverId === 'GOAL' ? 'shot' : 'pass', receiverId, to, ctrl: null }])
  }
  // 스루패스 = "리시버의 침투 런" + "그 도착점으로 가는 패스".
  // 새 액션 타입을 만들지 않는다 — 런이 패스보다 먼저 적용되므로(applyRunsAt(i)가
  // 체인 i번 액션 앞에서 돈다) 패스의 도착점이 자동으로 그 공간이 되고,
  // 판정·연출·오프사이드가 전부 기존 경로를 그대로 탄다.
  //   · playback: 런의 consumer가 이 패스라 "공 도착 시각에 맞춰 도착"하도록 역산된다 = 침투
  //   · offside : 판정 기준은 패스 출발 순간의 리시버 좌표(런 반영 전)라 온사이드가 된다
  // 찍은 지점 → 실제로 성립하는 도착점. 조준 중 미리보기와 확정이 같은 계산을 쓰도록
  // 한 곳에 모아둔다 (미리보기와 결과가 다르면 그게 제일 나쁜 UX다).
  const throughTargetOf = (receiverId, pt) => {
    if (!sheetMode) return pt // 원샷 모드는 자유 — playback이 타이밍을 맞춰준다
    // 이 시트의 sheetDur은 "이미 그려진 공 액션"의 시간이라, 지금 만들려는 패스에는
    // 쓸 수 없다(아직 체인에 없어서 0이다). 대신 "공과 사람이 같이 도착"하는 조건을
    // 직접 풀어 도착점을 잡는다 (engine/sheets.js throughTarget 주석 참고).
    const idx = chainActs.length
    const at = snaps[idx] ?? planPos
    const runnerFrom = at[receiverId]
    const ballFrom = at[carrierAt[idx] ?? carrierId] ?? ballPlanPos
    const player = byId[receiverId]
    if (!runnerFrom || !ballFrom || !player) return pt
    return throughTarget({ runnerFrom, ballFrom, want: pt, player })
  }

  const addThroughPass = (receiverId, pt) => {
    if (sheetFull) return
    const idx = chainActs.length // 이 패스가 놓일 체인 인덱스 = 런의 앵커
    const to = throughTargetOf(receiverId, pt)
    setRuns((rs) => [...rs, { id: receiverId, to, ctrl: null, afterIndex: idx }])
    setChainActs((cs) => [...cs, { type: 'pass', receiverId, to: null, ctrl: null, through: true }])
  }

  const setChainHandle = (i, h) => {
    const leg = chain[i]
    if (!leg) return
    setChainActs((cs) => cs.map((c, idx) => (idx === i ? { ...c, ctrl: ctrlFromHandle(leg.from, leg.to, h) } : c)))
  }
  // 체인이므로 그 뒤도 함께 삭제. 시트 모드면 확정 시트 수도 되돌린다.
  const removeChainFrom = (i) => {
    setChainActs((cs) => cs.slice(0, i))
    if (sheetMode) {
      setRuns((rs) => rs.filter((r) => r.afterIndex < i))
      setSheetCount((n) => Math.min(n, i))
      setViewSheet(null)
    }
  }

  // --- 공유 링크 ---
  // 시드 + 전술을 통째로 담은 URL. 주소창도 같이 갱신해 두면 버튼을 못 쓰는 환경
  // (클립보드 권한 거부 등)에서도 주소창 복사가 곧 공유가 된다.
  const currentShareUrl = () =>
    shareUrl({
      seed: SEED,
      chainActs,
      runs,
      playerIds: PLAYER_IDS,
      origin: window.location.origin,
      pathname: window.location.pathname,
    })
  async function copyShareLink() {
    const url = currentShareUrl()
    try {
      await navigator.clipboard.writeText(url)
      setCopied('ok')
    } catch {
      setCopied('fail') // HTTPS가 아니거나 권한 거부 — 주소창에는 이미 같은 링크가 들어가 있다
    }
    setTimeout(() => setCopied(null), 2400)
  }

  // --- 확정 → 판정 → 재생 ---
  // 판정은 resolveSequence(스냅샷 1회), 연출은 playSequence(engine/playback.js)가 전담
  function handleConfirm() {
    if (!chain.length || phase === 'playing') return
    // 실행하는 순간의 전술을 주소창에 반영 — 새로고침·주소창 복사로도 같은 장면이 재현된다
    window.history.replaceState(null, '', currentShareUrl())
    const actions = chain.map((leg) => ({ ...leg, actor: byId[leg.actorId] }))
    // players: 수비 재배치의 마킹 대상 (계획 시작 좌표 기준 — 런 반영은 액션 진행 중 근사)
    const res = resolveSequence(actions, { opponents, players: basePlayers, seed: SEED })
    setResult(res)
    setEggClosed(false)
    setPhase('playing')
    // 사운드: 버튼 클릭(사용자 제스처) 안이라 여기서 오디오를 깨울 수 있다.
    // 주심 휘슬로 플레이를 시작하고, 재생 동안 관중 웅성거림을 깔아둔다.
    resumeAudio()
    goalSoundRef.current = false
    whistle({ duration: 0.32, freq: 2350 })
    startMurmur()
    playbackRef.current = playSequence({
      actions,
      result: res,
      runLegs,
      players: basePlayers,
      opponents,
      byId,
      ballOwnerId: moment.ball,
      seed: SEED,
      onFrame: setFrame,
      onDone: () => setPhase('done'),
    })
  }

  // 골 순간(플래시가 뜨는 프레임)에 함성 — playback이 이미 그 타이밍을 알고 있으므로
  // 사운드 전용 타이머를 따로 두지 않고 연출 신호에 얹는다.
  useEffect(() => {
    if (frame?.fx?.flash > 0 && !goalSoundRef.current) {
      goalSoundRef.current = true
      goalRoar()
    }
  }, [frame])

  // 재생이 끝나거나 화면을 떠나면 앰비언트를 정리한다
  useEffect(() => {
    if (phase === 'plan') stopMurmur()
  }, [phase])
  useEffect(() => stopMurmur, [])

  function backToPlan() {
    playbackRef.current?.cancel()
    stopMurmur()
    setPhase('plan')
    setFrame(null)
    setResult(null)
  }
  function clearAll() {
    backToPlan()
    setChainActs([])
    setRuns([])
    setSheetCount(0)
    setViewSheet(null)
  }

  const selected = selectedId ? byId[selectedId] : null

  // 보드에서 경기 선택으로 — 재생 중이면 끊고 결과를 정리 (전술 설계는 유지)
  function goToSelect() {
    backToPlan()
    setScreen('select')
  }

  if (screen === 'intro') return <TitleScreen onStart={() => setScreen('select')} />
  if (screen === 'select')
    return (
      <MatchSelect
        onPick={() => setScreen('board')}
        onBack={() => setScreen('intro')}
        onTutorial={() => setScreen('tutorial')}
      />
    )
  if (screen === 'tutorial')
    return <Tutorial onDone={() => setScreen('board')} onBack={() => setScreen('select')} />

  return (
    <div className="app">
      {/* 터치 기기 + 세로 화면일 때만 CSS로 표시 (인트로·선택 화면은 세로도 허용) */}
      <div className="rotate-hint">
        <div className="rotate-hint-phone">📱</div>
        <p>화면을 옆으로 돌려주세요</p>
        <span>전술보드는 가로 화면에 최적화되어 있어요</span>
      </div>

      <header>
        <div className="header-row">
          <button className="ctrl board-back" onClick={goToSelect} title="경기 선택으로 돌아가기">‹</button>
          <h1>⚽ 터치라인 <span className="sub">전술보드 프로토타입</span></h1>
          <button
            className="ctrl sound-toggle"
            onClick={() => {
              const next = setMuted(!mutedUI)
              setMutedUI(next)
              if (!next) resumeAudio()
            }}
            title={mutedUI ? '소리 켜기' : '소리 끄기'}
            aria-label={mutedUI ? '소리 켜기' : '소리 끄기'}
          >
            {mutedUI ? '🔇' : '🔊'}
          </button>
        </div>
        <div className="mission-card">
          <div className="mission-title">{scenario.title}</div>
          <div className="mission-body">
            <strong>{moment.minute}'</strong> · 스코어 {moment.score[0]} : {moment.score[1]} — {moment.situation}
          </div>
        </div>
      </header>

      <main>
        <div className="board-col">
          {/* 설계 모드 전환 + 시트 탭 — 기존 원샷 모드를 대체하지 않는 병행 프로토타입 */}
          <div className="sheet-bar">
            <button
              className={`mode-toggle${sheetMode ? ' on' : ''}`}
              onClick={() => {
                setSheetMode((v) => !v)
                setViewSheet(null)
                setSheetCount(chainActs.length)
              }}
              disabled={phase !== 'plan'}
              title="시트 모드: 액션 1개 + 오프볼 런 = 시트 1장씩 확정해 나가는 설계"
            >
              {sheetMode ? '📑 시트 모드' : '📄 원샷 모드'}
            </button>
            {sheetMode && (
              <>
                <div className="sheet-tabs">
                  {Array.from({ length: totalSheets }, (_, i) => (
                    <button
                      key={i}
                      className={`sheet-tab${shownSheet === i ? ' active' : ''}${i < sheetCount ? ' locked' : ''}`}
                      onClick={() => setViewSheet(i === editIndex ? null : i)}
                      title={i < sheetCount ? '확정된 시트 (열람만)' : '편집 중인 시트'}
                    >
                      시트 {i + 1}
                      {i < sheetCount ? ' 🔒' : ''}
                    </button>
                  ))}
                </div>
                {canConfirmSheet && (
                  <button className="ctrl sheet-confirm" onClick={confirmSheet}>
                    시트 {editIndex + 1} 확정 → 다음 ▶
                  </button>
                )}
                {isViewingPast && (
                  <button className="ctrl" onClick={() => setViewSheet(null)}>
                    편집 중인 시트로 ↩
                  </button>
                )}
                {sheetCount > 0 && !isViewingPast && (
                  <button className="ctrl sheet-del" onClick={() => deleteSheetFrom(editIndex - 1)}>
                    이전 시트 삭제
                  </button>
                )}
              </>
            )}
          </div>
          {sheetMode && phase === 'plan' && (
            <p className="sheet-hint">
              {isViewingPast
                ? `시트 ${shownSheet + 1} 열람 중 — 확정된 시트는 수정할 수 없습니다.`
                : sheetFull
                  ? `이 시트의 공 액션을 그렸습니다. 오프볼 런을 더 넣거나, 확정해 다음 시트로 넘어가세요.`
                  : `시트 ${editIndex + 1}: 공 액션(드리블/패스/슛) 하나를 그리면 동심원(그 시간 안에 갈 수 있는 범위)이 나타납니다.`}
            </p>
          )}
          {/* 셰이크(슛·골·차단 순간)는 이 래퍼의 transform으로 — 보드 내부 좌표는 불변 */}
          <div
            className={`board-wrap${frame?.fx?.slowmo ? ' slowmo' : ''}`}
            style={frame?.fx ? { transform: `translate(${frame.fx.dx}px, ${frame.fx.dy}px)` } : undefined}
          >
            <TacticsBoard
              players={basePlayers}
              opponents={opponents}
              // 이전 시트를 열람 중이면 그 시점까지의 체인·좌표만 보여준다
              runLegs={isViewingPast ? runLegs.filter((r) => r.afterIndex <= shownSheet) : runLegs}
              chain={isViewingPast ? chain.slice(0, shownSheet + 1) : chain}
              planPos={isViewingPast ? (snaps[shownSheet + 1] ?? planPos) : planPos}
              carrierId={isViewingPast ? (carrierAt[shownSheet + 1] ?? carrierId) : carrierId}
              shotTaken={shotTaken}
              reachCircles={reachCircles}
              ballPos={phase === 'plan' ? ballPlanPos : frame?.ball}
              ballTrail={phase === 'plan' ? null : frame?.ballTrail}
              displayHome={phase === 'plan' ? null : frame?.home}
              displayOpp={phase === 'plan' ? null : frame?.opp}
              interactive={phase === 'plan' && !isViewingPast}
              defRadius={DEF_RADIUS}
              offsideIds={offsideIds}
              offsideLineX={offsideWarn[0]?.lineX ?? null}
              offsideFx={phase !== 'plan' ? frame?.fx : null}
              selectedId={selectedId}
              onPlayerClick={(id) => setSelectedId((prev) => (prev === id ? null : id))}
              onRunSet={setRunTarget}
              onRunRemove={removeRun}
              onRunHandle={setRunHandle}
              onDribbleSet={setDribble}
              onDribbleDrop={dropDribble}
              onChainHandle={setChainHandle}
              onPassCommit={addPass}
              onThroughCommit={addThroughPass}
              throughTargetOf={throughTargetOf}
              pendingOffsideLineX={pendingOffsideLineX}
              offsidePosIds={offsidePosIds}
            />
            {frame?.fx?.flash > 0 && <div className="board-flash" style={{ opacity: frame.fx.flash * 0.55 }} />}
          </div>
          <div className="commentary-row">
            <div className={`commentary ${phase !== 'plan' && frame?.caption ? 'live' : ''}`}>
              <span key={frame?.caption ?? 'idle'}>
                {phase === 'plan' || !frame?.caption ? `🎯 ${moment.objective}` : `📢 ${frame.caption}`}
              </span>
            </div>
            <button className="kickoff" onClick={handleConfirm} disabled={!chain.length || phase === 'playing'}>
              {phase === 'playing' ? '재생 중…' : '전술 확정 — 실행 ▶'}
            </button>
            {phase !== 'plan' && (
              <>
                <button className="ctrl" onClick={backToPlan}>다시 조정</button>
                <button className="ctrl" onClick={clearAll}>전부 지우기</button>
              </>
            )}
          </div>
        </div>

        <div className="bottom-grid">
          <section className="panel">
            <h2>실행 결과</h2>
            {result && phase === 'done' ? (
              <div
                className={`result ${
                  result.outcome === 'GOAL' || result.outcome === 'ADVANCE'
                    ? 'goal'
                    : result.outcome === 'OFFSIDE'
                      ? 'offside'
                      : 'miss'
                }`}
              >
                <div className="outcome">{OUTCOME_LABEL[result.outcome]}</div>
                <div className="rate">시퀀스 전체 성공 확률 {(result.pTotal * 100).toFixed(0)}%</div>
                <ul className="steps">
                  {result.steps.map((s, i) => (
                    <li key={i} className={s.success === null ? 'step-skip' : s.success ? 'step-ok' : 'step-fail'}>
                      <span>{i + 1}. {TYPE_LABEL[s.type]}{s.offside ? ' 🚩' : ''}</span>
                      {/* 오프사이드는 확률 판정을 거치지 않은 확정 실패 — %를 보여주면 오해를 부른다 */}
                      <span>{s.offside ? '오프사이드 ✗' : `${(s.p * 100).toFixed(0)}% ${s.success === null ? '―' : s.success ? '✓' : '✗'}`}</span>
                    </li>
                  ))}
                </ul>
                <div className="reason">{result.reason}</div>
                {/* 공유: 시드뿐 아니라 전술 체인까지 링크에 담는다 — 받은 사람이 같은 장면을 그대로 본다 */}
                <button className="share-btn" onClick={copyShareLink}>
                  {copied === 'ok' ? '✅ 링크 복사됨!' : copied === 'fail' ? '⚠️ 복사 실패 — 주소창을 복사해주세요' : '🔗 이 전술 공유하기'}
                </button>
                <div className="seed">seed {result.seed} — 같은 링크를 연 사람은 이 전술·이 결과를 그대로 봅니다</div>
              </div>
            ) : (
              <p className="muted">{phase === 'playing' ? '재생 중…' : '전개를 설계하고 전술 확정을 누르면 결과가 표시됩니다.'}</p>
            )}
          </section>

          <section className="panel">
            <h2>액션 시퀀스</h2>
            {chain.length === 0 && runLegs.length === 0 ? (
              <p className="muted">공이나 선수를 드래그해 전개를 설계하세요. 공은 지금 {byId[moment.ball].name}에게 있습니다.</p>
            ) : (
              <ul className="actions-list">
                {chain.map((leg, i) => (
                  <li key={`c${i}`} className="action-row">
                    <span>
                      {i + 1}. {chainActs[leg.index]?.through ? '스루패스' : TYPE_LABEL[leg.type]} — {byId[leg.actorId].name}
                      {leg.type === 'pass' ? ` → ${byId[leg.receiverId].name}` : leg.type === 'shot' ? ' → 골문' : ''}
                    </span>
                    {phase === 'plan' && (
                      <button onClick={() => removeChainFrom(leg.index)} title="이 액션부터 뒤로 전부 삭제">✕</button>
                    )}
                  </li>
                ))}
                {chain.length > 0 && offsideWarn.length > 0 && phase === 'plan' && (
                  <li className="offside-note">
                    🚩 {offsideWarn.map((w) => byId[w.receiverId]?.name).join(', ')} — 패스가 떠나는 순간 최후방 2번째
                    수비수보다 앞서 있습니다. 이대로 실행하면 오프사이드로 깃발이 올라갑니다.
                  </li>
                )}
                {runLegs.map((rl) => (
                  <li key={`m${rl.key}`} className="action-row off-ball">
                    <span>
                      런 — {byId[rl.id].name}
                      {rl.afterIndex > 0 ? ` (${Math.min(rl.afterIndex, chain.length)}번 액션 후)` : ''}
                    </span>
                    {phase === 'plan' && <button onClick={() => removeRun(rl.key)}>✕</button>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel">
            <h2>플레이 설계 점수</h2>
            {chain.length === 0 ? (
              <p className="muted">전개를 설계하면 위협도(xT) 변화가 표시됩니다.</p>
            ) : (
              <div className="plan-score">
                <div className="plan-head">
                  <span className={`plan-grade g-${grade.label}`}>{grade.label}</span>
                  <span className={`plan-total ${plan.total >= 0 ? 'up' : 'down'}`}>
                    {plan.total >= 0 ? '+' : ''}
                    {(plan.total * 100).toFixed(1)}
                  </span>
                </div>
                <div className="plan-text">{grade.text}</div>
                <ul className="plan-steps">
                  {plan.steps.map((s) => (
                    <li key={s.index}>
                      <span>{s.index + 1}. {TYPE_LABEL[s.type]}</span>
                      <span className={s.delta >= 0 ? 'up' : 'down'}>
                        {s.delta >= 0 ? '+' : ''}
                        {(s.delta * 100).toFixed(1)}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="plan-note">
                  각 스텝이 공을 얼마나 위협적인 지역으로 옮겼는지(xT 델타)의 합입니다.
                  <b> 성공 확률과는 무관</b>합니다 — 판정은 실행해봐야 압니다.
                </div>
              </div>
            )}
          </section>

          <section className="panel">
            <h2>선수 정보</h2>
            {selected ? (
              <div className="player-card">
                <div className="player-name">
                  #{selected.number} {selected.name}{' '}
                  <span className="pos">
                    {selected.position} · {selected.roles.join('/')} · {selected.heightCm}cm
                    {selected.statSource === 'estimate' ? ' · 추정치' : ''}
                  </span>
                </div>
                <dl className="stats">
                  <div><dt>개인기</dt><dd>{selected.stats.flair}</dd></div>
                  <div><dt>드리블</dt><dd>{selected.stats.dribbling}</dd></div>
                  <div><dt>패스</dt><dd>{selected.stats.passing}</dd></div>
                  <div><dt>골결정</dt><dd>{selected.stats.finishing}</dd></div>
                  <div><dt>중거리</dt><dd>{selected.stats.longshots}</dd></div>
                  <div><dt>헤더</dt><dd>{selected.stats.heading}</dd></div>
                  <div><dt>주력</dt><dd>{selected.stats.pace}</dd></div>
                  <div><dt>몸싸움</dt><dd>{selected.stats.strength}</dd></div>
                  <div><dt>태클</dt><dd>{selected.stats.tackle}</dd></div>
                  <div><dt>마크</dt><dd>{selected.stats.marking}</dd></div>
                  <div><dt>위치선정</dt><dd>{selected.stats.positioning}</dd></div>
                  <div><dt>예측력</dt><dd>{selected.stats.anticipation}</dd></div>
                </dl>
              </div>
            ) : (
              <p className="muted">선수를 클릭하면 능력치가 표시됩니다.</p>
            )}
          </section>

          <section className="panel">
            <h2>조작법</h2>
            <ul className="help">
              <li><b>공 가진 선수 탭</b> — 액션 메뉴 (드리블 / 패스 / 슛 / 능력치)</li>
              <li><b>공 가진 선수 드래그</b> — 곧바로 드리블 (메뉴 없이)</li>
              <li><b>다른 아군 드래그</b> — 오프볼 런 (공 넘긴 뒤에도 가능) · <b>탭</b> — 능력치</li>
              <li><b>공(⚪) 드래그</b> — 동료에게 놓으면 패스</li>
              <li><b>선 가운데 점 드래그</b> — 궤적 휘기</li>
            </ul>
          </section>
        </div>
      </main>

      {/* 이스터에그 — 실제 경기와 같은 전개로 골: 그날의 실제 장면 팝업 */}
      {phase === 'done' && eggMatched && !eggClosed && (
        <div className="egg-overlay" onClick={() => setEggClosed(true)}>
          <div className="egg-card" onClick={(e) => e.stopPropagation()}>
            <div className="egg-badge">🏆 재현 성공 — 실제 역사와 같은 전개!</div>
            <h3>{egg.title}</h3>
            <div className="egg-photos">
              {egg.images?.length ? (
                egg.images.map((src) => <img key={src} src={src} alt={egg.title} />)
              ) : (
                <div className="egg-placeholder">
                  <span>📸</span>
                  <p>실제 장면 이미지 자리</p>
                  <small>public/moments/에 이미지를 넣고 scenarios.json의 easterEgg.images에 경로(예: "/moments/m91_goal.jpg")를 추가하면 여기에 표시됩니다.</small>
                </div>
              )}
            </div>
            <p className="egg-caption">{egg.caption}</p>
            <button className="ctrl egg-close" onClick={() => setEggClosed(true)}>닫기 ✕</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
