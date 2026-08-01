// 팀 킷(유니폼 색)과 국가 표기.
//
// 원래 TacticsBoard 안에 있던 상수다. 오프닝 화면이 "보드에 나올 그 유니폼"을 그대로
// 띄워야 해서 밖으로 꺼냈다 — 두 곳에서 색을 따로 관리하면 언젠가 반드시 어긋난다.
//
// 기본값은 조작하는 팀(홈) 빨강 / 상대 남색이고, 실제 유니폼이 그와 어긋나
// 두 팀을 구분하기 어려운 경기만 덮어쓴다.
//
// 팀이 아니라 경기로 거는 이유: 같은 팀도 상대에 따라 홈/원정 킷이 갈린다.
// 스페인은 포르투갈(빨강)을 만나면 흰색, 결승에서 아르헨티나를 만나면 빨간색이다.
//
// num을 따로 두는 이유: 흰 킷에서 등번호를 흰색으로 쓰면 보이지 않는다.
// ring은 테두리이자 공 소유자를 감싸는 점선 색이라, 밝은 킷에서는 어두워야 한다.
export const KIT = {
  RED: { body: '#c8102e', gk: '#e8a020', ring: '#fff', num: '#fff' },
  RED_GKGREEN: { body: '#c8102e', gk: '#2f9e44', ring: '#fff', num: '#fff' }, // 결승 스페인 — GK만 녹색
  WHITE: { body: '#f2f5fa', gk: '#f0a500', ring: '#1a2330', num: '#10141c' },
  SKY: { body: '#75aadb', gk: '#3b2f6f', ring: '#10314f', num: '#0d2438' },
  SKY_GKLIME: { body: '#75aadb', gk: '#a5d64c', ring: '#10314f', num: '#0d2438' }, // 결승 아르헨티나 — GK만 연두색
  NAVY: { body: '#1e3a6e', gk: '#3f6f2f', ring: '#cdd6e8', num: '#fff' },
  NAVY_GKTEAL: { body: '#1e3a6e', gk: '#17a2b8', ring: '#cdd6e8', num: '#fff' }, // 4강 아르헨티나 — GK 청록
  WHITE_GKYELLOW: { body: '#f2f5fa', gk: '#ffd23e', ring: '#c8102e', num: '#c8102e' }, // 4강 잉글랜드 — 흰 킷·빨간 테두리/번호, GK 노랑
  RED_GKTEAL: { body: '#c8102e', gk: '#17a2b8', ring: '#fff', num: '#fff' }, // 2022 한국 — 빨강 킷, GK 청록
  WHITE_GKGOLD: { body: '#f4f6fa', gk: '#ffd23e', ring: '#10141c', num: '#10141c' }, // 2022 포르투갈 — 흰 킷·검은 테두리/번호, GK 노랑
  BRAZIL: { body: '#ffcb05', gk: '#7b2cbf', ring: '#009c3b', num: '#009c3b' }, // 브라질 — 노랑 킷·초록 테두리/번호, GK 보라
  WHITE_GKSKY: { body: '#f2f5fa', gk: '#75aadb', ring: '#1a2330', num: '#10141c' }, // 체코 — 흰 킷, GK 하늘색
}

// match_id → [홈 킷, 원정 킷]
const MATCH_KIT = {
  kor_por_2022: [KIT.RED_GKTEAL, KIT.WHITE_GKGOLD], // 홈=한국 빨강(GK 청록) / 원정=포르투갈 흰색(GK 노랑)
  kor_cze_2026_g1: [KIT.RED, KIT.WHITE_GKSKY], // 홈=한국 빨강 / 원정=체코 흰색(GK 하늘색)
  por_esp_2026_r16: [KIT.WHITE, KIT.RED], // 홈=ESP 흰색 / 원정=포르투갈 빨강
  bra_nor_2026_r16: [KIT.RED_GKGREEN, KIT.BRAZIL], // 홈=노르웨이 빨강(GK 녹색) / 원정=브라질 노랑(GK 보라)
  eng_arg_2026_sf: [KIT.NAVY_GKTEAL, KIT.WHITE_GKYELLOW], // 홈=아르헨티나 남색(GK 청록) / 원정=잉글랜드 흰색(GK 노랑)
  arg_esp_2026_final: [KIT.RED_GKGREEN, KIT.SKY_GKLIME], // 홈=ESP 빨강(GK 녹색) / 원정=아르헨티나 하늘색(GK 연두)
}

export const kitsFor = (matchId) => MATCH_KIT[matchId] ?? [KIT.RED, KIT.NAVY]

// 팀 코드 → 한국어 국가명.
// 코드에 붙은 숫자는 "어느 대회의 그 대표팀인가"를 가르는 표시일 뿐 나라가 다른 게 아니다
// (KOR02·KOR18·KOR26은 모두 대한민국). 화면에는 나라 이름만 나와야 한다.
export const TEAM_NAME = {
  KOR: '대한민국',
  KOR02: '대한민국',
  KOR18: '대한민국',
  KOR26: '대한민국',
  POR: '포르투갈',
  POR26: '포르투갈',
  ITA02: '이탈리아',
  GER18: '독일',
  ESP: '스페인',
  ARG: '아르헨티나',
  ENG: '잉글랜드',
  BRA: '브라질',
  NOR: '노르웨이',
  CZE: '체코',
}

// 화면용 3글자 코드 — 뒤에 붙은 대회 연도를 떼면 FIFA 표기와 같아진다 (KOR26 → KOR).
export const teamCode = (code) => String(code ?? '').replace(/\d+$/, '')
export const teamName = (code) => TEAM_NAME[code] ?? teamCode(code)
