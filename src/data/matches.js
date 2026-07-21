// 플레이 가능한 경기 레지스트리.
//
// 왜 있는가: 예전엔 App이 scenarios.json 하나를 모듈 최상단에서 직접 펼쳐 썼다.
// 경기가 둘 이상이 되면서 "시나리오 → 온필드 명단·좌표"를 만드는 그 로직을
// 여기로 옮겼다. App은 선택된 경기 id로 buildMatch를 부르기만 한다.
import playersData from './players.json'
import formations from './formations.json'
import korPor from './scenarios.json'
import argEng from './scene-eng-arg.json'

const slots = formations['4-2-3-1']

// 순서 = 경기 선택 화면의 카드 순서
export const MATCHES = [korPor, argEng]
export const DEFAULT_MATCH_ID = korPor.match_id

export const findMatch = (id) => MATCHES.find((m) => m.match_id === id) ?? MATCHES[0]

// 시나리오 → 보드가 바로 쓸 수 있는 형태.
// home이 플레이어가 조작하는(= 공을 가진) 팀이고, x=120 골문을 향해 공격한다.
// 모먼트가 위치를 직접 지정하면 그 좌표가 곧 그 시점의 온필드 명단(교체 반영, 로스터의 나머지는 벤치),
// 없으면 로스터 앞 11명을 포메이션 기본값으로 (상대는 좌우 반전)
export function buildMatch(scn) {
  const moment = scn.moments[0]
  const homeSquad = playersData.filter((p) => p.team === scn.home)
  const awaySquad = playersData.filter((p) => p.team === scn.away)
  const onPitch = (squad) => (moment.positions ? squad.filter((p) => moment.positions[p.id]) : squad)
  const basePlayers = onPitch(homeSquad).map((p, i) => ({ ...p, x: slots[i]?.x, y: slots[i]?.y, ...moment.positions?.[p.id] }))
  const opponents = onPitch(awaySquad).map((p, i) => ({ ...p, x: 120 - (slots[i]?.x ?? 0), y: 80 - (slots[i]?.y ?? 0), ...moment.positions?.[p.id] }))
  const byId = Object.fromEntries([...basePlayers, ...opponents].map((p) => [p.id, p]))
  // 공유 링크는 선수를 이 배열의 인덱스로 담는다 — 경기가 다르면 인덱스도 다르므로
  // 링크에 경기 id(?m=)가 함께 실려야 한다 (App의 공유 링크 처리 참고).
  return { scenario: scn, moment, basePlayers, opponents, byId, playerIds: basePlayers.map((p) => p.id) }
}
