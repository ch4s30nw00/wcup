// engine/sound.js — WebAudio 프로시저럴 사운드 (에셋 파일 없음).
//
// 저작권 문제로 샘플 파일을 일절 쓰지 않는다. 모든 소리를 오실레이터와
// 화이트노이즈 버퍼로 그 자리에서 합성한다 — 저장소에 바이너리가 늘지 않고,
// 라이선스 추적이 필요 없다는 게 이 방식의 진짜 이득이다.
//
//   whistle()  — 부심 휘슬 (오프사이드·반칙). 페아(pea) 휘슬의 떨림을 LFO로 흉내
//   goalRoar() — 골 함성. 노이즈 스웰 + 저역 함성 + 박수 트랜지언트
//   murmur()   — 관중 웅성거림 (앰비언트 루프)
//   setMuted() / isMuted() — 음소거 토글 (localStorage에 저장)
//
// AudioContext는 사용자 제스처 이후에만 만들 수 있으므로 지연 생성한다.
// 브라우저가 WebAudio를 안 주면 전부 조용히 no-op — 소리 때문에 게임이 죽지 않는다.

const STORE_KEY = 'touchline.muted'

let ctx = null
let master = null
let murmurNode = null

let muted = (() => {
  try {
    return localStorage.getItem(STORE_KEY) === '1'
  } catch {
    return false
  }
})()

export function isMuted() {
  return muted
}

export function setMuted(v) {
  muted = !!v
  try {
    localStorage.setItem(STORE_KEY, muted ? '1' : '0')
  } catch {
    /* 프라이빗 모드 등 — 저장 실패해도 이번 세션 동안은 동작한다 */
  }
  if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.02)
  if (muted) stopMurmur()
  return muted
}

// 지연 초기화 — 첫 소리 요청(=사용자 제스처 이후) 때 컨텍스트를 만든다
function audio() {
  if (ctx) return ctx
  const AC = window.AudioContext ?? window.webkitAudioContext
  if (!AC) return null
  try {
    ctx = new AC()
    master = ctx.createGain()
    master.gain.value = muted ? 0 : 1
    master.connect(ctx.destination)
  } catch {
    ctx = null
  }
  return ctx
}

// 자동재생 정책으로 suspended 상태면 깨운다 (제스처 핸들러 안에서 호출되어야 함)
export function resumeAudio() {
  const c = audio()
  if (c && c.state === 'suspended') c.resume().catch(() => {})
}

// 화이트노이즈 버퍼 — 함성·박수·휘슬 숨소리의 공통 재료. 한 번 만들어 재사용.
let noiseBuf = null
function noise(c) {
  if (noiseBuf) return noiseBuf
  const len = c.sampleRate * 2
  noiseBuf = c.createBuffer(1, len, c.sampleRate)
  const d = noiseBuf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  return noiseBuf
}

function noiseSource(c, { loop = false } = {}) {
  const s = c.createBufferSource()
  s.buffer = noise(c)
  s.loop = loop
  return s
}

// ── 휘슬 ────────────────────────────────────────────────────────────
// 페아 휘슬 = 기본음 + 그 위의 불협 배음 + 공 굴러가며 만드는 빠른 떨림(LFO).
// 사각파 하나로는 "삐" 소리가 너무 깨끗해서 심판 휘슬로 안 들린다.
export function whistle({ duration = 0.55, freq = 2550 } = {}) {
  const c = audio()
  if (!c || muted) return
  const t0 = c.currentTime
  const g = c.createGain()
  g.connect(master)
  // 짧게 치고 빠지는 엔벨로프
  g.gain.setValueAtTime(0, t0)
  g.gain.linearRampToValueAtTime(0.28, t0 + 0.02)
  g.gain.setValueAtTime(0.26, t0 + duration - 0.12)
  g.gain.exponentialRampToValueAtTime(0.0005, t0 + duration)

  // 떨림 LFO — 페아 휘슬 특유의 트릴
  const lfo = c.createOscillator()
  const lfoGain = c.createGain()
  lfo.frequency.value = 42
  lfoGain.gain.value = 130
  lfo.connect(lfoGain)

  for (const [mult, level] of [[1, 0.6], [1.5, 0.25], [2.02, 0.15]]) {
    const o = c.createOscillator()
    o.type = 'sine'
    o.frequency.value = freq * mult
    lfoGain.connect(o.frequency)
    const og = c.createGain()
    og.gain.value = level
    o.connect(og).connect(g)
    o.start(t0)
    o.stop(t0 + duration)
  }

  // 숨소리 — 밴드패스한 노이즈를 아주 약하게 섞으면 "입으로 부는" 질감이 산다
  const n = noiseSource(c)
  const bp = c.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = freq
  bp.Q.value = 6
  const ng = c.createGain()
  ng.gain.value = 0.08
  n.connect(bp).connect(ng).connect(g)
  n.start(t0)
  n.stop(t0 + duration)

  lfo.start(t0)
  lfo.stop(t0 + duration)
}

