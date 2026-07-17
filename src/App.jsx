import { useMemo, useRef, useState } from 'react'
import TacticsBoard from './components/TacticsBoard'
import { resolveSequence, DEF_RADIUS } from './engine/resolve'
import { playSequence } from './engine/playback'
import { midpoint, ctrlFromHandle } from './engine/geometry'
import playersData from './data/players.json'
import formations from './data/formations.json'
import scenario from './data/scenarios.json'
import './App.css'

const slots = formations['4-2-3-1']
const homeSquad = playersData.filter((p) => p.team === scenario.home)
const awaySquad = playersData.filter((p) => p.team === scenario.away)
const basePlayers = homeSquad.map((p, i) => ({ ...p, x: slots[i].x, y: slots[i].y }))
// 상대팀은 같은 포메이션을 좌우 반전해서 배치 (추후 scenarios.json이 위치를 직접 지정할 수 있음)
const opponents = awaySquad.map((p, i) => ({ ...p, x: 120 - slots[i].x, y: 80 - slots[i].y }))
const moment = scenario.moments[0]
const byId = Object.fromEntries([...basePlayers, ...opponents].map((p) => [p.id, p]))

// URL ?seed= 가 있으면 그 시드로 — 같은 링크 = 같은 결과 (재현 보장)
const SEED = (() => {
  const n = Number(new URLSearchParams(window.location.search).get('seed'))
  return Number.isFinite(n) && n > 0 ? n : Math.floor(Math.random() * 1e9)
})()

const TYPE_LABEL = { dribble: '드리블', pass: '패스', shot: '슛' }
const OUTCOME_LABEL = {
  GOAL: '⚽ GOAL!',
  ADVANCE: '✅ 전개 성공',
  INTERCEPTED: '🛡️ 차단당함',
  MISS: '❌ 무산...',
}

