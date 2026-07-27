import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import TacticsBoard from './components/TacticsBoard'
import { TitleScreen, MatchSelect } from './components/Intro'
import Kickoff from './components/Kickoff'
import { TutorialCoach } from './components/Tutorial'
import { TUTORIAL_STEPS } from './components/tutorialSteps'
import { resolveSequence, planOffside, defenseTimeline, DEF_RADIUS } from './engine/resolve'
import { checkOffside } from './engine/offside'
import { initDefense } from './engine/defense'
import { playSequence } from './engine/playback'
import { midpoint, ctrlFromHandle, clampHandle, clampCtrl } from './engine/geometry'
import { actionDuration, reachRadius, clampToReach, throughPassSpeed, throughTarget } from './engine/sheets'
import { isMuted, setMuted, resumeAudio, whistle, goalRoar, startMurmur, stopMurmur } from './engine/sound'
import { decodeShare, shareUrl } from './engine/share'
import { buildMatch, findMatch } from './data/matches'
import './App.css'

// --- 공유 링크 해석 ---
// ?p= 는 "시드 + 전술"을 통째로 담은 공유 링크(engine/share.js). 받은 사람이 내가 짠
// 전술을 그대로 본다. ?seed= 만 있는 옛 링크도 계속 동작한다(시드만 재현).
// 선수 인덱스는 온필드 명단 순서 기준 — 인코딩·디코딩이 같은 배열을 봐야 한다.
// 그 명단은 경기마다 다르므로 ?m=(경기 id)을 먼저 읽어 명단을 정한 뒤 전술을 푼다.
// ?m= 이 없는 옛 링크는 기본 경기(대한민국-포르투갈) 명단으로 풀린다 — 그때는 경기가 하나뿐이었다.
const QS = new URLSearchParams(window.location.search)
const INITIAL_MATCH = findMatch(QS.get('m'))
const SHARED = decodeShare(QS.get('p'), { playerIds: buildMatch(INITIAL_MATCH).playerIds })
const SEED_PARAM = Number(QS.get('seed'))
const HAS_SEED_LINK = !!SHARED || (Number.isFinite(SEED_PARAM) && SEED_PARAM > 0)
const rollSeed = () => Math.floor(Math.random() * 1e9)
// 공유 링크로 들어왔으면 그 시드로 시작(결과 재현), 아니면 새로 굴린다.
const INITIAL_SEED = SHARED ? SHARED.seed : HAS_SEED_LINK ? SEED_PARAM : rollSeed()

// 좌표 편집은 장면을 만드는 사람이 쓰는 개발 도구다. import.meta.env.DEV는 빌드 때
// false로 접혀서, 관련 UI와 저장 코드는 배포 번들에 아예 들어가지 않는다.
const EDITABLE = import.meta.env.DEV

// 가동범위 동심원은 시트 모드의 대표 시각 요소다. 원샷 모드에서도 드리블 뒤에는
// 같은 원이 뜨는데(아래 oneShotDribbleIndex), 튜토리얼에서 시트 모드를 설명하기 전에
// 먼저 나타나면 "모드가 저절로 바뀐 건가?"로 읽힌다. 그래서 시트 단계 전까지는 감춘다.
const SHEET_STEP_INDEX = TUTORIAL_STEPS.findIndex((s) => s.id === 'sheet')

const TYPE_LABEL = { dribble: '드리블', pass: '패스', shot: '슛' }
const PASS_KIND_LABEL = {
  ground: '패스',
  pass: '패스',
  lob: '로빙패스',
  through: '스루패스',
  lobThrough: '로빙스루',
}
const OUTCOME_LABEL = {
  GOAL: '⚽ GOAL!',
  ADVANCE: '✅ 전개 성공',
  INTERCEPTED: '🛡️ 차단당함',
  SAVED: '🧤 선방!',
  MISS: '❌ 무산...',
  OFFSIDE: '🚩 오프사이드',
}

