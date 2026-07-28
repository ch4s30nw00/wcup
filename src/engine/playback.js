// engine/playback.js — 판정 결과(resolveSequence 반환값)를 받아 재연 애니메이션을 만든다.
// 순수 연출 전용: 여기 코드는 판정(확률·성공/실패)에 전혀 영향을 주지 않는다.
// 판정 수식을 만지는 사람은 resolve.js만, 데이터를 만지는 사람은 data/*.json만 보면 된다.
//
//   playSequence({ actions, result, runLegs, players, opponents, byId,
//                  ballOwnerId, seed, onFrame, onDone }) → { cancel }
//
//   매 프레임 onFrame({ home, opp, ball, caption })을 호출하고
//   재생이 끝나면 onDone()을 부른다. cancel()로 중단.

import { mulberry32 } from './resolve.js'
import { commentaryFor } from './commentary.js'
import { midpoint, samplePath, pathLength, pointAtLength } from './geometry.js'
import { K, actionSpeed, isLobPass } from './constants.js'
import { movementDuration, runSpeedOf } from './sheets.js'

const clamp = (v, min, max) => Math.min(max, Math.max(min, v))
// 이동/공 속도 (피치 단위 ≈ m/s) — 판정의 수비 이동 예산(resolve.js)과 공유
// Long dribbles use their real movement time rather than a fixed duration cap.
const durFor = (len, v) => movementDuration(len, v) * 1000
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

const ROW_K_HOME = { GK: 0.08, DF: 0.42, MF: 0.65, FW: 0.85 } // 공 전진량을 얼마나 따라 올라가나
const ROW_K_OPP = { GK: 0.05, DF: 0.3, MF: 0.48, FW: 0.58 } // 공 전진 시 얼마나 내려앉나

