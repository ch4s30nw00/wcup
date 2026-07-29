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
import { isReplayMatch, eggRadii } from './engine/replay'
import { buildMatch, findMatch, DEFAULT_MATCH_ID } from './data/matches'
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

const TYPE_LABEL = { dribble: '드리블', pass: '패스', shot: '슛' }
const PASS_KIND_LABEL = {
  ground: '패스',
  pass: '패스',
  lob: '로빙패스',
  through: '스루패스',
  lobThrough: '로빙스루',
}
// 보드 좌표를 축구 용어로 옮긴다 — 경기 영상과 대조할 때 (105, 45)보다
// "페널티박스 안"이 훨씬 빠르게 읽힌다. 보드에 그려진 라인과 같은 수치를 쓴다.
function pitchZoneOf({ x, y }) {
  if (x >= 113.5 && y >= 30 && y <= 50) return '골에어리어 안'
  if (x >= 102 && y >= 18 && y <= 62) return '페널티박스 안'
  if (x >= 102) return '박스 옆 (골라인 근처)'
  return `박스 밖 ${(102 - x).toFixed(1)}m`
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
  // 재현 구역 검증 표시 (개발 전용) — 경기 영상과 좌표를 대조하는 용도
  const [showEggZone, setShowEggZone] = useState(false)
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
  // 열람 중인 시점 = 그 인덱스 액션까지만 반영한 보드를 본다 (null이면 최신).
  // 액션 시퀀스 패널에서 행을 클릭해 오간다 — 액션 하나가 곧 한 시점이다.
  const [viewAt, setViewAt] = useState(null)
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
  // 지금 편집하는 시점 = 마지막 액션. 과거 시점은 열람만 된다.
  const lastIndex = chainActs.length - 1
  const shownAt = viewAt ?? lastIndex
  const isViewingPast = viewAt != null && viewAt < lastIndex

  // 튜토리얼이 지목하는 대상을 지금 화면의 실제 값으로 푼다.
  // 'carrier'는 매번 다시 푼다 — 체인이 자라면 공 주인이 바뀌므로 점멸도 따라가야 한다.
  // 확정 버튼은 누를 수 있을 때만 깜빡인다: 비활성 버튼이 깜빡이면 누르라는 건지
  // 못 누른다는 건지 알 수 없다.
  const tutFocus = useMemo(() => {
    const f = tutStep != null ? TUTORIAL_STEPS[tutStep]?.focus : null
    if (!f) return null
    const target = f.board === 'carrier' ? carrierId : typeof f.board === 'object' ? f.board.id : null
    return {
      ball: f.board === 'ball',
      playerId: target && byId[target] ? target : null,
      action: f.action ?? null,
      confirm: f.ui === 'confirm' && phase === 'plan' && chain.length > 0,
    }
  }, [tutStep, carrierId, byId, phase, chain.length])

  // 가동범위 동심원 — 마지막 액션의 출발 좌표를 중심으로, 그 액션이 걸리는 시간 동안
  // 각 선수가 갈 수 있는 거리. 액션 종류를 가리지 않는다 — 드리블이든 패스든 슛이든
  // 그동안 다른 선수들은 움직인다. (예전에는 드리블일 때만 띄웠는데, 그러면 패스에 붙인
  // 런이 보이지 않는 벽에 걸렸다 — 원은 안 보이면서 목표는 그 패스 시간으로 잘렸다)
  const runWindowIndex = lastIndex >= 0 ? lastIndex : null
  const runWindowLeg = runWindowIndex != null ? chain[runWindowIndex] : null
  const runWindowDur = runWindowLeg ? actionDuration(runWindowLeg) : 0
  const reachCircles = useMemo(() => {
    if (runWindowIndex == null || isViewingPast || phase !== 'plan' || !(runWindowDur > 0)) return null
    const at = snaps[runWindowIndex] ?? planPos
    return basePlayers
      .filter((p) => p.id !== carrierAt[runWindowIndex]) // 공 소유자는 액션 본인이라 제외
      .map((p) => ({ id: p.id, ...at[p.id], r: reachRadius(p, runWindowDur) }))
  }, [runWindowIndex, isViewingPast, phase, runWindowDur, snaps, planPos, carrierAt, basePlayers])

  // 이스터에그 — 실제 경기 재현 감지.
  // 새 방식(egg.sequence 있으면): 골로 끝났고, "공을 주고받은 선수 순서"가 시나리오와
  //   똑같고, 마지막 슛을 친 위치가 실제 슛 지점(egg.shot)의 타원 구역 안이면 성공.
  //   드리블·패스를 정확히 어디서 했는지는 보지 않는다 — 순서와 마무리 지점만.
  // 구 방식(폴백): 골 + 마지막 슛을 득점자가 + 마지막 패스가 passer→scorer.
  const egg = moment.easterEgg
  const [eggClosed, setEggClosed] = useState(false)
  // 개발 모드에서 마커를 끌어 옮기는 중인 좌표 (id → {x,y,rx,ry}). null이면 데이터 원본 그대로.
  const [eggShotEdit, setEggShotEdit] = useState(null)
  // 판정과 화면이 같은 값을 봐야 한다 — 끌어 옮기는 즉시 판정 구역도 따라 움직인다.
  // 메모하지 않으면 매 렌더 새 객체가 되어 아래 eggMatched가 계속 다시 계산된다.
  const shot0 = useMemo(
    () => (egg?.shot ? { ...egg.shot, ...(eggShotEdit ?? {}) } : null),
    [egg, eggShotEdit],
  )
  const eggMatched = useMemo(
    () => isReplayMatch({ egg, chain, outcome: result?.outcome, shot: shot0 }),
    [egg, result, chain, shot0],
  )

  // --- 오프볼 런 지시 ---
  //
  // 오프볼 런은 **공 액션이 있는 슬롯에서만** 그릴 수 있다 (사용자 확정 2026-07-28).
  // 런은 "그 액션이 진행되는 동안 뛰는 것"이라, 액션이 없으면 뛸 시간 자체가 없다.
  // 액션 없는 빈 슬롯에 런이 붙던 예전 방식에는 두 가지 문제가 있었다:
  //   · 시간 예산이 없어 가동범위 동심원이 정의되지 않았다
  //   · 스루패스가 같은 인덱스에 자기 런을 만들면서 사용자가 그린 런과 자리를 다퉜고,
  //     그때 도착점을 "런 이전 좌표" 기준으로 잡아 선수가 안 움직인 것처럼 계산됐다
  //
  // runSlot = 지금 런이 붙을 액션의 인덱스. 없으면(-1) 런 자체가 불가능하다.
  const runSlot = lastIndex
  const runsAllowed = runSlot >= 0 && !!chainActs[runSlot]
  // 그 슬롯의 액션이 걸리는 시간 = 런이 쓸 수 있는 시간 예산.
  // 동심원(runWindowDur)과 **같은 값**이어야 한다 — 갈라 두면 원은 안 보이는데
  // 목표만 잘리는 "보이지 않는 벽"이 생긴다.
  const runSlotDur = runWindowDur

  const setRunTarget = (id, to) => {
    if (!runsAllowed) return // 공 액션 없는 슬롯에는 뛸 시간이 없다
    const from = (snaps[runSlot] ?? planPos)[id]
    const player = byId[id]
    if (from && player && runSlotDur > 0) to = clampToReach(from, to, reachRadius(player, runSlotDur))
    setRuns((rs) => {
      // 한 선수는 한 슬롯에 런 하나 — 다시 끌면 그 런의 도착점을 고친다
      const mine = rs.findLastIndex((r) => r.id === id && r.afterIndex === runSlot)
      if (mine === -1) return [...rs, { id, to, ctrl: null, afterIndex: runSlot }]
      return rs.map((r, i) => (i === mine ? { ...r, to, ctrl: null } : r))
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
    // 이번 호출이 새 레그를 붙이는가, 이미 그린 드리블을 조정하는가.
    //
    // isFirst는 "새 제스처의 첫 프레임"이다(드래그 시작 또는 메뉴에서 도착점 탭).
    // 새 제스처면 언제나 레그를 하나 더 붙인다 — 선수는 직전 드리블의 끝점에 서 있으므로
    // 거기서 다시 끄는 건 "여기서 더 몰고 간다"는 뜻이다. 예전에는 직전이 드리블이면
    // 무조건 그 레그를 조정해서, 몰고 가다 방향을 꺾는 **드리블 두 번을 아예 못 그렸다**.
    // (실수로 살짝 끈 경우는 dropDribble이 출발점 3.5m 안에서 취소한다)
    //
    const lastAct = chainActs[chainActs.length - 1]
    const adjusting = !isFirst && lastAct?.type === 'dribble'
    // 원샷에서 런을 먼저 그리고 나중에 드리블을 그린 경우도 예외 없이
    // 드리블 시간 안에서 갈 수 있는 거리로 다시 제한한다.
    const dribbleIndex = adjusting ? chainActs.length - 1 : chainActs.length
    const dribbleFrom = adjusting ? chain[chain.length - 1].from : planPos[carrierId]
    // 오프볼 런을 먼저 찍고 드리블을 나중에 그린 경우도 포함한다 —
    // 새 드리블 시간에 맞춰 목표를 즉시 반경 안으로 당긴다.
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
      // 새 제스처 = 새 레그. 드리블 뒤에 또 드리블을 이어 붙일 수 있다.
      if (isFirst) return [...cs, { type: 'dribble', to: pt, ctrl: null }]
      // 같은 제스처가 이어지는 중 — 방금 붙인 레그의 도착점만 따라간다
      return cs.map((c, i) => (i === cs.length - 1 ? { ...c, to: pt } : c))
    })
  }
  const dropDribble = (pt) => {
    const leg = chain[chain.length - 1]
    if (leg?.type === 'dribble' && Math.hypot(pt.x - leg.from.x, pt.y - leg.from.y) < 3.5) {
      setChainActs((cs) => cs.slice(0, -1)) // 제자리로 되돌리면 드리블 취소
    }
  }
  const addPass = (receiverId, to, passKind = 'ground') => {
    // 슛 재조준 — 이미 슛으로 끝나 있으면 새 액션을 붙이지 않고 목적지만 갈아끼운다.
    // 슛은 전개의 끝이라 항상 마지막 액션이므로 마지막 하나만 보면 된다.
    // ctrl은 비운다: 곡률 핸들은 옛 도착점 기준이라 목적지가 바뀌면 뜻이 달라진다.
    const last = chainActs[chainActs.length - 1]
    if (receiverId === 'GOAL' && last?.type === 'shot') {
      setChainActs((cs) => cs.map((c, i) => (i === cs.length - 1 ? { ...c, to, ctrl: null } : c)))
      return
    }
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
  // 체인이므로 그 뒤도 함께 삭제. 그 액션에 딸린 오프볼 런도 같이 지운다 —
  // 남겨두면 applyRunsAt의 Math.min(afterIndex, len)에 걸려 체인 맨 끝으로
  // 재앵커되고, 지운 액션의 침투가 엉뚱한 시점에 되살아난다.
  const removeChainFrom = (i) => {
    setChainActs((cs) => cs.slice(0, i))
    setRuns((rs) => rs.filter((r) => r.afterIndex < i))
    setViewAt(null)
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
    setViewAt(null)
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
  //
  // 경기도 기본 경기로 되돌린다. 단계 문구가 손흥민·황희찬을 이름으로 지목하고
  // 킷 색까지 확정해 말하기 때문에, 다른 경기를 골라둔 채 튜토리얼을 켜면
  // 화면과 설명이 통째로 어긋난다.
  function startTutorial() {
    clearAll()
    setSelectedId(null)
    if (matchId !== DEFAULT_MATCH_ID) {
      setMatchId(DEFAULT_MATCH_ID)
      // 편집 중이던 좌표는 그 경기 것이다 — 경기가 바뀌면 같이 버린다 (pickMatch와 같은 이유)
      setEditPos(null)
      setEditMode(false)
      setSaveMsg(null)
    }
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

  // ── 재현 구역 조정 (개발 전용) ─────────────────────────────────────
  // 경기 영상을 보며 마커를 끌어 슛 지점을 맞춘다. 0.5m 단위로 맞추는 건 선수 좌표와
  // 같은 이유 — 중계 화면 보고 찍는 값에 소수점 두 자리는 의미가 없다.
  function moveEggShot(pt) {
    const snap = (v) => Math.round(v * 2) / 2
    setEggShotEdit((prev) => ({ ...(prev ?? {}), x: snap(pt.x), y: snap(pt.y) }))
  }
  const setEggRadius = (axis, v) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return
    setEggShotEdit((prev) => ({ ...(prev ?? {}), [axis]: Math.min(40, Math.max(2, n)) }))
  }

  async function saveEggShot() {
    try {
      const res = await fetch('/__eggshot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ matchId, shot: { x: shot0.x, y: shot0.y, ...eggRadii(shot0) } }),
      })
      const out = await res.json()
      // editPos와 같은 이유로 eggShotEdit은 지우지 않는다 — 지우면 HMR이 돌아오기 전
      // 한 프레임 동안 옛 좌표가 보인다.
      setSaveMsg(out.ok ? `재현 구역 저장됨 (${out.matchId})` : `실패: ${out.error}`)
    } catch (e) {
      setSaveMsg(`실패: ${e.message} — dev 서버에서만 저장됩니다`)
    }
    setTimeout(() => setSaveMsg(null), 4000)
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
          {/* 과거 시점을 열람 중이면 그 사실과 빠져나갈 길을 알린다 —
              보드가 조작되지 않는 이유가 화면에 있어야 고장으로 안 읽힌다. */}
          {isViewingPast && phase === 'plan' && (
            <p className="sheet-hint">
              {shownAt + 1}번 액션 시점을 보는 중입니다 — 과거 시점에서는 전술을 고칠 수 없습니다.
              오른쪽 액션 시퀀스에서 <b>최신으로 ↩</b>를 누르세요.
            </p>
          )}
          {shotTaken && phase === 'plan' && !isViewingPast && (
            <p className="sheet-hint">슛으로 전개가 끝났습니다. 아래 [전술 확정 — 실행]을 누르세요.</p>
          )}
          {/* 오프볼 런을 못 그리는 이유를 미리 알려준다 — 드래그해도 아무 일이 없으면
              고장으로 읽힌다. 런은 "그 액션이 진행되는 동안" 뛰는 것이라 액션이 먼저다. */}
          {!runsAllowed && phase === 'plan' && !isViewingPast && (
            <p className="sheet-hint">
              공 액션(드리블·패스·슛)을 하나 지시하면, 그 사이에 뛸 선수를 드래그해 지정할 수 있습니다.
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
              // 과거 시점을 열람 중이면 그 시점까지의 체인·좌표만 보여준다
              runLegs={isViewingPast ? runLegs.filter((r) => r.afterIndex <= shownAt) : runLegs}
              chain={isViewingPast ? chain.slice(0, shownAt + 1) : chain}
              planPos={isViewingPast ? (snaps[shownAt + 1] ?? planPos) : planPos}
              carrierId={isViewingPast ? (carrierAt[shownAt + 1] ?? carrierId) : carrierId}
              shotTaken={shotTaken}
              reachCircles={reachCircles}
              tutFocus={tutFocus}
              shotZone={
                EDITABLE && showEggZone && shot0
                  ? {
                      x: shot0.x,
                      y: shot0.y,
                      ...eggRadii(shot0),
                      label: `${eggRadii(shot0).rx}×${eggRadii(shot0).ry}m`,
                    }
                  : null
              }
              onEggShotMove={EDITABLE && showEggZone && shot0 ? moveEggShot : null}
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
              onPlayerClick={(id) => setSelectedId((prev) => (prev === id ? null : id))}
              runsAllowed={runsAllowed}
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
            {/* 시트 확정과 실행은 같은 버튼이다. 조작 지점이 두 모드에서 같아야
                원샷을 쓰던 사람이 시트 모드로 와도 하던 대로 하면 된다.
                그리고 슛을 그리는 순간 이 버튼이 실행으로 바뀌므로 **확정할 방법 자체가
                사라진다** — 예전에는 슛 뒤에도 확정이 눌려 아무것도 못 하는 빈 시트가 열렸다. */}
            <button
              className={`kickoff${tutFocus?.confirm ? ' tut-pulse' : ''}`}
              onClick={handleConfirm}
              disabled={!chain.length || phase === 'playing'}
            >
              {phase === 'playing' ? '재생 중…' : '전술 확정 — 실행 ▶'}
            </button>
            {phase === 'plan' && chainActs.length > 0 && (
              <button
                className="ctrl"
                onClick={() => removeChainFrom(chainActs.length - 1)}
                title="마지막 공 액션과 거기 딸린 오프볼 런을 지웁니다"
              >
                ↩ 되돌리기
              </button>
            )}
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
              {/* 재현 구역 검증 — 그날의 슛 지점과 판정 반경을 보드에 띄운다.
                  경기 영상과 대조해 좌표·반경을 맞추는 용도라 개발 모드에서만 나온다
                  (본편에서 늘 보이면 정답을 알려주는 셈이라 이스터에그가 죽는다). */}
              <button
                className={`ctrl${showEggZone ? ' on' : ''}`}
                onClick={() => setShowEggZone((v) => !v)}
                disabled={!egg?.shot}
              >
                {showEggZone ? '✓ 재현 구역 표시 중' : '🎯 재현 구역'}
              </button>
            </div>
          )}
          {EDITABLE && showEggZone && shot0 && (
            <div className="egg-probe">
              <b>그날의 슛 지점 — 보드의 금색 십자를 끌어 옮기세요</b>
              <span>
                보드 좌표 <code>({shot0.x}, {shot0.y})</code> · 골라인에서{' '}
                <b>{(120 - shot0.x).toFixed(1)}m</b> 앞 · 골문 중앙까지{' '}
                <b>{Math.hypot(120 - shot0.x, 40 - shot0.y).toFixed(1)}m</b> · 중앙선에서{' '}
                <b>
                  {Math.abs(shot0.y - 40).toFixed(1)}m{' '}
                  {shot0.y > 40 ? '아래' : shot0.y < 40 ? '위' : ''}
                </b>
              </span>
              <span>
                구역: <b>{pitchZoneOf(shot0)}</b> · 통과 범위는 골라인{' '}
                {(120 - shot0.x - eggRadii(shot0).rx).toFixed(1)}~
                {(120 - shot0.x + eggRadii(shot0).rx).toFixed(1)}m 앞, 좌우 ±
                {eggRadii(shot0).ry}m
              </span>
              <span className="egg-radii">
                반경
                <label>
                  거리축 rx
                  <input
                    type="number"
                    min="2"
                    max="40"
                    step="0.5"
                    value={eggRadii(shot0).rx}
                    onChange={(e) => setEggRadius('rx', e.target.value)}
                  />
                </label>
                <label>
                  좌우축 ry
                  <input
                    type="number"
                    min="2"
                    max="40"
                    step="0.5"
                    value={eggRadii(shot0).ry}
                    onChange={(e) => setEggRadius('ry', e.target.value)}
                  />
                </label>
                <button className="ctrl" onClick={saveEggShot} disabled={!eggShotEdit}>
                  저장
                </button>
                <button className="ctrl" onClick={() => setEggShotEdit(null)} disabled={!eggShotEdit}>
                  되돌리기
                </button>
              </span>
              <span>
                재현 순서: <b>{egg.sequence?.map((id) => byId[id]?.name ?? id).join(' → ')}</b>
              </span>
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
            <h2>
              액션 시퀀스
              {/* 과거 시점 열람 중일 때만 빠져나갈 길을 띄운다 */}
              {isViewingPast && phase === 'plan' && (
                <button className="ctrl seq-back" onClick={() => setViewAt(null)}>최신으로 ↩</button>
              )}
            </h2>
            {chain.length === 0 && runLegs.length === 0 ? (
              <p className="muted">공이나 선수를 드래그해 전개를 설계하세요. 공은 지금 {byId[moment.ball].name}에게 있습니다.</p>
            ) : (
              <ul className="actions-list">
                {/* 행을 누르면 그 액션까지만 반영한 보드를 본다 — 액션 하나가 곧 한 시점이다.
                    (예전 시트 탭이 하던 일. 액션과 시점이 1:1이라 별도 개념이 필요 없다) */}
                {chain.map((leg, i) => (
                  <li
                    key={`c${i}`}
                    className={`action-row seq-row${shownAt === i && isViewingPast ? ' viewing' : ''}`}
                    onClick={() => phase === 'plan' && setViewAt(i === lastIndex ? null : i)}
                    title="이 시점의 보드 보기"
                  >
                    <span>
                      {i + 1}. {leg.type === 'pass' ? (PASS_KIND_LABEL[chainActs[leg.index]?.passKind ?? (chainActs[leg.index]?.through ? 'through' : 'ground')] ?? '패스') : TYPE_LABEL[leg.type]} — {byId[leg.actorId].name}
                      {leg.type === 'pass' ? ` → ${byId[leg.receiverId].name}` : leg.type === 'shot' ? ' → 골문' : ''}
                    </span>
                    {phase === 'plan' && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation() // 행 클릭(시점 열람)과 구분
                          removeChainFrom(leg.index)
                        }}
                        title="이 액션부터 뒤로 전부 삭제"
                      >
                        ✕
                      </button>
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
          state={{ chainActs, runs, phase }}
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
