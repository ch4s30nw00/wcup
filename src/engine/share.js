// engine/share.js — 전술을 URL에 담는 인코더/디코더.
//
// 왜 필요한가: 결과는 "시드 + 전술"로 결정되는데 URL이 시드만 담으면
// 링크를 받은 사람은 같은 시드의 빈 보드를 볼 뿐 내가 짠 전술을 못 본다.
// 체인·오프볼 런까지 담아야 "내가 짠 이 역습 봐라"가 성립한다.
//
//   encodeShare({ seed, chainActs, runs, playerIds }) → "1.12345.<acts>.<runs>" 형태의 문자열
//   decodeShare(str, { playerIds })                   → { seed, chainActs, runs } | null
//
// 설계 원칙
//   - 순수 함수. 실패하면 예외 대신 null (링크가 깨져도 앱은 빈 보드로 뜬다).
//   - 선수는 id 문자열 대신 **로스터 인덱스**로 — 'kor_07'(6자) → '9'(1자).
//     playerIds는 인코딩·디코딩 양쪽에서 같은 배열이어야 한다(온필드 명단 순서).
//   - 좌표는 0.1m 단위 정수. 120×80 피치에서 0.1m는 화면 1픽셀 미만이라 무손실과 같다.
//   - ctrl(곡률 제어점)이 기본값(직선)이면 아예 생략 — 대부분의 액션이 직선이라 URL이 짧아진다.
//   - 맨 앞 버전 번호(V)로 포맷을 바꿔도 옛 링크를 구분해 거를 수 있다.
//
// 포맷 (구분자 . ~ _ 는 전부 URL에서 이스케이프되지 않는 문자라 %XX 오염이 없다)
//   V . seed . act~act~act . run~run
//     dribble : d_x_y[_cx_cy]
//     pass    : p_수신자인덱스[_cx_cy]
//     shot    : s_x_y[_cx_cy]
//     run     : 선수인덱스_x_y_afterIndex[_cx_cy]

const V = '2'
const LEGACY_V = '1'
const enc = (n) => Math.round(n * 10) // 0.1m 단위 정수
const dec = (s) => Number(s) / 10
const isNum = (v) => Number.isFinite(v)

// ctrl 생략 규칙: null이면 앱이 직선(중점)으로 채우므로 인코딩할 게 없다.
const ctrlPart = (ctrl) => (ctrl ? `_${enc(ctrl.x)}_${enc(ctrl.y)}` : '')

export function encodeShare({ seed, chainActs = [], runs = [], playerIds = [] }) {
  const idx = new Map(playerIds.map((id, i) => [id, i]))
  const acts = chainActs
    .map((a) => {
      if (a.type === 'dribble') return `d_${enc(a.to.x)}_${enc(a.to.y)}${ctrlPart(a.ctrl)}`
      if (a.type === 'shot') return `s_${enc(a.to.x)}_${enc(a.to.y)}${ctrlPart(a.ctrl)}`
      const ri = idx.get(a.receiverId)
      if (ri == null) return null
      const code = { lob: 'l', through: 't', lobThrough: 'u' }[a.passKind ?? (a.through ? 'through' : 'ground')] ?? 'p'
      return `${code}_${ri}${ctrlPart(a.ctrl)}`
    })
    .filter(Boolean)
  const rs = runs
    .map((r) => {
      const pi = idx.get(r.id)
      return pi == null ? null : `${pi}_${enc(r.to.x)}_${enc(r.to.y)}_${r.afterIndex}${ctrlPart(r.ctrl)}`
    })
    .filter(Boolean)
  return [V, seed, acts.join('~'), rs.join('~')].join('.')
}

export function decodeShare(str, { playerIds = [] } = {}) {
  if (typeof str !== 'string' || !str) return null
  const [v, seedStr, actStr = '', runStr = ''] = str.split('.')
  if (v !== V && v !== LEGACY_V) return null
  const seed = Number(seedStr)
  if (!Number.isFinite(seed) || seed <= 0) return null

  const chainActs = []
  for (const tok of actStr ? actStr.split('~') : []) {
    const [kind, ...rest] = tok.split('_')
    const n = rest.map(Number)
    if (kind === 'd' || kind === 's') {
      if (!isNum(n[0]) || !isNum(n[1])) return null
      const ctrl = isNum(n[2]) && isNum(n[3]) ? { x: dec(n[2]), y: dec(n[3]) } : null
      const to = { x: dec(n[0]), y: dec(n[1]) }
      // 슛은 receiverId가 'GOAL' — App의 addPass가 만드는 모양과 같아야 한다
      chainActs.push(kind === 'd' ? { type: 'dribble', to, ctrl } : { type: 'shot', receiverId: 'GOAL', to, ctrl })
    } else if (kind === 'p' || kind === 'l' || kind === 't' || kind === 'u') {
      const receiverId = playerIds[n[0]]
      if (!receiverId) return null
      const ctrl = isNum(n[1]) && isNum(n[2]) ? { x: dec(n[1]), y: dec(n[2]) } : null
      // 패스의 도착점은 수신자의 (체인 진행 후) 위치라 App이 유도한다 — to는 담지 않는다
      const passKind = { p: 'ground', l: 'lob', t: 'through', u: 'lobThrough' }[kind]
      chainActs.push({ type: 'pass', receiverId, to: null, ctrl, passKind, ...(passKind === 'through' || passKind === 'lobThrough' ? { through: true } : {}) })
    } else return null
  }

  const runs = []
  for (const tok of runStr ? runStr.split('~') : []) {
    const n = tok.split('_').map(Number)
    const id = playerIds[n[0]]
    if (!id || !isNum(n[1]) || !isNum(n[2]) || !isNum(n[3])) return null
    const ctrl = isNum(n[4]) && isNum(n[5]) ? { x: dec(n[4]), y: dec(n[5]) } : null
    runs.push({ id, to: { x: dec(n[1]), y: dec(n[2]) }, ctrl, afterIndex: n[3] })
  }

  return { seed, chainActs, runs }
}

// 현재 페이지 URL에 전술을 얹은 공유 링크. origin+pathname만 쓰므로 기존 쿼리는 버린다.
// 선수는 온필드 명단 인덱스로 담기는데 그 명단은 경기마다 다르므로 경기 id도 함께 실어야
// 받는 쪽이 같은 명단으로 디코딩한다 (matchId 없으면 옛 형식 그대로 — 기본 경기로 해석된다).
export function shareUrl({ seed, chainActs, runs, playerIds, matchId, origin, pathname }) {
  const p = encodeShare({ seed, chainActs, runs, playerIds })
  const m = matchId ? `&m=${encodeURIComponent(matchId)}` : ''
  return `${origin}${pathname}?p=${p}${m}`
}