export function playSequence({ actions, result, runLegs, players, opponents, byId, ballOwnerId, seed, onFrame, onDone }) {
  const basePos = (id) => ({ x: byId[id].x, y: byId[id].y })
  const failIndex = result.steps.findIndex((s) => s.success === false)
  const failStep = failIndex === -1 ? null : result.steps[failIndex]

  // 통합 타임라인 — 공 체인은 순차 배치, 런은 "공 도착에 맞춰 도착"하도록 역산 배치.
  // 패스가 날아가는 동안 침투 런이 동시에 진행되는 겹침이 기본이 되고,
  // 런이 가장 일찍 출발해도 마감을 못 맞출 때만 그 레그(와 이후 전개)를 늦춘다.
  const legs = []
  actions.forEach((a, i) => {
    if (failIndex !== -1 && i > failIndex) return // 실패 이후 액션은 재생 안 함
    const step = result.steps[i]
    let to = a.to
    let ctrl = a.ctrl
    if (a.type === 'shot' && !step.success && !step.interceptorId) {
      // 블로커 없는 슛 실패 = 골대 밖으로 빗나가는 연출
      to = { x: 121.5, y: a.to.y + (a.to.y < 40 ? -4.5 : 4.5) }
      ctrl = midpoint(a.from, to)
    }
    let pts = samplePath(a.from, ctrl, to)
    // 아무도 안 건드린 패스 실패 = "빠진 패스". 목표 지점에서 멈추지 않고 그대로 흘러간다.
    // 원래 곡선을 그대로 두고 끝점 접선 방향으로 직선 구간을 이어 붙인다 —
    // ctrl을 다시 잡으면 유저가 그린 궤적의 휨이 사라지기 때문.
    let missFrac = null
    // 오프사이드는 제외 — 공은 리시버에게 제대로 도착하고 휘슬로 멈추는 것이지 빠진 게 아니다
    if ((a.type === 'pass' || a.type === 'cross') && !step.success && !step.interceptorId && !step.offside) {
      const tail = pts[pts.length - 1]
      const prevPt = pts[pts.length - 2] ?? a.from
      const dx = tail.x - prevPt.x
      const dy = tail.y - prevPt.y
      const dl = Math.hypot(dx, dy) || 1
      const origLen = pathLength(pts)
      const over = K.PLAY.PASS_OVERRUN
      const run = []
      for (let s = 1; s <= 8; s++) {
        const t = (over * s) / 8
        run.push({ x: clamp(tail.x + (dx / dl) * t, -1.5, 121.5), y: clamp(tail.y + (dy / dl) * t, -1.5, 81.5) })
      }
      pts = [...pts, ...run]
      // 자막("패스가 흐릅니다")은 공이 원래 목표를 지나치는 순간에 뜨도록
      missFrac = origLen / (pathLength(pts) || 1)
    }
    const len = pathLength(pts)
    const dur = durFor(len, actionSpeed(a))
    const prev = legs[legs.length - 1]
    // 연속 행동은 앞 행동이 끝나는 프레임에서 바로 이어 재생한다.
    legs.push({ ...a, step, pts, len, missFrac, aerial: isLobPass(a), start: prev ? prev.start + prev.dur + K.PLAY.ACTION_LINK_MS : 300, dur })
  })

  const segs = [] // 선수 이동 세그먼트 (런 + 드리블)
  // 이 선수가 체인 관여에서 풀려나 뛰기 시작할 수 있는 시각 —
  // 수신·드리블은 끝나야 자유, 패스는 공을 놓는 순간(출발 시각)부터 자유
  const freeAfter = (id, beforeIndex) => {
    let tm = 200
    for (const leg of legs) {
      if (leg.index >= beforeIndex) break
      if (leg.receiverId === id) tm = leg.start + leg.dur
      else if (leg.actorId === id) tm = leg.type === 'dribble' ? leg.start + leg.dur : leg.start
    }
    return tm
  }
  // Explicit off-ball instructions stay authoritative through the current
  // action chain.  Auto tactical steering must never pull them away from a
  // user-selected destination before the next action can use that position.
  const actionEnd = legs.length ? legs[legs.length - 1].start + legs[legs.length - 1].dur : 300
  const runPlan = runLegs
    .filter((rl) => !(failIndex !== -1 && rl.afterIndex > failIndex))
    .map((rl) => {
      // 오프볼 런도 선수별 가속도·주력을 반영한다. 고정 9m/s 대신
      // 시트의 가동 반경 계산과 동일한 속도 함수를 사용한다.
      const player = byId[rl.id]
      const runSpeed = runSpeedOf(player)
      const anchorLeg = legs.find((leg) => leg.index === rl.afterIndex)
      // UI에서 이미 같은 runSpeed와 실제 재생 시간을 기준으로 목표를 제한한다.
      // 여기에서 다시 줄이면 다음 행동의 계획 좌표와 달라져 멈춤·순간이동이 생긴다.
      const parallelDribble = anchorLeg?.type === 'dribble'
      const to = rl.to
      const ctrl = parallelDribble ? midpoint(rl.from, to) : rl.ctrl
      const pts = samplePath(rl.from, ctrl, to)
      const len = pathLength(pts)
      // 런 도착 위치를 실제로 쓰는 첫 레그 = 마감시간의 주인 (없으면 장식 런)
      const consumer = legs.find(
        (leg) => leg.index >= rl.afterIndex && (leg.receiverId === rl.id || leg.actorId === rl.id),
      )
      return {
        rl: { ...rl, to, ctrl },
        pts,
        len,
        // 병행 런은 드리블과 정확히 같은 시간에 끝낸다. 선형 이동을 쓰므로
        // 목표가 과거 공유 링크처럼 유효 반경 밖이어도, 다음 행동에서 멈추거나
        // 순간이동하지 않고 실제 주력·가속도 속도로 목표까지 계속 움직인다.
        dur: parallelDribble ? Math.min(durFor(len, runSpeed), anchorLeg.dur) : durFor(len, runSpeed),
        consumer,
        anchorLeg,
        parallelDribble,
      }
    })
    // 마감이 이른 런부터 처리 — 지연이 생기면 뒤 레그들의 마감에 순서대로 전파되도록
    .sort((a, b) => (a.consumer?.index ?? Infinity) - (b.consumer?.index ?? Infinity))
  for (const rp of runPlan) {
    const earliest = Math.max(200, freeAfter(rp.rl.id, rp.rl.afterIndex))
    let start
    let holdUntil = null
    // 이 런의 도착 위치를 실제로 쓰는 시각. 그 전까지는 목줄을 느슨하게 풀어
    // 선수가 숨 쉬게 하고, 임박하면 조여서 계획 좌표에 정확히 세운다.
    let deadline = null
    if (rp.parallelDribble) {
      start = Math.max(earliest, rp.anchorLeg.start)
      deadline = rp.consumer
        ? rp.consumer.receiverId === rp.rl.id
          ? rp.consumer.start + rp.consumer.dur
          : rp.consumer.start
        : rp.anchorLeg.start + rp.anchorLeg.dur
      holdUntil = Math.max(start + rp.dur, deadline, actionEnd)
    } else if (rp.consumer) {
      // 수신 런은 공 도착 시각, 그 자리에서 시작하는 액션(드리블 등)은 액션 시작 시각이 마감
      deadline = rp.consumer.receiverId === rp.rl.id ? rp.consumer.start + rp.consumer.dur : rp.consumer.start
      // The receiver starts when this pass is played; `throughTarget` uses the
      // exact same ball-flight duration, so both arrive together.
      start = Math.max(earliest, rp.consumer.start)
      holdUntil = Math.max(start + rp.dur, deadline, actionEnd)
    } else {
      // 아무도 기다리지 않는 장식 런 — 앵커 액션 시작에 맞춰 출발
      const anchorLeg = legs.find((leg) => leg.index === rp.rl.afterIndex)
      const tail = legs[legs.length - 1]
      // 보조 런은 해당 액션과 동시에 시작한다. 특히 원샷 드리블과 묶인
      // 오프볼 런은 공 소유자가 드리블을 시작한 순간 곧바로 출발한다.
      start = Math.max(earliest, anchorLeg ? anchorLeg.start : tail ? tail.start + tail.dur : 300)
      holdUntil = Math.max(start + rp.dur, actionEnd)
    }
    segs.push({
      id: rp.rl.id,
      from: rp.rl.from,
      ctrl: rp.rl.ctrl,
      pts: rp.pts,
      len: rp.len,
      start,
      dur: rp.dur,
      holdUntil,
      deadline,
      // 이 런의 도착을 실제로 쓰는 액션이 있는가. 없으면 "장식 런"이라
      // 재생 길이를 끌어당기지 않는다 (아래 total 참고).
      consumed: !!rp.consumer,
      motion: 'run',
    })
  }
  const endLeg = legs[legs.length - 1]
  const chainEnd = endLeg ? endLeg.start + endLeg.dur + 200 : 500
  for (const leg of legs) {
    if (leg.type !== 'dribble') continue
    const capFrac = leg.step.success === false && leg.step.interceptFrac != null ? leg.step.interceptFrac : 1
    segs.push({
      id: leg.actorId,
      from: leg.from,
      ctrl: leg.ctrl,
      pts: leg.pts,
      len: leg.len,
      start: leg.start,
      dur: leg.dur,
      capFrac,
      motion: 'dribble',
    })
  }
  // 시작 시각 오름차순 정렬 → 나중에 시작한 세그먼트가 위치를 덮어써서
  // "런으로 이동 → 거기서 받아 드리블" 같은 연속 동작이 자연스럽게 이어진다.
  segs.sort((a, b) => a.start - b.start)
  // 선수별 세그먼트 — 매 프레임 "지금 이 선수의 위치를 누가 결정하는가"를 하나로 정하려면
  // 그 선수 것만 모아 봐야 한다. 예전에는 전체 목록을 훑으며 여러 세그먼트가 각자
  // 위치를 대입했고, 끝난 런이 나중 드리블을 덮어써 선수를 23m 되돌리는 일이 있었다.
  const segsOf = {}
  for (const s of segs) (segsOf[s.id] ??= []).push(s)

  // 재생 총 시간은 공 체인이 아니라 "모든 선수 이동이 끝나는 시점" 기준 —
  // 늦게 출발하는 런도 끝까지 뛰고 나서 재생이 멈춘다
  // 재생은 "공 전개가 끝나고 꼬리만큼" 돈다. 아무도 안 기다리는 장식 런은 여기에
  // 끼워주지 않는다 — 예전에는 그 런 하나가 2액션 전개를 14.2초까지 늘렸고,
  // 그동안 전원이 목적 없이 떠다녔다. 장식 런은 화면이 끝날 때 같이 끊긴다
  // (실제로도 공격이 끝나면 그 침투는 의미를 잃는다).
  const timedSegs = segs.filter((s) => s.motion !== 'run' || s.consumed)
  let total = Math.max(
    chainEnd + K.PLAY.TAIL_MS,
    ...timedSegs.map((s) => Math.max(s.start + s.dur, s.holdUntil ?? 0) + 500),
  )

  // ── 살아있는 움직임: 매 프레임 볼-추종 스티어링 시뮬레이션 ──
  // 지시(스크립트)가 없는 순간의 모든 선수는 "공 위치에 반응하는 목표점"을 향해
  // 가속/감속하는 조향 모델로 움직인다. 라인 업다운·압박·마킹·이벤트 리액션 포함.
  // 노이즈는 시드 고정이라 리플레이 감각도 유지된다.
  const sim = {}
  for (const p of [...players, ...opponents]) sim[p.id] = { x: p.x, y: p.y, vx: 0, vy: 0 }
  // 선수별 최고 속도 — 앰비언트 이동도 이 값을 넘지 못한다. 지시받은 오프볼 런과
  // 같은 공식(runSpeedOf)을 써야 "지시하면 느려지고 안 하면 빨라지는" 역전이 안 생긴다.
  const capOf = {}
  // 드리블 속도가 느린 선수의 주력보다 빠를 수 있어, 순간이동 안전망 하한을 함께 잡는다.
  const jumpCapOf = {}
  for (const p of [...players, ...opponents]) {
    capOf[p.id] = runSpeedOf(p)
    jumpCapOf[p.id] = Math.max(capOf[p.id], K.SPEED.dribble) * K.PLAY.JUMP_CAP
  }
  // 템포에 따른 급함 배율 — tick 안에서 갱신된다 (아래 tempo 참고)
  const urgencyRef = { v: 1 }
  // 의도(INTENT)에 따른 앰비언트 속도. 어떤 경우에도 자기 주력을 넘지 않는다.
  const paceOf = (id, intent) => Math.min(capOf[id], capOf[id] * intent * urgencyRef.v)
  // 목표까지 멀수록 강도가 오른다 — INTENT는 "다 왔을 때"의 값이고,
  // 뒤처져 있으면 거기서 전력까지 올라간다. 라인 조정을 조깅으로 낮추자
  // 역습에서 수비·미드필더가 걸어서 따라가던 문제(측정 1.5~1.9 m/s)를 잡는다.
  const paceTo = (id, target, intent) => {
    const s = sim[id]
    const d = Math.hypot(target.x - s.x, target.y - s.y)
    const t = clamp((d - K.PLAY.EFFORT_NEAR) / (K.PLAY.EFFORT_FAR - K.PLAY.EFFORT_NEAR), 0, 1)
    return paceOf(id, intent + (1 - intent) * t)
  }

  // 선수별 "약속" 이벤트: t 시점까지 point 근처에 있어야 한다 — 스크립트 출발점,
  // 스크립트 종점, 패스 받을 지점. 마지막 약속이 지나면 자유(팀 셰이프) 상태.
  // kind: 'recv'(패스 받을 지점)는 다른 약속과 구분한다 — 공이 그리로 날아가므로
  // 그 자리를 반드시 지켜야 하고, 나머지 약속은 늦어도 화면상 티가 나지 않는다.
  const events = {}
  const addEvent = (id, tm, point, kind = 'move') => (events[id] ??= []).push({ t: tm, point, kind })
  for (const s of segs) {
    addEvent(s.id, s.start, s.pts[0])
    addEvent(s.id, s.start + s.dur, pointAtLength(s.pts, (s.capFrac ?? 1) * s.len))
  }
  for (const leg of legs) {
    if (leg.type === 'pass' && leg.receiverId) addEvent(leg.receiverId, leg.start + leg.dur, leg.to, 'recv')
  }
  for (const list of Object.values(events)) list.sort((a, b) => a.t - b.t)

  // 목표점에 섞는 느린 노이즈(선수별 시드 고정) — 조향이 따라가며 자연스러운 잔 움직임이 된다
  const jrng = mulberry32(seed ^ 0x7f4a7c15)
  const noiseOf = {}
  const ringOf = {} // 골 세리머니 때 득점자 주변에 모이는 자리
  for (const p of [...players, ...opponents]) {
    noiseOf[p.id] = { a: 1.1 + jrng() * 1.1, w1: 0.5 + jrng() * 0.7, w2: 0.5 + jrng() * 0.7, p1: jrng() * 6.283, p2: jrng() * 6.283 }
    const ang = jrng() * 6.283
    ringOf[p.id] = { x: Math.cos(ang) * (2 + jrng() * 3.5), y: Math.sin(ang) * (2 + jrng() * 3.5) }
  }
  const noise = (id, sec) => {
    const n = noiseOf[id]
    return { x: n.a * Math.sin(n.w1 * sec + n.p1), y: n.a * Math.cos(n.w2 * sec + n.p2) }
  }

  // 인터셉터는 차단 지점으로 달려가서 공이 닿는 순간 뺏는다
  let interceptor = null
  if (failStep?.interceptorId) {
    const failLeg = legs[legs.length - 1]
    const o = byId[failStep.interceptorId]
    const arrive = failLeg.start + failLeg.dur * (failStep.interceptFrac ?? 1)
    interceptor = {
      id: o.id,
      from: { x: o.x, y: o.y },
      to: failStep.interceptPoint,
      start: failLeg.start,
      end: Math.max(arrive, failLeg.start + 120),
    }
  }

  // 이벤트 리액션 타이밍: 슛 순간 멈칫 / 골 세리머니 / 공수 전환·리셋
  const lastLeg = legs[legs.length - 1]
  const shotLeg = lastLeg?.type === 'shot' ? lastLeg : null
  const goalTime = shotLeg && shotLeg.step.success ? shotLeg.start + shotLeg.dur : null
  const scorerId = shotLeg?.actorId
  const turnoverTime = failStep ? (interceptor ? interceptor.end : lastLeg.start + lastLeg.dur) : null
  // 오프사이드는 공이 리시버에 닿는 순간 휘슬 — 그때부터 깃발 표식과 사운드 신호를 띄운다
  const offsideTime = failStep?.offside ? lastLeg.start + lastLeg.dur : null
  const offsideLineX = failStep?.offsideLineX ?? null
  if (offsideTime) total = Math.max(total, offsideTime + 2000)
  const turnoverLoose = failStep ? failStep.type !== 'shot' : false // 패스류 실패 → 공 주변 쟁탈
  // 리액션이 보일 시간 확보 (세리머니/공수 전환)
  if (goalTime) total = Math.max(total, goalTime + 2200)
  if (turnoverTime) total = Math.max(total, turnoverTime + 1600)

  // 중계 자막 — 액션 시작·결정적 순간마다 멘트 (시드 rng라 리플레이 동일)
  const rngC = mulberry32(seed ^ 0x51ab7)
  const captions = []
  const FAIL_EVENT = {
    pass: { cut: 'passCut', miss: 'passMiss' },
    dribble: { cut: 'dribbleStopped', miss: 'dribbleMiss' },
    shot: { cut: 'shotBlocked', miss: 'shotMiss' },
  }
  legs.forEach((leg, i) => {
    const names = {
      a: byId[leg.actorId].name,
      b: leg.receiverId && leg.receiverId !== 'GOAL' ? byId[leg.receiverId].name : undefined,
      d: leg.step.interceptorId ? byId[leg.step.interceptorId].name : undefined,
    }
    captions.push({ t: leg.start, text: commentaryFor(leg.type, names, rngC) })
    if (leg.step.offside) {
      // 오프사이드: 패스는 그대로 날아가고, 공이 닿는 순간 부심 깃발 + 휘슬
      captions.push({ t: leg.start + leg.dur, text: commentaryFor('offside', names, rngC) })
    } else if (leg.step.success === false) {
      // 빠진 패스(missFrac)는 공이 원래 목표를 지나치는 순간에 자막이 뜬다
      const when = leg.start + leg.dur * (leg.step.interceptFrac ?? leg.missFrac ?? 1) + 100
      const failEvent = leg.step.savedById
        ? 'shotSaved'
        : FAIL_EVENT[leg.type][names.d ? 'cut' : 'miss']
      captions.push({ t: when, text: commentaryFor(failEvent, names, rngC) })
    } else if (leg.type === 'shot' && i === legs.length - 1) {
      captions.push({ t: leg.start + leg.dur, text: commentaryFor('goal', names, rngC) })
    }
  })
  if (failIndex === -1 && actions[actions.length - 1].type !== 'shot') {
    captions.push({ t: chainEnd - 150, text: commentaryFor('advance', {}, rngC) })
  }

  // 템포·지원 런 상태 (프레임 간 유지)
  let prevBall = null // 공 속도 계산용 직전 프레임 공 위치
  let tempo = 0 // 공 속도 EMA 0~1 — 역습·긴 패스 국면일수록 1에 가깝다
  let supPrev = new Set() // 직전 프레임 지원 런 담당 (히스테리시스용)
  const supUntil = {} // 지원 런 역할 최소 유지 시각 — 매 프레임 후보가 뒤바뀌는 깜빡임 방지
  let frozenAdv = null // 체인 종료 시점의 전진량 (공↔셰이프 되먹임 차단)
  let advSmooth = null // 완화된 전진량 — 액션이 바뀔 때 라인이 앞뒤로 튀지 않게
  const aimPrev = {} // 직전 목표 — 역할이 바뀌어 목표가 크게 튈 때 부드럽게 옮긴다

  // 바라보는 방향 (라디안). 움직이면 진행 방향, 서 있으면 **역할이 정한 곳**을 본다.
  //
  // 예전에는 서 있는 선수가 전부 공만 노려봤다 — 22명이 한 점을 향해 고개를 고정하고
  // 있으니 실감이 떨어진다는 평을 받았다(베타테스트). 실제로는 공을 안 보는 순간이 더 많다:
  // 앞서 뛰는 공격수는 골문과 뒷공간을 보고, 수비수는 자기가 맡은 상대를 본다.
  // 여기에 느린 좌우 스캔을 얹어 "서 있어도 살아 있는" 느낌을 만든다.
  const facePrev = {}
  const faceAng = {}
  const updateFace = (id, x, y, ball, dt, sec, gaze) => {
    const prev = facePrev[id]
    facePrev[id] = { x, y }
    const moving = prev && Math.hypot(x - prev.x, y - prev.y) > 0.03
    let target
    let scan = 0
    if (moving) {
      target = Math.atan2(y - prev.y, x - prev.x)
    } else {
      const look = gaze ?? ball
      if (!look) return faceAng[id] ?? 0
      target = Math.atan2(look.y - y, look.x - x)
      // 서 있는 동안만 훑어본다 — 달리면서 고개를 흔들면 어지럽다.
      // 선수마다 위상이 달라(noiseOf의 p1) 전원이 같이 흔들리지 않는다.
      scan = ((K.PLAY.SCAN_DEG * Math.PI) / 180) * Math.sin(2 * Math.PI * K.PLAY.SCAN_HZ * sec + noiseOf[id].p1)
    }
    let cur = faceAng[id] ?? target
    let d = target + scan - cur
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    cur += d * Math.min(1, dt * 9)
    faceAng[id] = cur
    return cur
  }

  const lastRender = {} // 직전 프레임에 실제로 그린 좌표 — 순간이동 안전망의 기준
  let rafId = null
  const t0 = performance.now()
  let lastNow = t0
  let warped = 0 // 연출 시간 (ms) — 슬로모션 구간에선 실제 시간보다 느리게 흐른다
  const trail = [] // 볼 트레일 (빠르게 나는 동안의 최근 궤적)
  const ball0x = basePos(ballOwnerId).x // 이번 공격 시작 시점의 공 x — 아군 전진량 기준점
  const tick = (now) => {
    const realDt = Math.min(Math.max((now - lastNow) / 1000, 0), 0.05)
    lastNow = now
    // 슬로모션: 슛이 발을 떠나기 직전부터 골라인 도달까지 시간 자체를 0.35배로.
    // 모든 타임라인이 warped 기준이라 판정·자막·이동이 함께 늦춰진다 (판정 결과는 불변).
    const slowmo = !!(shotLeg && warped >= shotLeg.start - 120 && warped <= shotLeg.start + shotLeg.dur)
    warped += realDt * 1000 * (slowmo ? 0.35 : 1)
    const el = warped
    const dt = realDt * (slowmo ? 0.35 : 1)
    const sec = el / 1000

    // 1) 위치 권한 — 프레임마다 선수당 **단 하나**의 결정권자를 고른다.
    //
    //    진행 중인 세그먼트  >  마지막으로 시작한 세그먼트의 잔여 앵커  >  다음 세그먼트 대기
    //
    //    핵심은 "마지막으로 시작한" 것만 앵커를 주장할 수 있다는 규칙이다. 예전에는 끝난
    //    런의 holdUntil이 체인 끝까지 살아 있어서, 같은 선수가 나중에 드리블·슛을 마치는
    //    순간 그 좀비 세그먼트가 선수를 런 종점으로 잡아챘다(측정 23.7m 순간이동).
    //
    //    앵커는 이제 "못 박기"가 아니라 "목표 + 목줄"이다. 위치를 대입하지 않고
    //    아래 조향(integrate)에 넘겨 물리적으로 이어지는 움직임으로 만든다.
    const scripted = new Set()
    const anchors = {} // id → { point, leash, lock } — 조향이 참고할 제약
    for (const id in segsOf) {
      let active = null
      let lastStarted = null
      let next = null
      for (const s of segsOf[id]) {
        if (s.start <= el) {
          lastStarted = s // 정렬돼 있으므로 마지막에 남는 것이 가장 늦게 시작한 것
          if (el <= s.start + s.dur) active = s
        } else if (!next) next = s
      }
      if (active) {
        // 진행 중인 지시는 그대로 경로를 따른다 — 도착 시각·지점이 정확해야
        // 공이 발밑에 떨어진다. 여기만 위치를 직접 대입한다.
        const progress = (el - active.start) / active.dur
        const k = Math.min(clamp(progress, 0, 1), active.capFrac ?? 1)
        const pos = pointAtLength(active.pts, k * active.len)
        scripted.add(id)
        Object.assign(sim[id], { x: pos.x, y: pos.y, vx: 0, vy: 0 })
        continue
      }
      if (lastStarted && lastStarted.holdUntil != null && el <= lastStarted.holdUntil) {
        // 런을 마치고 다음 액션을 기다리는 중. 소비 액션이 다가올수록 목줄을 조인다.
        const point = pointAtLength(lastStarted.pts, (lastStarted.capFrac ?? 1) * lastStarted.len)
        const slack = lastStarted.deadline == null ? Infinity : lastStarted.deadline - el
        const leash = K.PLAY.LEASH_HOLD * clamp((slack - K.PLAY.LEASH_LOCK_MS) / K.PLAY.LEASH_LOCK_MS, 0, 1)
        anchors[id] = { point, leash, lock: leash < 0.2 }
        continue
      }
      if (next) {
        // 아직 시작하지 않은 지시가 있다 — 그 출발점 근처를 지킨다.
        // 예전에는 여기서 좌표를 대입해 3.8초씩 완전히 굳어 있었다.
        // 출발이 임박하면 목줄을 0으로 조여, 시작 프레임에 스냅이 남지 않게 한다.
        const leash = K.PLAY.LEASH_WAIT * clamp((next.start - el - K.PLAY.WAIT_LOCK_MS) / K.PLAY.WAIT_LOCK_MS, 0, 1)
        anchors[id] = { point: next.from, leash, lock: leash < 0.2 }
      }
    }
    if (interceptor) {
      if (el >= interceptor.start && el <= interceptor.end) {
        // 차단 선수도 그 전까지의 수비 이동 위치에서 출발해야 한다.
        if (!interceptor.started) {
          interceptor.from = { x: sim[interceptor.id].x, y: sim[interceptor.id].y }
          interceptor.started = true
        }
        const k = ease((el - interceptor.start) / (interceptor.end - interceptor.start))
        scripted.add(interceptor.id)
        Object.assign(sim[interceptor.id], {
          x: interceptor.from.x + (interceptor.to.x - interceptor.from.x) * k,
          y: interceptor.from.y + (interceptor.to.y - interceptor.from.y) * k,
          vx: 0,
          vy: 0,
        })
      } else if (el > interceptor.end && !interceptor.done) {
        interceptor.done = true
        Object.assign(sim[interceptor.id], { x: interceptor.to.x, y: interceptor.to.y, vx: 0, vy: 0 })
      }
    }

    // (예전의 waitingScript 블록은 위 1)의 anchors로 흡수됐다 — 대기는 스냅이 아니라 목줄이다)

    // 2) 공 위치 — 비행 중엔 궤적 위, 소유 중엔 소유자 발밑
    const ballAt = (getPos) => {
      let ball = null
      let ownerId = ballOwnerId
      for (const leg of legs) {
        if (el < leg.start) break
        const done = el >= leg.start + leg.dur
        const k = ease((el - leg.start) / leg.dur)
        const capFrac = leg.step.success === false && leg.step.interceptFrac != null ? leg.step.interceptFrac : 1
        if (leg.type === 'dribble') {
          ownerId = leg.actorId
        } else if (!done) {
          ownerId = null
          ball = {
            ...pointAtLength(leg.pts, Math.min(k, capFrac) * leg.len),
            // 로빙은 비행 중 작아지는 공으로 높이를 표현한다. 시작·도착에서는 0이라
            // 자연스럽게 발밑 공으로 돌아온다.
            height: leg.aerial ? K.PLAY.LOB_HEIGHT * Math.sin(Math.PI * Math.min(k, capFrac)) : 0,
          }
          // 성공할 패스는 리시버의 "실제" 위치로 유도한다.
          // 궤적은 계획 좌표로 그려지는데 선수는 조향·노이즈로 그 자리에서 밀려나 있을 수 있고,
          // 그대로 두면 공이 빈 잔디에 떨어졌다가 선수에게 튀어 "공이 혼자 움직이는" 것처럼 보인다.
          // 보정을 k²로 실어 초반 비행은 계획 궤적 그대로, 끝에서만 발밑으로 붙는다.
          // (실제 패스도 "받을 사람이 있을 자리"로 차므로 연출상으로도 자연스럽다)
          // 공은 그려진 궤적 그대로 날아간다. 빗나가면 빗나간 자리로 가야 한다 —
          // 리시버 쪽으로 휘게 만들면 "유도탄"이 되어 패스의 의미가 사라진다.
          // 대신 리시버가 약속 지점을 지키게 해서(아래 3번 블록) 애초에 어긋나지 않게 한다.
        } else if (leg.step.success && leg.type === 'pass') {
          ownerId = leg.receiverId
        } else {
          ownerId = null // 슛(골/빗나감) 또는 실패한 패스 — 공은 궤적 끝에
          ball = pointAtLength(leg.pts, capFrac * leg.len)
        }
      }
      if (ownerId) ball = { ...getPos(ownerId), height: 0 }
      if (interceptor && el > interceptor.end) ball = { ...getPos(interceptor.id), height: 0 }
      return ball
    }
    const ballSteer = ballAt((id) => sim[id])

    const mode =
      goalTime && el > goalTime
        ? 'goal'
        : turnoverTime && el > turnoverTime
          ? turnoverLoose || interceptor
            ? 'turnover'
            : 'reset'
          : 'live'
    const freeze = shotLeg && el >= shotLeg.start && el < shotLeg.start + 280 // 슛 순간 전원 멈칫
    // 팀 대형은 공의 **현재 위치**가 아니라 **지금 진행 중인 액션의 도착점**을 보고 움직인다.
    // 현재 위치로 목표를 잡으면 라인이 공에 끌려다닌다 — 역습이 시작돼도 뒷선은
    // 공이 실제로 전진한 만큼만 조금씩 따라와서, 첫 1.5초 동안 제자리에 서 있었다.
    // 실제 축구에서는 공이 어디로 갈지 보고 먼저 출발한다.
    // (압박·마킹은 아래에서 계속 현재 위치를 쓴다 — 그건 지금 공에 반응하는 것이 맞다)
    let legNow = null
    for (const leg of legs) {
      if (el >= leg.start && el <= leg.start + leg.dur) legNow = leg
    }
    // 슛은 라인을 끌어올리지 않는다 — 공이 골문으로 날아간다고 팀 전체가 골라인까지
    // 밀고 올라가지는 않는다. 슛 중에는 "찬 자리"를 기준으로 대형을 유지한다.
    // (이걸 안 빼면 전원이 골문 앞까지 갔다가 세리머니하러 되돌아와 유턴이 된다)
    const ballAim = legNow ? (legNow.type === 'shot' ? legNow.from : legNow.to) : ballSteer

    // 공 전개가 끝나면 전진량을 그 시점 값으로 얼린다.
    // 공은 소유자를 따라가고, 소유자는 팀 셰이프를 따라가고, 셰이프는 다시 공을 따라간다 —
    // 이 고리가 살아 있으면 체인이 끝난 뒤 팀 전체가 뒤로 흘러내린다(측정 47m 후퇴).
    // 액션이 바뀌는 순간 전진량이 뚝 끊기지 않도록 완화해서 따라간다(특히 뒤로 주는 패스).
    const advRaw = ballAim.x - 60
    advSmooth = advSmooth == null ? advRaw : advSmooth + (advRaw - advSmooth) * Math.min(1, dt * K.PLAY.ADV_EASE)
    if (el > chainEnd && frozenAdv == null) frozenAdv = { adv: advSmooth, home: Math.max(0, advSmooth + 60 - ball0x) }
    const settled = el > chainEnd + K.PLAY.SETTLE_MS
    const adv = frozenAdv ? frozenAdv.adv : advSmooth // 하프라인 기준 공의 전진량 (상대 라인다운용)
    // 아군 라인업은 "이번 공격 시작점 대비" 전진량 — 자기 진영에서 시작해도 후퇴하지 않고
    // 공격 방향(오른쪽)으로만 밀고 올라간다
    const advHome = frozenAdv ? frozenAdv.home : Math.max(0, advSmooth + 60 - ball0x)
    // 공이 밀고 올라간 만큼 라인 전체가 더 바짝 따라 올라간다(내려앉는다).
    // ROW_K는 정상 국면의 값이라, 역습에서 뒷선이 그대로 남아 "공격수만 뛴다"로 보였다.
    // 골키퍼는 제외 — 아무리 밀어붙여도 골문은 비울 수 없다.
    const pushHome = clamp(advHome / K.PLAY.PUSH_FULL, 0, 1) * K.PLAY.PUSH_GAIN
    const pushOpp = clamp(Math.max(0, adv) / K.PLAY.PUSH_FULL, 0, 1) * K.PLAY.PUSH_GAIN
    const followK = (base, position, push) => (position === 'GK' ? base : base + (1 - base) * push)

    // 템포: 공 속도 EMA — 공이 빠르게 움직이는 국면(역습·긴 패스)엔 오프볼 전원이 급해진다.
    // 실제 축구에서 볼 템포와 오프볼 스프린트 강도가 함께 오르는 것의 근사.
    const ballSpd = prevBall && dt > 0.001 ? Math.hypot(ballSteer.x - prevBall.x, ballSteer.y - prevBall.y) / dt : 0
    prevBall = ballSteer
    tempo += (clamp(ballSpd / K.PLAY.TEMPO_REF, 0, 1) - tempo) * Math.min(1, dt * 3)
    const urgency = 1 + K.PLAY.URGENCY_GAIN * tempo // 1.00 ~ 1.35
    urgencyRef.v = urgency

    // 판정 엔진(resolve.js)이 액션마다 계산해둔 수비 좌표 — 진행 중인 레그의 목표 좌표.
    // 100% 강제가 아니라 조향 목표로만 쓴다(압박·노이즈가 위에 얹힘) — 보는 경험 우선.
    let defWaypoint = null
    for (const leg of legs) if (el >= leg.start) defWaypoint = leg.step.defPos ?? defWaypoint

    // 선수별 "약속" 조회 — 지원 런 선발보다 먼저 알아야 한다.
    // 곧 공을 받을 선수를 다른 곳으로 뛰게 하면 패스가 빈 자리에 떨어지기 때문.
    const lastPast = (id) => {
      let pt = null
      for (const e of events[id] ?? []) if (e.t <= el) pt = e.point
      return pt
    }
    const nextPending = (id) => (events[id] ?? []).find((e) => e.t > el)
    // 이 시간 안에 약속이 잡힌 선수는 "예약된" 상태로 본다 (지원 런 제외 대상)
    const RESERVED_MS = 2500
    // 패스 받을 선수가 미리 자리를 잡기 시작하는 여유 — 공보다 먼저 도착해 있어야 한다
    const RECV_HOLD_MS = 2500
    const reserved = (id) => {
      const e = nextPending(id)
      return !!e && e.t - el <= RESERVED_MS
    }

    // 압박: 공과 가까운 자유 상태 상대 2명이 공을 향해 다가간다
    const pressers = new Set()
    if (mode === 'live') {
      const cands = opponents
        .filter((o) => o.position !== 'GK' && !scripted.has(o.id))
        .map((o) => ({ id: o.id, d: Math.hypot(sim[o.id].x - ballSteer.x, sim[o.id].y - ballSteer.y) }))
        .sort((a, b) => a.d - b.d)
      for (const c of cands.slice(0, 2)) if (c.d < 30) pressers.add(c.id)
    }

    // 지원 런: 공과 가까운 자유 아군 2명이 공보다 앞 공간으로 침투해 패스 옵션을 만든다.
    // 판정에 안 쓰이는 순수 연출이라 자유롭게 뛴다. 히스테리시스(-4m 보정)로 역할 깜빡임 방지.
    //
    // 공 전개가 끝난 뒤(settled)에는 뽑지 않는다 — 끝난 공격에 계속 침투 런을 넣으면
    // 목표가 "공 앞 10m"와 "자기 원위치" 사이를 오가며 선수가 앞뒤로 왔다 갔다 한다.
    const supporters = new Set()
    if (mode === 'live' && !settled) {
      players
        .filter((p) => !scripted.has(p.id))
        .map((p) => {
          const d = Math.hypot(sim[p.id].x - ballSteer.x, sim[p.id].y - ballSteer.y)
          return { id: p.id, d: supPrev.has(p.id) ? d - 4 : d }
        })
        .filter((c) => c.d > 3 && c.d < 45) // 공 소유자(발밑)와 너무 먼 선수는 제외
        .filter((c) => !reserved(c.id)) // 곧 공을 받을 선수는 자리를 지킨다
        .sort((a, b) => a.d - b.d)
        .slice(0, 3)
        .forEach((c) => supporters.add(c.id))
      // 한번 침투를 시작했으면 최소한 이만큼은 유지한다. 거리 순으로만 뽑으면
      // 두 선수가 비슷한 거리일 때 매 프레임 역할이 뒤바뀌며 둘 다 제자리에서 떤다.
      for (const id of supPrev) if ((supUntil[id] ?? 0) > el && !reserved(id)) supporters.add(id)
      for (const id of supporters) if (!supPrev.has(id)) supUntil[id] = el + K.PLAY.SUPPORT_HOLD_MS
    }
    supPrev = supporters

    // 조향 적분: 목표를 향해 가속하되 가속 한계·도착 감속으로 무게감을 준다.
    // noiseScale: 약속 장소로 갈 때는 잔 움직임을 죽인다 — 공 받을 자리에서 흔들리면
    // 패스가 발밑에 안 떨어진 것처럼 보인다.
    //
    // 앵커(anchors)가 있으면 목표를 그 반경 안으로 끌어당긴다. 스크립트를 기다리거나
    // 마친 선수가 "그 자리를 지키되 굳어 있지는 않게" 하는 장치다.
    const integrate = (id, rawTarget, maxSpeed, noiseScale = 1) => {
      const s = sim[id]
      const a = anchors[id]
      // 역할이 바뀌면 목표가 30~50m씩 튀어 선수가 제자리에서 유턴했다(측정 47m 후퇴).
      // 크게 튄 목표는 한 번에 따라가지 않고 BLEND 동안 옮겨 간다 — 방향 전환이
      // "갑자기 뒤돌기"가 아니라 "판단을 바꾸는 움직임"으로 보이게.
      const prevAim = aimPrev[id]
      if (!prevAim) aimPrev[id] = { x: rawTarget.x, y: rawTarget.y }
      else {
        const jump = Math.hypot(rawTarget.x - prevAim.x, rawTarget.y - prevAim.y)
        const k = jump > K.PLAY.TARGET_JUMP ? Math.min(1, (dt * 1000) / K.PLAY.TARGET_BLEND_MS) : 1
        prevAim.x += (rawTarget.x - prevAim.x) * k
        prevAim.y += (rawTarget.y - prevAim.y) * k
      }
      let aim = aimPrev[id]
      if (a) {
        if (a.leash <= 0.01) aim = a.point
        else {
          const dx = aim.x - a.point.x
          const dy = aim.y - a.point.y
          const d = Math.hypot(dx, dy)
          if (d > a.leash) aim = { x: a.point.x + (dx / d) * a.leash, y: a.point.y + (dy / d) * a.leash }
        }
        noiseScale = Math.min(noiseScale, a.lock ? 0.05 : 0.35)
      }
      const nz = noise(id, sec)
      const tx = clamp(aim.x + nz.x * noiseScale, 1.5, 118.5)
      const ty = clamp(aim.y + nz.y * noiseScale, 1.5, 78.5)
      const speed = freeze ? maxSpeed * 0.12 : maxSpeed
      const dx = tx - s.x
      const dy = ty - s.y
      const dist = Math.hypot(dx, dy)
      const want = Math.min(speed, dist * 2)
      const wx = dist > 0.001 ? (dx / dist) * want : 0
      const wy = dist > 0.001 ? (dy / dist) * want : 0
      let ax = wx - s.vx
      let ay = wy - s.vy
      const alen = Math.hypot(ax, ay)
      const amax = 14 * dt
      if (alen > amax && alen > 0) {
        ax = (ax / alen) * amax
        ay = (ay / alen) * amax
      }
      s.vx += ax
      s.vy += ay
      s.x = clamp(s.x + s.vx * dt, 1.5, 118.5)
      s.y = clamp(s.y + s.vy * dt, 1.5, 78.5)
    }
    // 3) 아군 자유 선수: 약속 장소 대기 → 팀 셰이프(라인 업다운) / 세리머니 / 복귀
    for (const p of players) {
      if (scripted.has(p.id)) continue
      const pending = nextPending(p.id)
      let target = null
      let spd = paceOf(p.id, K.PLAY.INTENT.SHAPE)
      let nz = 1 // 노이즈 배율 — 약속 장소로 향할 때 낮춘다
      if (pending) {
        const s = sim[p.id]
        const need = (Math.hypot(pending.point.x - s.x, pending.point.y - s.y) / capOf[p.id]) * 1000
        // 패스를 받을 선수는 공이 그 자리로 날아오므로 일찍 자리를 잡고 지킨다.
        // (공을 리시버 쪽으로 휘게 하는 대신 여기서 어긋남을 없앤다 — 궤적은 그린 대로 간다)
        // 나머지 약속은 늦어도 티가 안 나므로 임박할 때까지 일반 무빙을 계속한다.
        const hold = pending.kind === 'recv' ? RECV_HOLD_MS : 0
        if (pending.t - el <= need + 500 + hold) {
          target = pending.point
          spd = paceOf(p.id, K.PLAY.INTENT.MEET)
          // 도착이 임박할수록 잔 움직임을 줄여, 받는 순간엔 그 자리에 정확히 선다
          nz = pending.kind === 'recv' ? clamp((pending.t - el) / 1400, 0.05, 1) : clamp((pending.t - el) / 900, 0.15, 1)
        }
      }
      if (!target) {
        if (mode === 'goal') {
          const sc = sim[scorerId]
          target = p.id === scorerId ? { x: sim[p.id].x, y: sim[p.id].y } : { x: sc.x + ringOf[p.id].x, y: sc.y + ringOf[p.id].y }
          spd = paceOf(p.id, K.PLAY.INTENT.CELEBRATE)
        } else if (mode === 'turnover' || mode === 'reset') {
          target = { x: p.x, y: p.y } // 대형 복귀
          spd = paceOf(p.id, K.PLAY.INTENT.RESET)
        } else if (supporters.has(p.id)) {
          // 지원 런: 공의 앞(골 쪽), 자기 쪽 사이드로 벌려 침투 — 패스 받을 공간 만들기
          const side = sim[p.id].y >= ballSteer.y ? 1 : -1
          target = { x: Math.min(ballSteer.x + 10, 113), y: clamp(ballSteer.y + side * 10, 4, 76) }
          spd = paceOf(p.id, K.PLAY.INTENT.SUPPORT)
        } else {
          const anchor = lastPast(p.id) ?? { x: p.x, y: p.y }
          const k = followK(ROW_K_HOME[p.position] ?? 0.5, p.position, pushHome)
          target = { x: anchor.x + k * advHome, y: anchor.y + 0.25 * (ballSteer.y - anchor.y) }
          // 라인 조정은 기본이 조깅이지만, 뒤처져 있으면 그만큼 세게 따라붙는다
          spd = paceTo(p.id, target, K.PLAY.INTENT.SHAPE)
        }
      }
      integrate(p.id, target, spd, nz)
    }
    // 4) 상대 자유 선수: 라인 다운·볼사이드 시프트 / 압박 / 마킹 / 리액션
    for (const o of opponents) {
      if (scripted.has(o.id)) continue
      let target
      let spd = paceOf(o.id, K.PLAY.INTENT.SHAPE)
      if (mode === 'goal') {
        target = { x: o.x + 2, y: o.y } // 낙담 — 느릿하게 제자리 쪽
        spd = paceOf(o.id, K.PLAY.INTENT.DEJECT)
      } else if (mode === 'turnover') {
        const s = sim[o.id]
        target = { x: s.x + (ballSteer.x - s.x) * 0.35, y: s.y + (ballSteer.y - s.y) * 0.35 } // 공수 전환: 볼 지원
        spd = paceOf(o.id, K.PLAY.INTENT.RESET)
      } else if (mode === 'reset') {
        target = { x: o.x, y: o.y }
        spd = paceOf(o.id, K.PLAY.INTENT.RESET)
      } else if (shotLeg && o.position === 'GK' && el >= shotLeg.start && el <= shotLeg.start + shotLeg.dur + 450) {
        // GK 다이브: 슛 궤적이 골라인에 닿을 지점으로 몸을 던진다 (순수 연출 — 판정 무관).
        // 달리기가 아니라 몸을 던지는 동작이라 주력 상한을 넘어도 어색하지 않다.
        target = { x: 117.6, y: clamp(shotLeg.to.y, 35, 45) }
        spd = capOf[o.id] * K.PLAY.INTENT.GK_DIVE
      } else if (pressers.has(o.id)) {
        const gx = 120 - ballSteer.x
        const gy = 40 - ballSteer.y
        const gl = Math.hypot(gx, gy) || 1
        target = { x: ballSteer.x + (gx / gl) * 2.2, y: ballSteer.y + (gy / gl) * 2.2 } // 공-골문 사이 압박 지점
        spd = paceOf(o.id, K.PLAY.INTENT.PRESS)
      } else if (defWaypoint?.[o.id]) {
        const wp = defWaypoint[o.id]
        const dwp = Math.hypot(sim[o.id].x - wp.x, sim[o.id].y - wp.y)
        if (dwp > 1.6) {
          // 판정과 같은 수비 이동: 엔진이 계산한 좌표로 급히 복귀.
          // 멀리 벗어나 있을수록 전력에 가깝게 — 20m 밖인데 조깅으로 돌아오면 안 된다.
          target = wp
          spd = paceTo(o.id, target, K.PLAY.INTENT.RECOVER)
        } else {
          // 도착 후 셰도잉: 근처 아군 공격수를 골사이드로 따라다니는 잔움직임.
          // 판정 좌표에서 ≤2.5m — 화면과 판정이 어긋나 보이지 않는 안전 반경.
          let near = null
          for (const p of players) {
            const hp = sim[p.id]
            const d = Math.hypot(hp.x - wp.x, hp.y - wp.y)
            if (d < 9 && (!near || d < near.d)) near = { d, p: hp }
          }
          if (near) {
            let vx = near.p.x + 1.2 - wp.x // 골사이드: 공격수보다 자기 골문(x=120) 쪽
            let vy = near.p.y - wp.y
            const vl = Math.hypot(vx, vy)
            if (vl > 3) {
              vx = (vx / vl) * 3
              vy = (vy / vl) * 3
            }
            target = { x: wp.x + vx, y: wp.y + vy }
          } else target = wp
          spd = paceOf(o.id, K.PLAY.INTENT.SHADOW)
        }
      } else {
        const k = followK(ROW_K_OPP[o.position] ?? 0.4, o.position, pushOpp)
        target = { x: o.x + k * Math.max(0, adv), y: o.y + 0.3 * (ballSteer.y - 40) }
        spd = paceTo(o.id, target, K.PLAY.INTENT.SHAPE)
        if (o.position === 'DF') {
          // 소프트 마킹: 근처 아군 선수 쪽으로 살짝 끌린다
          let best = null
          for (const p of players) {
            const hp = sim[p.id]
            const d = Math.hypot(hp.x - sim[o.id].x, hp.y - sim[o.id].y)
            if (d < 12 && (!best || d < best.d)) best = { d, p: hp }
          }
          if (best) target = { x: target.x * 0.65 + best.p.x * 0.35, y: target.y * 0.65 + best.p.y * 0.35 }
        }
      }
      integrate(o.id, target, spd)
    }

    // 5) 최후 안전망 — 한 프레임 이동량을 물리 한계로 자른다.
    //
    // 위 어느 경로(스크립트 대입·조향·앵커)로 위치가 바뀌었든 여기를 통과해야 한다.
    // "순간이동을 만들지 않도록 조심한다"가 아니라 **구조적으로 불가능하게** 만드는 장치다.
    // 잘라낸 값을 sim에 되쓰기 때문에 다음 프레임은 잘린 위치에서 이어진다 —
    // 목표가 멀면 순간이동 대신 전력 질주로 보인다.
    for (const id in sim) {
      const s = sim[id]
      const q = lastRender[id]
      if (q) {
        const dx = s.x - q.x
        const dy = s.y - q.y
        const d = Math.hypot(dx, dy)
        const cap = jumpCapOf[id] * dt
        if (d > cap && d > 0) {
          s.x = q.x + (dx / d) * cap
          s.y = q.y + (dy / d) * cap
        }
      }
      lastRender[id] = { x: s.x, y: s.y }
    }

    // 6) 렌더 좌표(+바라보는 방향) + 공 + 자막
    const home = {}
    const opp = {}
    for (const p of players) home[p.id] = { x: sim[p.id].x, y: sim[p.id].y }
    for (const o of opponents) opp[o.id] = { x: sim[o.id].x, y: sim[o.id].y }
    const ball = ballAt((id) => home[id] ?? opp[id] ?? basePos(id))
    // 시선 대상: 공보다 앞서 나간 공격수는 골문(과 뒷공간)을 본다.
    // 수비수는 자기 근처의 상대 공격수를 본다 — 마크 대상에서 눈을 떼지 않는다.
    for (const p of players) {
      const me = home[p.id]
      const gaze = ball && me.x > ball.x + K.PLAY.GAZE_AHEAD ? { x: K.GOAL.x, y: K.GOAL.y } : ball
      me.a = updateFace(p.id, me.x, me.y, ball, dt, sec, gaze)
    }
    for (const o of opponents) {
      const me = opp[o.id]
      let gaze = ball
      if (o.position === 'DF' || o.position === 'MF') {
        let near = null
        for (const p of players) {
          const hp = home[p.id]
          const d = Math.hypot(hp.x - me.x, hp.y - me.y)
          if (d < K.PLAY.GAZE_MARK_R && (!near || d < near.d)) near = { d, hp }
        }
        if (near) gaze = near.hp
      }
      me.a = updateFace(o.id, me.x, me.y, ball, dt, sec, gaze)
    }
    let caption = null
    for (const c of captions) if (el >= c.t) caption = c.text

    // 볼 트레일: 공이 빠르게 나는 동안(패스·슛)만 최근 궤적을 혜성 꼬리로 남긴다
    const lastT = trail[trail.length - 1]
    const ballV = lastT && dt > 0.001 ? Math.hypot(ball.x - lastT.x, ball.y - lastT.y) / dt : 0
    if (!lastT || ballV > 13) trail.push({ x: ball.x, y: ball.y, height: ball.height ?? 0, t: el })
    else if (ballV < 8) trail.length = 0 // 공이 느려지면 꼬리 소멸
    while (trail.length && el - trail[0].t > 380) trail.shift()

    // 화면 효과: 셰이크(슛 킥·골·차단 순간, 감쇠 진동) + 골 플래시 + 슬로모션 플래그
    let shake = 0
    const shakeFrom = (t, amp, durMs) => {
      if (t != null && el >= t && el < t + durMs) shake = Math.max(shake, amp * (1 - (el - t) / durMs))
    }
    shakeFrom(shotLeg?.start, 0.35, 260)
    shakeFrom(goalTime, 1, 700)
    shakeFrom(turnoverTime, 0.55, 420)
    const fx = {
      dx: shake * 5 * Math.sin(el * 0.09),
      dy: shake * 4 * Math.cos(el * 0.117),
      flash: goalTime != null && el >= goalTime && el < goalTime + 260 ? 1 - (el - goalTime) / 260 : 0,
      slowmo,
      // 오프사이드 깃발: 휘슬 순간부터 재생이 끝날 때까지 표시 (라인도 함께 그린다)
      offside: offsideTime != null && el >= offsideTime,
      offsideLineX,
    }
    onFrame({ home, opp, ball, caption, fx, ballTrail: trail.length > 1 ? [...trail] : null, elapsed: el })
    if (el < total) rafId = requestAnimationFrame(tick)
    else onDone()
  }
  rafId = requestAnimationFrame(tick)

  return { cancel: () => cancelAnimationFrame(rafId) }
}