function App() {
  // 화면 흐름: intro → select → kickoff → board.
  // seed 공유 링크는 재현이 목적이므로 인트로도 오프닝도 건너뛰고 바로 보드로 간다 —
  // 링크를 받은 사람이 보러 온 건 "그 사람이 짠 전술"이지 경기 소개가 아니다.
  const [screen, setScreen] = useState(HAS_SEED_LINK ? 'board' : 'intro')
  // 선택된 경기. 여기서 온필드 명단·시작 좌표가 전부 유도되므로, 경기가 바뀌면
  // 아래 파생값이 통째로 새로 계산된다(그래서 전술도 같이 비워야 한다 — pickMatch 참고).
  const [matchId, setMatchId] = useState(INITIAL_MATCH.match_id)
  // 튜토리얼: 실제 보드 위에서 돈다. null이면 비활성.
  // tutReading = 설명 카드를 보는 중 / false면 그 기술을 직접 해보는 중.
  const [tutStep, setTutStep] = useState(null)
  const [tutReading, setTutReading] = useState(true)
  // 좌표 편집 모드 (개발 전용, 프로덕션 번들에서는 통째로 빠진다 — EDITABLE 참고).
  // editPos = 아직 저장 안 한 좌표 (id → {x,y}). null이면 데이터 원본 그대로.
  const [editMode, setEditMode] = useState(false)
  const [editPos, setEditPos] = useState(null)
  const [saveMsg, setSaveMsg] = useState(null)
  const { scenario, moment, basePlayers, opponents, byId, playerIds: PLAYER_IDS } = useMemo(() => {
    const m = buildMatch(findMatch(matchId))
    if (!editPos) return m
    // 편집 중인 좌표를 명단 위에 얹는다. 여기서 갈아끼우면 planPos·체인·수비 반응까지
    // 전부 새 좌표로 따라온다 — 편집 결과를 그대로 실행해볼 수 있다.
    const apply = (arr) => arr.map((p) => (editPos[p.id] ? { ...p, ...editPos[p.id] } : p))
    const nextHome = apply(m.basePlayers)
    const nextOpp = apply(m.opponents)
    return {
      ...m,
      basePlayers: nextHome,
      opponents: nextOpp,
      byId: Object.fromEntries([...nextHome, ...nextOpp].map((p) => [p.id, p])),
    }
  }, [matchId, editPos])
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
  // 시드 — "다음 실행에 쓸 값". 확정할 때마다 이 값으로 판을 돌리고 곧바로 새로 굴려 두므로,
  // "다시 조정" 없이 실행만 다시 눌러도 매번 다른 결과가 나온다(A안). 공유 링크에는 실행된
  // 결과의 시드(result.seed)가 박혀서, 받은 사람은 같은 첫 판을 그대로 재현한다.
  const [seed, setSeed] = useState(INITIAL_SEED)
  const goalSoundRef = useRef(false) // 재생 1회당 골 함성 1번만

  // 경기가 바뀌면 byId가 통째로 갈리므로 basePos도 같이 새로 만들어져야 한다
  const basePos = useCallback((id) => ({ x: byId[id].x, y: byId[id].y }), [byId])

  // 체인 + 런을 시간 순서대로 걸어가며 좌표를 유도.
  // 선수 위치가 체인을 따라 갱신되므로 "드리블→패스→되받아→다시 드리블",
  // "드리블→패스→오프볼 런→다시 받기"가 모두 이어진다.
  const { chain, runLegs, planPos, carrierId, snaps, carrierAt } = useMemo(() => {
    const pos = {} // 진행 중 선수별 현재 위치
    const posOf = (id) => pos[id] ?? basePos(id)
    const runLegMap = {}
    const len = chainActs.length
    const applyRunsAt = (i, { timeBudget = null, throughBallFrom = null, throughReceiverId = null, passKind = 'through' } = {}) => {
      runs.forEach((r, key) => {
        if (Math.min(r.afterIndex, len) === i && !runLegMap[key]) {
          const from = posOf(r.id)
          // A run tied to a dribble must use the same time budget everywhere:
          // radius display, planned receiver position, and playback.
          const player = byId[r.id]
          let to = timeBudget != null && player
            ? clampToReach(from, r.to, reachRadius(player, timeBudget))
            : r.to
          // A through-pass receiver must be at the endpoint when the ball is
          // there.  Recalculate older/shared targets too, not only newly drawn
          // through passes, so planning and playback cannot diverge.
          if (throughBallFrom && r.id === throughReceiverId && player) {
            to = throughTarget({ runnerFrom: from, ballFrom: throughBallFrom, want: to, player, passKind })
          }
          runLegMap[key] = { key, id: r.id, from, to, ctrl: clampCtrl(from, to, r.ctrl, 'run'), afterIndex: r.afterIndex }
          pos[r.id] = to
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
      const cur = posOf(carrier)
      if (act.type === 'dribble') {
        // Clamp parallel off-ball runs again while deriving the actual chain.
        // This also repairs older shared plans whose saved target predates the
        // reach-radius rule, so the subsequent pass uses the same endpoint.
        // 곡률은 여기서 한 번 더 상한을 통과시킨다 — 공유 링크·옛 저장분처럼
        // 드래그를 거치지 않고 들어온 ctrl도 판정·연출이 같은 궤적을 보게 된다.
        const ctrl = clampCtrl(cur, act.to, act.ctrl, 'dribble')
        const timingLeg = { type: 'dribble', from: cur, to: act.to, ctrl }
        applyRunsAt(index, { timeBudget: actionDuration(timingLeg) })
        const leg = { type: 'dribble', actorId: carrier, from: cur, to: act.to, ctrl, index }
        pos[carrier] = act.to
        return leg
      }
      const isThrough = act.through || act.passKind === 'through' || act.passKind === 'lobThrough'
      const receiverFrom = act.receiverId === 'GOAL' ? null : posOf(act.receiverId)
      applyRunsAt(index, isThrough
        ? { throughBallFrom: cur, throughReceiverId: act.receiverId, passKind: act.passKind ?? 'through' }
        : undefined)
      const to = act.receiverId === 'GOAL' ? act.to : posOf(act.receiverId)
      const passKind = act.passKind ?? (act.through ? 'through' : 'ground')
      const passSpeed = isThrough && receiverFrom && byId[act.receiverId]
        ? throughPassSpeed({ runnerFrom: receiverFrom, ballFrom: cur, to, player: byId[act.receiverId], passKind })
        : undefined
      const leg = {
        type: act.type,
        passKind,
        passSpeed,
        actorId: carrier,
        receiverId: act.receiverId,
        from: cur,
        to,
        ctrl: clampCtrl(cur, to, act.ctrl, act.type),
        index,
      }
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
  }, [chainActs, runs, basePlayers, basePos, byId, moment])

  const shotTaken = chainActs.some((a) => a.type === 'shot')
  const ballPlanPos = chain.length ? chain[chain.length - 1].to : basePos(moment.ball)

  // 오프사이드 경고 (하이브리드 (a) 단계) — 설계는 막지 않고 빨간 점멸로만 알린다.
  // 실행 시의 확정 실패 판정과 같은 함수·같은 좌표를 쓴다 (engine/offside.js).
  const offsideWarn = useMemo(
    () => (chain.length ? planOffside(chain, { opponents, players: basePlayers }) : []),
    [chain, opponents, basePlayers],
  )
  const offsideIds = useMemo(() => new Set(offsideWarn.map((w) => w.receiverId)), [offsideWarn])

  // --- 스루패스 조준 중 오프사이드 미리보기 ---
  // "다음 액션이 마주할 수비 좌표" = 지금까지의 체인을 다 소화한 뒤의 수비 상태.
  // 실행 판정이 쓰는 defenseTimeline과 같은 함수라 미리보기와 실제 판정이 어긋나지 않는다.
  const pendingDefense = useMemo(() => {
    const tl = defenseTimeline(chain, { opponents, players: basePlayers })
    return tl.length ? tl[tl.length - 1].after : initDefense(opponents)
  }, [chain, opponents, basePlayers])
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
  }, [planPos, pendingDefense, ballPlanPos, basePlayers])

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
  const oneShotDribbleIndex =
    !sheetMode && chainActs.length > 0 && chainActs[chainActs.length - 1]?.type === 'dribble'
      ? chainActs.length - 1
      : null
  // 원샷에서도 마지막 액션이 드리블이면 그 드리블 시간 동안의 오프볼 런을
  // 같은 시트처럼 취급한다. 반경 표시·좌표 제한·재생 타이밍이 함께 맞춰진다.
  const runWindowIndex = sheetMode ? editIndex : oneShotDribbleIndex
  const runWindowLeg = runWindowIndex != null ? chain[runWindowIndex] : null
  const runWindowDur = runWindowLeg ? actionDuration(runWindowLeg) : 0
  // 튜토리얼이 시트 단계에 닿기 전에는 동심원을 숨긴다 (SHEET_STEP_INDEX 주석 참고).
  // 시트 모드를 직접 켠 상태라면 그건 사용자가 의도한 것이므로 그대로 보여준다.
  const tutHidesReach = tutStep != null && tutStep < SHEET_STEP_INDEX && !sheetMode
  const reachCircles = useMemo(() => {
    if (tutHidesReach) return null
    if (runWindowIndex == null || isViewingPast || phase !== 'plan' || !(runWindowDur > 0)) return null
    const at = snaps[runWindowIndex] ?? planPos
    return basePlayers
      .filter((p) => p.id !== carrierAt[runWindowIndex]) // 공 소유자는 액션 본인이라 제외
      .map((p) => ({ id: p.id, ...at[p.id], r: reachRadius(p, runWindowDur) }))
  }, [tutHidesReach, runWindowIndex, isViewingPast, phase, runWindowDur, snaps, planPos, carrierAt, basePlayers])

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

  // 이스터에그 — 실제 경기 재현 감지.
  // 새 방식(egg.sequence 있으면): 골로 끝났고, "공을 주고받은 선수 순서"가 시나리오와
  //   똑같고, 마지막 슛을 친 위치가 실제 슛 지점(egg.shot) 근처(tol 반경)면 성공.
  //   드리블·패스를 정확히 어디서 했는지는 보지 않는다 — 순서와 마무리 지점만.
  // 구 방식(폴백): 골 + 마지막 슛을 득점자가 + 마지막 패스가 passer→scorer.
  const egg = moment.easterEgg
  const [eggClosed, setEggClosed] = useState(false)
  const eggMatched = useMemo(() => {
    if (!egg || result?.outcome !== 'GOAL') return false
    const shot = chain[chain.length - 1]
    if (shot?.type !== 'shot') return false
    if (egg.sequence) {
      // 공을 잡은 선수 순서 (같은 선수의 연속 드리블은 한 번으로)
      const touchers = []
      for (const leg of chain) if (touchers[touchers.length - 1] !== leg.actorId) touchers.push(leg.actorId)
      const seqOk =
        touchers.length === egg.sequence.length && touchers.every((id, i) => id === egg.sequence[i])
      if (!seqOk) return false
      if (egg.shot) {
        const tol = egg.shot.tol ?? 15
        if (Math.hypot(shot.from.x - egg.shot.x, shot.from.y - egg.shot.y) > tol) return false
      }
      return true
    }
    if (shot.actorId !== egg.scorerId) return false
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
    // 원샷의 마지막 액션이 드리블이면, 오프볼 런도 그 드리블과 동시에
    // 시작한다. 이전에는 드리블 뒤(afterIndex = chainActs.length)에 붙어
    // 가동 반경이 없어지고 재생 타이밍도 어긋났다.
    if (oneShotDribbleIndex != null && runWindowDur > 0) {
      const from = (snaps[oneShotDribbleIndex] ?? planPos)[id]
      const player = byId[id]
      if (from && player) to = clampToReach(from, to, reachRadius(player, runWindowDur))
      return setRuns((rs) => {
        const mine = rs.findLastIndex((r) => r.id === id && r.afterIndex === oneShotDribbleIndex)
        if (mine === -1) return [...rs, { id, to, ctrl: null, afterIndex: oneShotDribbleIndex }]
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
    // 상한을 넘겨 끌면 핸들이 허용 범위 경계에서 멈춘다 (state에도 잘린 값만 남긴다)
    const c = ctrlFromHandle(leg.from, leg.to, clampHandle(leg.from, leg.to, h, 'run'))
    setRuns((rs) => rs.map((r, i) => (i === key ? { ...r, ctrl: c } : r)))
  }

  // --- 체인 편집 ---
  // 공 가진 선수 드래그 = 드리블. 드래그 시작(isFirst)에 새 레그 추가, 이후엔 목표만 갱신.
  // 직전 레그가 이미 드리블이면 그 레그를 다시 조정하는 것으로 취급.
  const setDribble = (pt, isFirst) => {
    // 원샷에서 런을 먼저 그리고 나중에 드리블을 그린 경우도 예외 없이
    // 드리블 시간 안에서 갈 수 있는 거리로 다시 제한한다.
    const lastAct = chainActs[chainActs.length - 1]
    const dribbleIndex = lastAct?.type === 'dribble' ? chainActs.length - 1 : chainActs.length
    const existingDribble = lastAct?.type === 'dribble' ? chain[chain.length - 1] : null
    const dribbleFrom = existingDribble?.from ?? planPos[carrierId]
    // 오프볼 런을 먼저 찍고 드리블을 나중에 그린 경우도 포함한다.
    // 시트/원샷 어느 쪽이든 새 드리블 시간에 맞춰 목표를 즉시 반경 안으로 당긴다.
    if (dribbleFrom) {
      const dribble = { type: 'dribble', from: dribbleFrom, to: pt, ctrl: midpoint(dribbleFrom, pt) }
      const maxMove = actionDuration(dribble)
      setRuns((rs) =>
        rs.map((r) => {
          if (r.afterIndex !== dribbleIndex) return r
          const from = (snaps[dribbleIndex] ?? planPos)[r.id]
          const player = byId[r.id]
          if (!from || !player) return r
          return { ...r, to: clampToReach(from, r.to, reachRadius(player, maxMove)), ctrl: null }
        }),
      )
    }
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
  }
  const dropDribble = (pt) => {
    const leg = chain[chain.length - 1]
    if (leg?.type === 'dribble' && Math.hypot(pt.x - leg.from.x, pt.y - leg.from.y) < 3.5) {
      setChainActs((cs) => cs.slice(0, -1)) // 제자리로 되돌리면 드리블 취소
    }
  }
  // 시트 모드에서는 시트 1장에 공 액션 1개 — 이미 그렸으면 확정하고 넘어가야 한다
  const sheetFull = sheetMode && chain.length > sheetCount
  const addPass = (receiverId, to, passKind = 'ground') => {
    // 슛 재조준 — 이미 슛으로 끝나 있으면 새 액션을 붙이지 않고 목적지만 갈아끼운다.
    // 슛은 전개의 끝이라 항상 마지막 액션이므로 마지막 하나만 보면 된다.
    // (액션이 늘지 않으므로 sheetFull이어도 허용한다 — 시트가 넘치는 게 아니다)
    // ctrl은 비운다: 곡률 핸들은 옛 도착점 기준이라 목적지가 바뀌면 뜻이 달라진다.
    const last = chainActs[chainActs.length - 1]
    if (receiverId === 'GOAL' && last?.type === 'shot') {
      setChainActs((cs) => cs.map((c, i) => (i === cs.length - 1 ? { ...c, to, ctrl: null } : c)))
      return
    }
    if (sheetFull) return
    setChainActs((cs) => [
      ...cs,
      {
        type: receiverId === 'GOAL' ? 'shot' : 'pass',
        receiverId,
        to,
        ctrl: null,
        ...(receiverId === 'GOAL' ? {} : { passKind }),
      },
    ])
  }
  // 스루패스 = "리시버의 침투 런" + "그 도착점으로 가는 패스".
  // 새 액션 타입을 만들지 않는다 — 런이 패스보다 먼저 적용되므로(applyRunsAt(i)가
  // 체인 i번 액션 앞에서 돈다) 패스의 도착점이 자동으로 그 공간이 되고,
  // 판정·연출·오프사이드가 전부 기존 경로를 그대로 탄다.
  //   · playback: 런의 consumer가 이 패스라 "공 도착 시각에 맞춰 도착"하도록 역산된다 = 침투
  //   · offside : 판정 기준은 패스 출발 순간의 리시버 좌표(런 반영 전)라 온사이드가 된다
  // 찍은 지점 → 실제로 성립하는 도착점. 조준 중 미리보기와 확정이 같은 계산을 쓰도록
  // 한 곳에 모아둔다 (미리보기와 결과가 다르면 그게 제일 나쁜 UX다).
  const throughTargetOf = (receiverId, pt, passKind = 'through') => {
    // This applies in both one-shot and sheet mode.  Leaving one-shot targets
    // unrestricted made the ball arrive before its receiver could move there.
    // Solve the shared ball/runner arrival time before committing the action.
    const idx = chainActs.length
    const at = snaps[idx] ?? planPos
    const runnerFrom = at[receiverId]
    const ballFrom = at[carrierAt[idx] ?? carrierId] ?? ballPlanPos
    const player = byId[receiverId]
    if (!runnerFrom || !ballFrom || !player) return pt
    return throughTarget({ runnerFrom, ballFrom, want: pt, player, passKind })
  }

  const addThroughPass = (receiverId, pt, passKind = 'through') => {
    if (sheetFull) return
    const idx = chainActs.length // 이 패스가 놓일 체인 인덱스 = 런의 앵커
    const to = throughTargetOf(receiverId, pt, passKind)
    setRuns((rs) => [...rs, { id: receiverId, to, ctrl: null, afterIndex: idx }])
    setChainActs((cs) => [...cs, { type: 'pass', receiverId, to: null, ctrl: null, through: true, passKind }])
  }

  const setChainHandle = (i, h) => {
    const leg = chain[i]
    if (!leg) return
    const ctrl = ctrlFromHandle(leg.from, leg.to, clampHandle(leg.from, leg.to, h, leg.type))
    setChainActs((cs) => cs.map((c, idx) => (idx === i ? { ...c, ctrl } : c)))
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
  const shareUrlForSeed = (seedVal) =>
    shareUrl({
      seed: seedVal,
      chainActs,
      runs,
      playerIds: PLAYER_IDS,
      matchId,
      origin: window.location.origin,
      pathname: window.location.pathname,
    })
  // 버튼·주소창 표시용: 이미 실행한 결과가 있으면 그 결과의 시드를, 아직 안 돌렸으면
  // 다음에 쓸 시드를 담는다. 확정 때마다 시드를 새로 굴리므로 "다음 시드"와 "방금 결과의
  // 시드"가 다를 수 있어, 공유는 반드시 화면에 보인 결과(result.seed)를 따라가야 한다.
  const currentShareUrl = () => shareUrlForSeed(result?.seed ?? seed)
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
    const playSeed = seed // 이번 판에 쓸 시드 (공유 링크에 박히는 값)
    // 실행하는 순간의 전술을 주소창에 반영 — 새로고침·주소창 복사로도 같은 장면이 재현된다
    window.history.replaceState(null, '', shareUrlForSeed(playSeed))
    const actions = chain.map((leg) => ({ ...leg, actor: byId[leg.actorId] }))
    // players: 수비 재배치의 마킹 대상 (계획 시작 좌표 기준 — 런 반영은 액션 진행 중 근사)
    const res = resolveSequence(actions, { opponents, players: basePlayers, seed: playSeed })
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
      seed: playSeed,
      onFrame: setFrame,
      onDone: () => setPhase('done'),
    })
    // 다음 실행을 위해 새 시드를 굴려 둔다 — "다시 조정" 없이 확정을 또 눌러도 결과가 바뀐다.
    // 방금 판은 playSeed로 이미 돌았고, 공유는 result.seed(=playSeed)를 따라가므로 안전하다.
    setSeed(rollSeed())
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
    // 시드 재굴림은 handleConfirm이 실행 때마다 하므로 여기서는 따로 굴리지 않는다.
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
    setTutStep(null) // 튜토리얼 도중 뒤로 나가면 코치 창도 닫는다
    setScreen('select')
  }

  if (screen === 'intro') return <TitleScreen onStart={() => setScreen('select')} />
  // 경기 선택 → 보드. 다른 경기를 고르면 전술을 비운다 — 체인·런은 그 경기의 선수와
  // 좌표를 가리키고 있어서 그대로 두면 다른 명단 위에 얹힌 엉뚱한 전개가 된다.
  function pickMatch(id) {
    setTutStep(null) // 튜토리얼 코치가 떠 있었다면 경기 진입 시 닫는다
    if (id !== matchId) {
      clearAll()
      setSelectedId(null)
      setSheetMode(false)
      setMatchId(id)
      // 편집 중이던 좌표는 그 경기 것이다 — 경기가 바뀌면 같이 버린다
      setEditPos(null)
      setEditMode(false)
      setSaveMsg(null)
    }
    // 보드로 바로 가지 않고 킥오프 오프닝을 한 번 거친다.
    // 여기서 소리를 깨워 둔다 — 이 클릭이 사용자 제스처라 AudioContext를 만들 수 있는
    // 유일한 타이밍이고, 보드에 들어가서야 소리를 켜면 첫 실행 효과음이 묵음으로 샌다.
    resumeAudio()
    whistle({ duration: 0.42, freq: 2450 })
    startMurmur()
    setScreen('kickoff')
  }

  // ── 튜토리얼 ───────────────────────────────────────────────────────
  // 빈 보드에서 시작한다 — 앞서 그려둔 전개가 남아 있으면 미션 완료가 이미 충족돼 버린다.
  function startTutorial() {
    clearAll()
    setSelectedId(null)
    setSheetMode(false)
    setTutStep(0)
    setTutReading(true)
    setScreen('board')
  }
  const exitTutorial = () => setTutStep(null)
  function nextTutorial() {
    if (tutStep >= TUTORIAL_STEPS.length - 1) return exitTutorial()
    setTutStep((n) => n + 1)
    setTutReading(true)
  }

  // ── 좌표 편집 (개발 전용) ──────────────────────────────────────────
  // 0.5 단위로 맞춘다 — 중계 화면 보고 찍는 값에 소수점 두 자리는 의미가 없고,
  // positions.json이 지저분해진다.
  function moveForEdit(id, pt) {
    const snap = (v) => Math.round(v * 2) / 2
    setEditPos((prev) => ({ ...(prev ?? {}), [id]: { x: snap(pt.x), y: snap(pt.y) } }))
  }

  async function savePositions() {
    const positions = Object.fromEntries(
      [...basePlayers, ...opponents].map((p) => [p.id, { x: p.x, y: p.y }]),
    )
    try {
      const res = await fetch('/__positions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ matchId, positions }),
      })
      const out = await res.json()
      // 서버가 positions.json과 화면이 읽는 파일을 둘 다 고쳤다. editPos는 그대로 둔다 —
      // 지우면 HMR이 돌아오기 전 한 프레임 동안 옛 좌표가 보인다.
      setSaveMsg(out.ok ? `저장됨 (${out.count}명)` : `실패: ${out.error}`)
    } catch (e) {
      setSaveMsg(`실패: ${e.message} — dev 서버에서만 저장됩니다`)
    }
    setTimeout(() => setSaveMsg(null), 4000)
  }

  if (screen === 'select')
    return (
      <MatchSelect
        matchId={matchId}
        onPick={pickMatch}
        onBack={() => setScreen('intro')}
        onTutorial={startTutorial}
      />
    )

  // 킥오프 오프닝 — 경기 소개를 3초쯤 보여주고 보드로 넘긴다.
  // 튜토리얼(startTutorial)은 여기를 거치지 않는다: 배우러 온 사람에게 경기 소개는 군더더기고,
  // 튜토리얼 보드는 특정 경기의 그 장면이 아니라 조작을 익히는 자리다.
  if (screen === 'kickoff')
    return (
      <Kickoff
        matchId={matchId}
        scenario={scenario}
        moment={moment}
        carrier={byId[moment.ball]}
        onDone={() => setScreen('board')}
      />
    )

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
            <strong>{moment.minuteLabel ?? `${moment.minute}'`}</strong> · 스코어 {moment.score[0]} : {moment.score[1]} — {moment.situation}
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
                  ? `이 시트에는 공 행동을 하나만 설정할 수 있습니다. 오프볼 런을 더 넣거나, 시트를 확정해 다음 시트로 넘어가주세요.`
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
              flipX={scenario.viewFlipX ?? false}
              matchId={scenario.match_id}
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
              interactive={phase === 'plan' && !isViewingPast && !editMode}
              editMode={editMode}
              onEditMove={moveForEdit}
              defRadius={DEF_RADIUS}
              offsideIds={offsideIds}
              offsideFx={phase !== 'plan' ? frame?.fx : null}
              selectedId={selectedId}
              sheetLocked={sheetFull}
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

          {/* 좌표 편집 (개발 전용) — 배포 번들에는 들어가지 않는다 */}
          {EDITABLE && (
            <div className="edit-row">
              <button
                className={`ctrl${editMode ? ' on' : ''}`}
                onClick={() => {
                  // 편집으로 들어갈 땐 재생 중이던 걸 끊고 계획 화면으로 되돌린다
                  if (!editMode) backToPlan()
                  setEditMode((v) => !v)
                }}
              >
                {editMode ? '✓ 좌표 편집 중' : '✎ 좌표 편집'}
              </button>
              {editMode && (
                <>
                  <button className="ctrl" onClick={savePositions} disabled={!editPos}>
                    저장
                  </button>
                  <button className="ctrl" onClick={() => setEditPos(null)} disabled={!editPos}>
                    되돌리기
                  </button>
                  <span className="edit-hint">
                    {saveMsg ?? (
                      <>
                        양 팀 아무나 끌어서 옮기세요. 저장하면{' '}
                        <code>src/data/positions.json</code>에 기록됩니다.
                        {editPos && ` · ${Object.keys(editPos).length}명 수정됨`}
                      </>
                    )}
                  </span>
                </>
              )}
            </div>
          )}
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
                      {i + 1}. {leg.type === 'pass' ? (PASS_KIND_LABEL[chainActs[leg.index]?.passKind ?? (chainActs[leg.index]?.through ? 'through' : 'ground')] ?? '패스') : TYPE_LABEL[leg.type]} — {byId[leg.actorId].name}
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

      {/* 튜토리얼 코치 — 실제 보드 위에 얹혀 단계별로 기술을 안내한다.
          완료 판정은 이 화면이 이미 들고 있는 상태(체인·런·페이즈)만 본다. */}
      {tutStep != null && (
        <TutorialCoach
          step={tutStep}
          reading={tutReading}
          state={{ chainActs, runs, phase, sheetMode }}
          onPractice={() => setTutReading(false)}
          onNext={nextTutorial}
          onSkip={nextTutorial}
          onExit={exitTutorial}
        />
      )}
    </div>
  )
}

export default App
