// engine/commentary.js — 재생 자막(중계 멘트) 템플릿.
// 이벤트 종류별 멘트 풀에서 시드 rng로 하나를 뽑아 선수 이름을 끼워넣는다.
// 멘트를 늘리고 싶으면 POOL에 함수를 추가하면 끝.

// 마지막 글자 받침 유무 (한글이 아니면 받침 없음 취급)
const hasBatchim = (word) => {
  const ch = word.charCodeAt(word.length - 1)
  return ch >= 0xac00 && ch <= 0xd7a3 && (ch - 0xac00) % 28 !== 0
}
const josa = (w, withB, withoutB) => w + (hasBatchim(w) ? withB : withoutB)
const ga = (w) => josa(w, '이', '가') // 손흥민이 / 페페가
const eul = (w) => josa(w, '을', '를')
const ui = (w) => w + '의'

// UI에서도 같은 조사 규칙을 쓰도록 공개 — 이름마다 받침이 달라서 "황희찬가"처럼 새기 쉽다
export const josaGa = ga // 이/가
export const josaEun = (w) => josa(w, '은', '는')

// names: { a: 액션 주체, b: 패스 수신자, d: 차단한 수비수 }
const POOL = {
  dribble: [
    ({ a }) => `${ga(a)} 공을 몰고 전진합니다!`,
    ({ a }) => `${a}, 과감하게 치고 나갑니다!`,
    ({ a }) => `${ui(a)} 드리블 돌파! 수비가 따라붙습니다!`,
  ],
  pass: [
    ({ a, b }) => `${ga(a)} ${b}에게 연결합니다!`,
    ({ a, b }) => `${ui(a)} 패스 — ${ga(b)} 받으러 갑니다!`,
    ({ a, b }) => `${a}, ${eul(b)} 향해 찔러줍니다!`,
    ({ a, b }) => `${ga(a)} 공간을 봤습니다! ${b} 쪽으로!`,
  ],
  shot: [
    ({ a }) => `${a}, 때립니다!!`,
    ({ a }) => `${ui(a)} 슈팅!!`,
    ({ a }) => `${a}, 주저 없이 발을 휘두릅니다!!`,
  ],
  goal: [
    ({ a }) => `골!! 골!! 골!! ${ui(a)} 득점입니다!!`,
    ({ a }) => `들어갔습니다!! ${ui(a)} 극적인 골!!`,
    ({ a }) => `골망이 흔들립니다!! ${a}!! 대한민국이 앞서갑니다!!`,
  ],
  shotMiss: [
    ({ a }) => `아... ${ui(a)} 슛, 골문을 살짝 빗나갑니다.`,
    ({ a }) => `${ui(a)} 슛! 아쉽게 골대 밖으로 벗어납니다.`,
    ({ a }) => `골문 위로... ${ga(a)} 하늘을 봅니다.`,
  ],
  shotBlocked: [
    ({ a, d }) => `${ga(d)} ${ui(a)} 슛을 몸으로 막아냅니다!`,
    ({ a, d }) => `${ui(a)} 슛 — ${ui(d)} 블록에 걸립니다!`,
    ({ d }) => `${ga(d)} 몸을 던졌습니다! 슛이 막힙니다!`,
  ],
  passCut: [
    ({ a, d }) => `아! ${ga(d)} ${ui(a)} 패스를 끊어냅니다!`,
    ({ d }) => `${ga(d)} 정확히 읽고 가로챕니다!`,
    ({ a, d }) => `${ui(a)} 패스가 ${ui(d)} 발에 걸립니다!`,
  ],
  passMiss: [
    ({ a }) => `${ui(a)} 패스가 흐릅니다... 아무도 닿지 못합니다.`,
    () => `패스 미스! 공이 그대로 빠져나갑니다.`,
  ],
  dribbleStopped: [
    ({ a, d }) => `${ga(d)} ${ui(a)} 돌파를 저지합니다!`,
    ({ a, d }) => `${a}, ${ui(d)} 태클에 막힙니다!`,
    ({ d }) => `${ga(d)} 어깨싸움에서 이겨냅니다!`,
  ],
  dribbleMiss: [
    ({ a }) => `${a}, 볼 컨트롤이 길어집니다... 놓칩니다.`,
    ({ a }) => `${ui(a)} 드리블이 발에서 멀어집니다.`,
  ],
  offside: [
    ({ b }) => `깃발이 올라갑니다! ${ga(b)} 오프사이드입니다!`,
    ({ b }) => `삐——! 오프사이드! ${ga(b)} 라인을 먼저 넘었습니다.`,
    ({ a, b }) => `${ui(a)} 패스는 좋았지만... ${ga(b)} 반 발 앞서 있었습니다. 오프사이드!`,
  ],
  advance: [
    () => `좋은 전개! 공을 지켜냅니다.`,
    () => `침착한 볼 소유 — 다음 기회를 노립니다.`,
  ],
}

export function commentaryFor(event, names, rng) {
  const pool = POOL[event]
  if (!pool?.length) return ''
  return pool[Math.floor(rng() * pool.length)](names)
}
