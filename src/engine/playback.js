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
import { K } from './constants.js'

const clamp = (v, min, max) => Math.min(max, Math.max(min, v))
// 이동/공 속도 (피치 단위 ≈ m/s) — 판정의 수비 이동 예산(resolve.js)과 공유
const SPEED = K.SPEED
const durFor = (len, v) => clamp((len / v) * 1000, 400, 6000)
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
    const pts = samplePath(a.from, ctrl, to)
    const len = pathLength(pts)
    const dur = durFor(len, SPEED[a.type] ?? SPEED.pass)
    const prev = legs[legs.length - 1]
    legs.push({ ...a, step, pts, len, start: prev ? prev.start + prev.dur + 200 : 300, dur })
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
  const runPlan = runLegs
    .filter((rl) => !(failIndex !== -1 && rl.afterIndex > failIndex))
    .map((rl) => {
      const pts = samplePath(rl.from, rl.ctrl, rl.to)
      // 런 도착 위치를 실제로 쓰는 첫 레그 = 마감시간의 주인 (없으면 장식 런)
      const consumer = legs.find(
        (leg) => leg.index >= rl.afterIndex && (leg.receiverId === rl.id || leg.actorId === rl.id),
      )
      return { rl, pts, len: pathLength(pts), dur: durFor(pathLength(pts), SPEED.run), consumer }
    })
    // 마감이 이른 런부터 처리 — 지연이 생기면 뒤 레그들의 마감에 순서대로 전파되도록
    .sort((a, b) => (a.consumer?.index ?? Infinity) - (b.consumer?.index ?? Infinity))
  for (const rp of runPlan) {
    const earliest = Math.max(200, freeAfter(rp.rl.id, rp.rl.afterIndex))
    let start
    if (rp.consumer) {
      // 수신 런은 공 도착 시각, 그 자리에서 시작하는 액션(드리블 등)은 액션 시작 시각이 마감
      const deadline = rp.consumer.receiverId === rp.rl.id ? rp.consumer.start + rp.consumer.dur : rp.consumer.start
      start = Math.max(earliest, deadline - rp.dur)
      const late = start + rp.dur - deadline
      if (late > 0) for (const leg of legs) if (leg.index >= rp.consumer.index) leg.start += late
    } else {
      // 아무도 기다리지 않는 장식 런 — 앵커 액션 시작에 맞춰 출발
      const anchorLeg = legs.find((leg) => leg.index === rp.rl.afterIndex)
      const tail = legs[legs.length - 1]
      start = Math.max(earliest, (anchorLeg ? anchorLeg.start : tail ? tail.start + tail.dur : 300) - 120)
    }
    segs.push({ id: rp.rl.id, pts: rp.pts, len: rp.len, start, dur: rp.dur })
  }
  const endLeg = legs[legs.length - 1]
  const chainEnd = endLeg ? endLeg.start + endLeg.dur + 200 : 500
  for (const leg of legs) {
    if (leg.type !== 'dribble') continue
    const capFrac = leg.step.success === false && leg.step.interceptFrac != null ? leg.step.interceptFrac : 1
    segs.push({ id: leg.actorId, pts: leg.pts, len: leg.len, start: leg.start, dur: leg.dur, capFrac })
  }
  // 시작 시각 오름차순 정렬 → 나중에 시작한 세그먼트가 위치를 덮어써서
  // "런으로 이동 → 거기서 받아 드리블" 같은 연속 동작이 자연스럽게 이어진다.
  segs.sort((a, b) => a.start - b.start)

  // 재생 총 시간은 공 체인이 아니라 "모든 선수 이동이 끝나는 시점" 기준 —
  // 늦게 출발하는 런도 끝까지 뛰고 나서 재생이 멈춘다
  let total = Math.max(chainEnd + 700, ...segs.map((s) => s.start + s.dur + 500))

  // ── 살아있는 움직임: 매 프레임 볼-추종 스티어링 시뮬레이션 ──
  // 지시(스크립트)가 없는 순간의 모든 선수는 "공 위치에 반응하는 목표점"을 향해
  // 가속/감속하는 조향 모델로 움직인다. 라인 업다운·압박·마킹·이벤트 리액션 포함.
  // 노이즈는 시드 고정이라 리플레이 감각도 유지된다.
  const sim = {}
  for (const p of [...players, ...opponents]) sim[p.id] = { x: p.x, y: p.y, vx: 0, vy: 0 }

  // 선수별 "약속" 이벤트: t 시점까지 point 근처에 있어야 한다 — 스크립트 출발점,
  // 스크립트 종점, 패스 받을 지점. 마지막 약속이 지나면 자유(팀 셰이프) 상태.
  const events = {}
  const addEvent = (id, tm, point) => (events[id] ??= []).push({ t: tm, point })
  for (const s of segs) {
    addEvent(s.id, s.start, s.pts[0])
    addEvent(s.id, s.start + s.dur, pointAtLength(s.pts, (s.capFrac ?? 1) * s.len))
  }
  for (const leg of legs) {
    if (leg.type === 'pass' && leg.receiverId) addEvent(leg.receiverId, leg.start + leg.dur, leg.to)
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
      const when = leg.start + leg.dur * (leg.step.interceptFrac ?? 1) + 100
      captions.push({ t: when, text: commentaryFor(FAIL_EVENT[leg.type][names.d ? 'cut' : 'miss'], names, rngC) })
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

  // 바라보는 방향 (라디안) — 움직이면 진행 방향, 서 있으면 공 방향. 급회전 방지용 각도 lerp.
  const facePrev = {}
  const faceAng = {}
  const updateFace = (id, x, y, ball, dt) => {
    const prev = facePrev[id]
    facePrev[id] = { x, y }
    let target
    if (prev && Math.hypot(x - prev.x, y - prev.y) > 0.03) {
      target = Math.atan2(y - prev.y, x - prev.x)
    } else if (ball) {
      target = Math.atan2(ball.y - y, ball.x - x)
    } else {
      return faceAng[id] ?? 0
    }
    let cur = faceAng[id] ?? target
    let d = target - cur
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    cur += d * Math.min(1, dt * 9)
    faceAng[id] = cur
    return cur
  }

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

    // 1) 스크립트 구간: 지시 경로가 시뮬 상태를 덮어쓴다 (끝나면 시뮬이 이어받음)
    const scripted = new Set()
    for (const s of segs) {
      if (el < s.start) continue
      if (el <= s.start + s.dur) {
        const k = Math.min(ease((el - s.start) / s.dur), s.capFrac ?? 1)
        const pos = pointAtLength(s.pts, k * s.len)
        scripted.add(s.id)
        Object.assign(sim[s.id], { x: pos.x, y: pos.y, vx: 0, vy: 0 })
      } else if (!s.done) {
        s.done = true
        const pos = pointAtLength(s.pts, (s.capFrac ?? 1) * s.len)
        Object.assign(sim[s.id], { x: pos.x, y: pos.y, vx: 0, vy: 0 })
      }
    }
    if (interceptor) {
      if (el <= interceptor.end) {
        const k = ease((el - interceptor.start) / (interceptor.end - interceptor.start))
        scripted.add(interceptor.id)
        Object.assign(sim[interceptor.id], {
          x: interceptor.from.x + (interceptor.to.x - interceptor.from.x) * k,
          y: interceptor.from.y + (interceptor.to.y - interceptor.from.y) * k,
          vx: 0,
          vy: 0,
        })
      } else if (!interceptor.done) {
        interceptor.done = true
        Object.assign(sim[interceptor.id], { x: interceptor.to.x, y: interceptor.to.y, vx: 0, vy: 0 })
      }
    }

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
          ball = pointAtLength(leg.pts, Math.min(k, capFrac) * leg.len)
        } else if (leg.step.success && leg.type === 'pass') {
          ownerId = leg.receiverId
        } else {
          ownerId = null // 슛(골/빗나감) 또는 실패한 패스 — 공은 궤적 끝에
          ball = pointAtLength(leg.pts, capFrac * leg.len)
        }
      }
      if (ownerId) ball = { ...getPos(ownerId) }
      if (interceptor && el > interceptor.end) ball = { ...getPos(interceptor.id) }
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
    const adv = ballSteer.x - 60 // 하프라인 기준 공의 전진량 (상대 라인다운용)
    // 아군 라인업은 "이번 공격 시작점 대비" 전진량 — 자기 진영에서 시작해도 후퇴하지 않고
    // 공격 방향(오른쪽)으로만 밀고 올라간다
    const advHome = Math.max(0, ballSteer.x - ball0x)

    // 템포: 공 속도 EMA — 공이 빠르게 움직이는 국면(역습·긴 패스)엔 오프볼 전원이 급해진다.
    // 실제 축구에서 볼 템포와 오프볼 스프린트 강도가 함께 오르는 것의 근사.
    const ballSpd = prevBall && dt > 0.001 ? Math.hypot(ballSteer.x - prevBall.x, ballSteer.y - prevBall.y) / dt : 0
    prevBall = ballSteer
    tempo += (clamp(ballSpd / 14, 0, 1) - tempo) * Math.min(1, dt * 3)
    const urgency = 1 + 0.9 * tempo // 오프볼 속도 배율 1.0 ~ 1.9

    // 판정 엔진(resolve.js)이 액션마다 계산해둔 수비 좌표 — 진행 중인 레그의 목표 좌표.
    // 100% 강제가 아니라 조향 목표로만 쓴다(압박·노이즈가 위에 얹힘) — 보는 경험 우선.
    let defWaypoint = null
    for (const leg of legs) if (el >= leg.start) defWaypoint = leg.step.defPos ?? defWaypoint

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
    const supporters = new Set()
    if (mode === 'live') {
      players
        .filter((p) => !scripted.has(p.id))
        .map((p) => {
          const d = Math.hypot(sim[p.id].x - ballSteer.x, sim[p.id].y - ballSteer.y)
          return { id: p.id, d: supPrev.has(p.id) ? d - 4 : d }
        })
        .filter((c) => c.d > 3 && c.d < 45) // 공 소유자(발밑)와 너무 먼 선수는 제외
        .sort((a, b) => a.d - b.d)
        .slice(0, 3)
        .forEach((c) => supporters.add(c.id))
    }
    supPrev = supporters

    // 조향 적분: 목표를 향해 가속하되 가속 한계·도착 감속으로 무게감을 준다
    const integrate = (id, rawTarget, maxSpeed) => {
      const s = sim[id]
      const nz = noise(id, sec)
      const tx = clamp(rawTarget.x + nz.x, 1.5, 118.5)
      const ty = clamp(rawTarget.y + nz.y, 1.5, 78.5)
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
    const lastPast = (id) => {
      let pt = null
      for (const e of events[id] ?? []) if (e.t <= el) pt = e.point
      return pt
    }
    const nextPending = (id) => (events[id] ?? []).find((e) => e.t > el)

    // 3) 아군 자유 선수: 약속 장소 대기 → 팀 셰이프(라인 업다운) / 세리머니 / 복귀
    for (const p of players) {
      if (scripted.has(p.id)) continue
      const pending = nextPending(p.id)
      let target = null
      let spd = 4.5
      if (pending) {
        // 약속 장소(런 출발점·패스 수신점)에 미리 가서 못 박혀 있지 않는다 —
        // 이동 소요시간이 임박할 때까지는 아래 일반 무빙을 계속하다가 그때 출발
        const s = sim[p.id]
        const need = (Math.hypot(pending.point.x - s.x, pending.point.y - s.y) / 5.5) * 1000
        if (pending.t - el <= need + 500) {
          target = pending.point
          spd = 6.5
        }
      }
      if (!target) {
        if (mode === 'goal') {
          const sc = sim[scorerId]
          target = p.id === scorerId ? { x: sim[p.id].x, y: sim[p.id].y } : { x: sc.x + ringOf[p.id].x, y: sc.y + ringOf[p.id].y }
          spd = 6
        } else if (mode === 'turnover' || mode === 'reset') {
          target = { x: p.x, y: p.y } // 대형 복귀
          spd = 3.2
        } else if (supporters.has(p.id)) {
          // 지원 런: 공의 앞(골 쪽), 자기 쪽 사이드로 벌려 침투 — 패스 받을 공간 만들기
          const side = sim[p.id].y >= ballSteer.y ? 1 : -1
          target = { x: Math.min(ballSteer.x + 10, 113), y: clamp(ballSteer.y + side * 10, 4, 76) }
          spd = 7.5 * urgency
        } else {
          const anchor = lastPast(p.id) ?? { x: p.x, y: p.y }
          const k = ROW_K_HOME[p.position] ?? 0.5
          target = { x: anchor.x + k * advHome, y: anchor.y + 0.25 * (ballSteer.y - anchor.y) }
          spd = 5.5 * urgency // 템포가 오르면 라인 전체가 급해진다
        }
      }
      integrate(p.id, target, spd)
    }
    // 4) 상대 자유 선수: 라인 다운·볼사이드 시프트 / 압박 / 마킹 / 리액션
    for (const o of opponents) {
      if (scripted.has(o.id)) continue
      let target
      let spd = 4.2
      if (mode === 'goal') {
        target = { x: o.x + 2, y: o.y } // 낙담 — 느릿하게 제자리 쪽
        spd = 1.6
      } else if (mode === 'turnover') {
        const s = sim[o.id]
        target = { x: s.x + (ballSteer.x - s.x) * 0.35, y: s.y + (ballSteer.y - s.y) * 0.35 } // 공수 전환: 볼 지원
        spd = 3.8
      } else if (mode === 'reset') {
        target = { x: o.x, y: o.y }
        spd = 2.5
      } else if (shotLeg && o.position === 'GK' && el >= shotLeg.start && el <= shotLeg.start + shotLeg.dur + 450) {
        // GK 다이브: 슛 궤적이 골라인에 닿을 지점으로 몸을 던진다 (순수 연출 — 판정 무관)
        target = { x: 117.6, y: clamp(shotLeg.to.y, 35, 45) }
        spd = 11
      } else if (pressers.has(o.id)) {
        const gx = 120 - ballSteer.x
        const gy = 40 - ballSteer.y
        const gl = Math.hypot(gx, gy) || 1
        target = { x: ballSteer.x + (gx / gl) * 2.2, y: ballSteer.y + (gy / gl) * 2.2 } // 공-골문 사이 압박 지점
        spd = 7 * (1 + 0.3 * tempo)
      } else if (defWaypoint?.[o.id]) {
        const wp = defWaypoint[o.id]
        const dwp = Math.hypot(sim[o.id].x - wp.x, sim[o.id].y - wp.y)
        if (dwp > 1.6) {
          // 판정과 같은 수비 이동: 엔진이 계산한 좌표로 급히 복귀 (템포 반영)
          target = wp
          spd = 6.5 * (1 + 0.4 * tempo)
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
          spd = 5.5 * urgency
        }
      } else {
        const k = ROW_K_OPP[o.position] ?? 0.4
        target = { x: o.x + k * Math.max(0, adv), y: o.y + 0.3 * (ballSteer.y - 40) }
        spd = 5 * urgency
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

    // 5) 렌더 좌표(+바라보는 방향) + 공 + 자막
    const home = {}
    const opp = {}
    for (const p of players) home[p.id] = { x: sim[p.id].x, y: sim[p.id].y }
    for (const o of opponents) opp[o.id] = { x: sim[o.id].x, y: sim[o.id].y }
    const ball = ballAt((id) => home[id] ?? opp[id] ?? basePos(id))
    for (const p of players) home[p.id].a = updateFace(p.id, home[p.id].x, home[p.id].y, ball, dt)
    for (const o of opponents) opp[o.id].a = updateFace(o.id, opp[o.id].x, opp[o.id].y, ball, dt)
    let caption = null
    for (const c of captions) if (el >= c.t) caption = c.text

    // 볼 트레일: 공이 빠르게 나는 동안(패스·슛)만 최근 궤적을 혜성 꼬리로 남긴다
    const lastT = trail[trail.length - 1]
    const ballV = lastT && dt > 0.001 ? Math.hypot(ball.x - lastT.x, ball.y - lastT.y) / dt : 0
    if (!lastT || ballV > 13) trail.push({ x: ball.x, y: ball.y, t: el })
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
    onFrame({ home, opp, ball, caption, fx, ballTrail: trail.length > 1 ? [...trail] : null })
    if (el < total) rafId = requestAnimationFrame(tick)
    else onDone()
  }
  rafId = requestAnimationFrame(tick)

  return { cancel: () => cancelAnimationFrame(rafId) }
}