// ── 골 함성 ─────────────────────────────────────────────────────────
// 관중 함성 = 노이즈가 확 부풀었다 천천히 꺼지는 스웰 + 저역 "우와" + 박수 알갱이.
export function goalRoar({ duration = 2.6 } = {}) {
  const c = audio()
  if (!c || muted) return
  const t0 = c.currentTime

  // 스웰 — 로우패스를 열었다 닫으며 "와아아" 를 만든다
  const n = noiseSource(c)
  const lp = c.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.setValueAtTime(400, t0)
  lp.frequency.linearRampToValueAtTime(2600, t0 + 0.5)
  lp.frequency.linearRampToValueAtTime(700, t0 + duration)
  lp.Q.value = 0.7
  const g = c.createGain()
  g.gain.setValueAtTime(0, t0)
  g.gain.linearRampToValueAtTime(0.32, t0 + 0.35)
  g.gain.setValueAtTime(0.3, t0 + duration * 0.5)
  g.gain.exponentialRampToValueAtTime(0.001, t0 + duration)
  n.connect(lp).connect(g).connect(master)
  n.start(t0)
  n.stop(t0 + duration)

  // 저역 몸통 — 함성의 "무게". 살짝 흔들리는 피치가 사람 목소리 무리처럼 들리게 한다
  const o = c.createOscillator()
  o.type = 'sawtooth'
  o.frequency.setValueAtTime(90, t0)
  o.frequency.linearRampToValueAtTime(140, t0 + 0.6)
  o.frequency.linearRampToValueAtTime(105, t0 + duration)
  const olp = c.createBiquadFilter()
  olp.type = 'lowpass'
  olp.frequency.value = 320
  const og = c.createGain()
  og.gain.setValueAtTime(0, t0)
  og.gain.linearRampToValueAtTime(0.12, t0 + 0.4)
  og.gain.exponentialRampToValueAtTime(0.001, t0 + duration * 0.85)
  o.connect(olp).connect(og).connect(master)
  o.start(t0)
  o.stop(t0 + duration)

  // 박수 — 짧은 노이즈 버스트를 불규칙하게 흩뿌린다
  for (let i = 0; i < 22; i++) {
    const t = t0 + 0.25 + Math.random() * (duration * 0.6)
    const cn = noiseSource(c)
    const hp = c.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 1600
    const cg = c.createGain()
    cg.gain.setValueAtTime(0.05 + Math.random() * 0.05, t)
    cg.gain.exponentialRampToValueAtTime(0.0005, t + 0.06)
    cn.connect(hp).connect(cg).connect(master)
    cn.start(t)
    cn.stop(t + 0.07)
  }
}

// ── 관중 웅성거림 (앰비언트 루프) ───────────────────────────────────
// 로우패스한 노이즈에 아주 느린 게인 흔들림 — 계속 틀어놔도 거슬리지 않는 수준으로.
export function startMurmur({ level = 0.045 } = {}) {
  const c = audio()
  if (!c || muted || murmurNode) return
  const t0 = c.currentTime
  const n = noiseSource(c, { loop: true })
  const lp = c.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 900
  const g = c.createGain()
  g.gain.setValueAtTime(0, t0)
  g.gain.linearRampToValueAtTime(level, t0 + 1.2)

  // 아주 느린 LFO로 "웅성거림"의 밀물썰물
  const lfo = c.createOscillator()
  lfo.frequency.value = 0.13
  const lfoGain = c.createGain()
  lfoGain.gain.value = level * 0.45
  lfo.connect(lfoGain).connect(g.gain)

  n.connect(lp).connect(g).connect(master)
  n.start(t0)
  lfo.start(t0)
  murmurNode = { n, lfo, g }
}

export function stopMurmur() {
  if (!murmurNode || !ctx) return
  const { n, lfo, g } = murmurNode
  murmurNode = null
  const t = ctx.currentTime
  try {
    g.gain.cancelScheduledValues(t)
    g.gain.setTargetAtTime(0, t, 0.25)
    n.stop(t + 1.2)
    lfo.stop(t + 1.2)
  } catch {
    /* 이미 정지됨 */
  }
}