function App() {
  // 공 전개 체인 (순서 있는 액션 리스트) — 같은 선수가 여러 번 드리블/수신 가능
  // { type:'dribble', to, ctrl } | { type:'pass'|'shot', receiverId, to(슛만), ctrl }
  const [chainActs, setChainActs] = useState([])
  // 오프볼 런 리스트: [{ id, to, ctrl|null, afterIndex }] — 선수당 여러 개 가능.
  // afterIndex = "체인의 이 인덱스 액션이 시작되기 전에 출발" — 앵커.
  // 받고→넘기고→또 뛰는 것처럼 같은 선수가 시점이 다른 런을 여러 개 가질 수 있다.
  const [runs, setRuns] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [phase, setPhase] = useState('plan') // plan | playing | done
  const [result, setResult] = useState(null)
  const [frame, setFrame] = useState(null) // 재생 중 위치: { home, opp, ball, caption }
  const playbackRef = useRef(null) // playSequence가 돌려주는 { cancel }

  const basePos = (id) => ({ x: byId[id].x, y: byId[id].y })

  // 체인 + 런을 시간 순서대로 걸어가며 좌표를 유도.
  // 선수 위치가 체인을 따라 갱신되므로 "드리블→패스→되받아→다시 드리블",
  // "드리블→패스→오프볼 런→다시 받기"가 모두 이어진다.
  const { chain, runLegs, planPos, carrierId } = useMemo(() => {
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
    let carrier = moment.ball
    const chain = chainActs.map((act, index) => {
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
    applyRunsAt(len)
    const planPos = {}
    for (const p of basePlayers) planPos[p.id] = posOf(p.id)
    return { chain, runLegs: Object.values(runLegMap), planPos, carrierId: carrier }
  }, [chainActs, runs])

  const shotTaken = chainActs.some((a) => a.type === 'shot')
  const ballPlanPos = chain.length ? chain[chain.length - 1].to : basePos(moment.ball)

  // --- 오프볼 런 지시 ---
  // 드래그 시작(isFirst) 때 한 번만 판단: 이 선수의 마지막 런이 아직 체인에 "소비"되지
  // 않았으면(그 뒤로 받거나 준 적 없음) 그 런을 조정, 소비됐으면 새 런을 추가.
  // 소비된 런을 건드리면 그 위치로 유도된 패스 선들이 전부 따라 움직이기 때문.
  const setRunTarget = (id, to, isFirst) =>
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
      if (isFirst && last?.type !== 'dribble') return [...cs, { type: 'dribble', to: pt, ctrl: null }]
      return cs.map((c, i) => (i === cs.length - 1 ? { ...c, to: pt, ctrl: isFirst ? null : c.ctrl } : c))
    })
  const dropDribble = (pt) => {
    const leg = chain[chain.length - 1]
    if (leg?.type === 'dribble' && Math.hypot(pt.x - leg.from.x, pt.y - leg.from.y) < 3.5) {
      setChainActs((cs) => cs.slice(0, -1)) // 제자리로 되돌리면 드리블 취소
    }
  }
  const addPass = (receiverId, to) =>
    setChainActs((cs) => [...cs, { type: receiverId === 'GOAL' ? 'shot' : 'pass', receiverId, to, ctrl: null }])
  const setChainHandle = (i, h) => {
    const leg = chain[i]
    if (!leg) return
    setChainActs((cs) => cs.map((c, idx) => (idx === i ? { ...c, ctrl: ctrlFromHandle(leg.from, leg.to, h) } : c)))
  }
  const removeChainFrom = (i) => setChainActs((cs) => cs.slice(0, i)) // 체인이므로 그 뒤도 함께 삭제

  // --- 확정 → 판정 → 재생 ---
  // 판정은 resolveSequence(스냅샷 1회), 연출은 playSequence(engine/playback.js)가 전담
  function handleConfirm() {
    if (!chain.length || phase === 'playing') return
    const actions = chain.map((leg) => ({ ...leg, actor: byId[leg.actorId] }))
    const res = resolveSequence(actions, { opponents, seed: SEED })
    setResult(res)
    setPhase('playing')
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

  function backToPlan() {
    playbackRef.current?.cancel()
    setPhase('plan')
    setFrame(null)
    setResult(null)
  }
  function clearAll() {
    backToPlan()
    setChainActs([])
    setRuns([])
  }

  const selected = selectedId ? byId[selectedId] : null

  return (
    <div className="app">
      <header>
        <h1>⚽ 터치라인 <span className="sub">전술보드 프로토타입</span></h1>
        <div className="mission-card">
          <div className="mission-title">{scenario.title}</div>
          <div className="mission-body">
            <strong>{moment.minute}'</strong> · 스코어 {moment.score[0]} : {moment.score[1]} — {moment.situation}
          </div>
        </div>
      </header>

      <main>
        <div className="board-col">
          <TacticsBoard
            players={basePlayers}
            opponents={opponents}
            runLegs={runLegs}
            chain={chain}
            planPos={planPos}
            carrierId={carrierId}
            shotTaken={shotTaken}
            ballPos={phase === 'plan' ? ballPlanPos : frame?.ball}
            displayHome={phase === 'plan' ? null : frame?.home}
            displayOpp={phase === 'plan' ? null : frame?.opp}
            interactive={phase === 'plan'}
            defRadius={DEF_RADIUS}
            selectedId={selectedId}
            onPlayerClick={(id) => setSelectedId((prev) => (prev === id ? null : id))}
            onRunSet={setRunTarget}
            onRunRemove={removeRun}
            onRunHandle={setRunHandle}
            onDribbleSet={setDribble}
            onDribbleDrop={dropDribble}
            onChainHandle={setChainHandle}
            onPassCommit={addPass}
          />
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
              <div className={`result ${result.outcome === 'GOAL' || result.outcome === 'ADVANCE' ? 'goal' : 'miss'}`}>
                <div className="outcome">{OUTCOME_LABEL[result.outcome]}</div>
                <div className="rate">시퀀스 전체 성공 확률 {(result.pTotal * 100).toFixed(0)}%</div>
                <ul className="steps">
                  {result.steps.map((s, i) => (
                    <li key={i} className={s.success === null ? 'step-skip' : s.success ? 'step-ok' : 'step-fail'}>
                      <span>{i + 1}. {TYPE_LABEL[s.type]}</span>
                      <span>{(s.p * 100).toFixed(0)}% {s.success === null ? '―' : s.success ? '✓' : '✗'}</span>
                    </li>
                  ))}
                </ul>
                <div className="reason">{result.reason}</div>
                <div className="seed">seed {result.seed} — 같은 시드·같은 전술이면 결과도 같습니다</div>
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
                      {i + 1}. {TYPE_LABEL[leg.type]} — {byId[leg.actorId].name}
                      {leg.type === 'pass' ? ` → ${byId[leg.receiverId].name}` : leg.type === 'shot' ? ' → 골문' : ''}
                    </span>
                    {phase === 'plan' && (
                      <button onClick={() => removeChainFrom(leg.index)} title="이 액션부터 뒤로 전부 삭제">✕</button>
                    )}
                  </li>
                ))}
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
                  #{selected.number} {selected.name} <span className="pos">{selected.position} · {selected.roles.join('/')}</span>
                </div>
                <dl className="stats">
                  <div><dt>슈팅</dt><dd>{selected.attributes.technical.shooting}</dd></div>
                  <div><dt>패스</dt><dd>{selected.attributes.technical.passing}</dd></div>
                  <div><dt>판단</dt><dd>{selected.attributes.mental.decisions}</dd></div>
                  <div><dt>침착</dt><dd>{selected.attributes.mental.composure}</dd></div>
                  <div><dt>스피드</dt><dd>{selected.attributes.physical.pace}</dd></div>
                  <div><dt>체력</dt><dd>{selected.attributes.physical.stamina}</dd></div>
                </dl>
              </div>
            ) : (
              <p className="muted">선수를 클릭하면 능력치가 표시됩니다.</p>
            )}
          </section>

          <section className="panel">
            <h2>조작법</h2>
            <ul className="help">
              <li><b>공 가진 선수 드래그</b> — 드리블 (되받은 뒤 또 가능)</li>
              <li><b>다른 아군 드래그</b> — 오프볼 런 (공 넘긴 뒤에도 가능)</li>
              <li><b>공(⚪) 드래그</b> — 동료에게 놓으면 패스, 골문 쪽은 슛</li>
              <li><b>선 가운데 점 드래그</b> — 궤적 휘기 · <b>클릭</b> — 능력치</li>
            </ul>
          </section>
        </div>
      </main>
    </div>
  )
}

export default App
