// scripts/build-scenes-2026.mjs — 2026 월드컵 16강 2장면 데이터 생성기.
//   node scripts/build-scenes-2026.mjs <CSV경로>
//
// 왜 스크립트인가: 선수 스탯은 데이터담당의 CSV(터치라인_엔진_v2/
// worldcup_2026_fm26_name_match_corrected.csv)가 원본이다. 손으로 옮겨 적으면
// CSV가 갱신될 때마다 어긋나므로, 매핑 규칙만 여기 두고 결과 JSON은 재생성한다.
//
// ⚠️ 좌표는 "실측"이 아니다. 중계 영상 기준의 정확한 좌표는 공개 소스에 없어서,
// 리서치로 확인한 라인업·포메이션·전개 서술을 바탕으로 배치한 **초안**이다.
// scenes-2026.json의 review.coordinates 항목에 검수 필요로 표시해 둔다.
//
// 이름 매핑은 일부러 **명시 테이블**로 뒀다. CSV는 정식 전체 이름
// (예: "Mikel MERINO ZAZÓN"), 리서치 출처는 통용명("Merino")을 쓴다.
// 퍼지 매칭은 동성이인(P. Berg / S. Berge 등)에서 조용히 틀리므로 쓰지 않는다.

import { readFileSync, writeFileSync } from 'node:fs'

const csvPath = process.argv[2]
if (!csvPath) {
  console.error('사용법: node scripts/build-scenes-2026.mjs <CSV경로>')
  process.exit(1)
}

// ── CSV 로드 ────────────────────────────────────────────────────────
const raw = readFileSync(csvPath, 'utf-8').replace(/^﻿/, '')
const lines = raw.trim().split(/\r?\n/)
const header = lines[0].split(',')
const rows = lines.slice(1).map((l) => {
  const c = l.split(',')
  return Object.fromEntries(header.map((h, i) => [h, c[i]]))
})

// CSV 한글 컬럼 → players.json 스탯 키 (FM 1~20 그대로)
const STAT_COL = {
  flair: '개인기',
  finishing: '골결',
  dribbling: '드리블',
  longshots: '중거리',
  crossing: '크로스',
  passing: '패스',
  heading: '헤더',
  strength: '몸싸움',
  acceleration: '가속도',
  pace: '주력',
  jumping: '점프거리',
  balance: '균형감각',
  marking: '일대일 마크',
  tackle: '태클',
  positioning: '수비위치선정',
  anticipation: '예측력',
}

function findPlayer(country, csvName) {
  const hit = rows.find((r) => r['국가'] === country && r['이름'] === csvName)
  if (!hit) throw new Error(`CSV에 없음: ${country} / ${csvName}`)
  return hit
}

function toPlayer({ id, team, country, csvName, name, number, position, roles }) {
  const r = findPlayer(country, csvName)
  return {
    id,
    name,
    team,
    number,
    position,
    roles,
    heightCm: Number(r['키(cm)']),
    stats: Object.fromEntries(Object.entries(STAT_COL).map(([k, col]) => [k, Number(r[col])])),
    statSource: 'fm26',
    condition: 100,
  }
}

// ── 장면 A: 포르투갈 0-1 스페인 (2026-07-06, 16강) ──────────────────
// 메리노 90+1분 결승골. 페란 토레스의 스루패스 → 디오구 코스타와 1대1 → 좌하단 구석.
// 홈(공격) = 스페인. x=120이 포르투갈 골문.
//
// 배치 근거: 90+1분, 스페인이 이기려 올라와 있고 포르투갈은 내려앉은 상태.
// 85분 더블 교체(메리노·파비안) 이후의 정확한 포지션 배열은 출처에 없어 4-2-3-1 유지로 가정.
const ESP = [
  { id: 'esp_23', csvName: 'Unai SIMÓN MENDIBIL', name: '우나이 시몬', number: 23, position: 'GK', roles: ['GK'], x: 30, y: 40 },
  { id: 'esp_02', csvName: 'Pedro Antonio PORRO SAUCEDA', name: '페드로 포로', number: 2, position: 'DF', roles: ['RB'], x: 66, y: 66 },
  { id: 'esp_05', csvName: 'Pau CUBARSI I PAREDES', name: '파우 쿠바르시', number: 5, position: 'DF', roles: ['CB'], x: 58, y: 46 },
  { id: 'esp_14', csvName: 'Aymeric LAPORTE FEVRE', name: '아이메릭 라포르트', number: 14, position: 'DF', roles: ['CB'], x: 57, y: 32 },
  { id: 'esp_24', csvName: 'Marc CUCURELLA SASETA', name: '마르크 쿠쿠렐라', number: 24, position: 'DF', roles: ['LB'], x: 68, y: 14 },
  { id: 'esp_16', csvName: 'Rodrigo HERNÁNDEZ CASCANTE', name: '로드리', number: 16, position: 'MF', roles: ['DM'], x: 72, y: 44 },
  { id: 'esp_08', csvName: 'Fabian RUIZ PEÑA', name: '파비안 루이스', number: 8, position: 'MF', roles: ['CM'], x: 75, y: 30 },
  { id: 'esp_19', csvName: 'Lamine Yamal NASRAOUI EBANA', name: '라민 야말', number: 19, position: 'FW', roles: ['RW'], x: 96, y: 66 },
  { id: 'esp_06', csvName: 'Mikel MERINO ZAZÓN', name: '미켈 메리노', number: 6, position: 'MF', roles: ['CAM'], x: 92, y: 44 },
  { id: 'esp_07', csvName: 'Ferran TORRES GARCÍA', name: '페란 토레스', number: 7, position: 'FW', roles: ['LW'], x: 94, y: 30 },
  { id: 'esp_21', csvName: 'Mikel OYARZABAL UGARTE', name: '미켈 오야르사발', number: 21, position: 'FW', roles: ['ST'], x: 103, y: 46 },
]
const POR_A = [
  { id: 'p26_01', csvName: 'Diogo MEIRELES DA COSTA', name: '디오구 코스타', number: 1, position: 'GK', roles: ['GK'], x: 116, y: 40 },
  { id: 'p26_20', csvName: 'José Diogo DALOT TEIXEIRA', name: '디오구 달로트', number: 20, position: 'DF', roles: ['RB'], x: 106, y: 26 },
  { id: 'p26_03', csvName: 'Rúben DOS SANTOS GATO ALVES DIAS', name: '후벵 디아스', number: 3, position: 'DF', roles: ['CB'], x: 108, y: 38 },
  { id: 'p26_14', csvName: 'Renato DA PALMA VEIGA', name: '헤나투 베이가', number: 14, position: 'DF', roles: ['CB'], x: 109, y: 48 },
  { id: 'p26_02', csvName: 'Nélson CABRAL SEMEDO', name: '넬송 세메두', number: 2, position: 'DF', roles: ['LB'], x: 105, y: 60 },
  { id: 'p26_18', csvName: 'João Pedro GONÇALVES NEVES', name: '주앙 네베스', number: 18, position: 'MF', roles: ['DM'], x: 100, y: 42 },
  { id: 'p26_10', csvName: 'Bernardo MOTA VEIGA DE CARVALHO E SILVA', name: '베르나르두 실바', number: 10, position: 'MF', roles: ['CM'], x: 97, y: 52 },
  { id: 'p26_17', csvName: 'Rafael Alexandre DA CONCEIÇÃO LEÃO', name: '하파엘 레앙', number: 17, position: 'FW', roles: ['LW'], x: 88, y: 20 },
  { id: 'p26_08', csvName: 'Bruno Miguel BORGES FERNANDES', name: '브루누 페르난드스', number: 8, position: 'MF', roles: ['CAM'], x: 90, y: 44 },
  { id: 'p26_11', csvName: 'Francisco FERNANDES DA CONCEIÇÃO', name: '프란시스쿠 콘세이상', number: 11, position: 'FW', roles: ['RW'], x: 87, y: 62 },
  { id: 'p26_07', csvName: 'Cristiano Ronaldo DOS SANTOS AVEIRO', name: '크리스티아누 호날두', number: 7, position: 'FW', roles: ['ST'], x: 80, y: 40 },
]

// ── 장면 B: 브라질 1-2 노르웨이 (2026-07-05, 16강) ──────────────────
// 홀란 79분 선제골. 셸데루프가 왼쪽에서 약한 태클을 제치고 올린 크로스를
// 가브리에우 마갈량이스 위로 뛰어올라 헤더. 홈(공격) = 노르웨이.
//
// 배치 근거: 왼쪽(y<40)에서 크로스가 올라오고 홀란이 박스 안 중앙에서 마주친다.
// 크로스 판정 기하(K.CROSS: |y-40|≥18, 도착 x≥102)를 만족하도록 셸데루프를 y=14에 뒀다.
const NOR = [
  { id: 'nor_01', csvName: 'Ørjan Haskjold NYLAND', name: '외르얀 뉠란', number: 1, position: 'GK', roles: ['GK'], x: 28, y: 40 },
  { id: 'nor_15', csvName: 'Fredrik AURSNES', name: '프레드리크 아우르스네스', number: 15, position: 'DF', roles: ['RB'], x: 62, y: 64 },
  { id: 'nor_05', csvName: 'Kristoffer Vassbakk Köpp AJER', name: '크리스토페르 아예르', number: 5, position: 'DF', roles: ['CB'], x: 56, y: 46 },
  { id: 'nor_06', csvName: 'Torbjørn Lysaker HEGGEM', name: '토르비외른 헤겜', number: 6, position: 'DF', roles: ['CB'], x: 55, y: 32 },
  { id: 'nor_03', csvName: 'David Møller WOLFE', name: '다비드 묄레르 볼페', number: 3, position: 'DF', roles: ['LB'], x: 64, y: 16 },
  { id: 'nor_10', csvName: 'Martín ØDEGAARD', name: '마르틴 외데고르', number: 10, position: 'MF', roles: ['CAM'], x: 84, y: 46 },
  { id: 'nor_18', csvName: 'Patrick BERG', name: '파트리크 베르그', number: 18, position: 'MF', roles: ['DM'], x: 72, y: 40 },
  { id: 'nor_08', csvName: 'Sander Gard Bolin BERGE', name: '산데르 베르게', number: 8, position: 'MF', roles: ['CM'], x: 78, y: 54 },
  { id: 'nor_11', csvName: 'Oscar BOBB', name: '오스카르 보브', number: 11, position: 'FW', roles: ['RW'], x: 97, y: 62 },
  { id: 'nor_09', csvName: 'Erling Braut HAALAND', name: '엘링 홀란', number: 9, position: 'FW', roles: ['ST'], x: 106, y: 42 },
  { id: 'nor_20', csvName: 'Andreas Rædergård SCHJELDERUP', name: '안드레아스 셸데루프', number: 20, position: 'FW', roles: ['LW'], x: 95, y: 14 },
]
const BRA = [
  { id: 'bra_01', csvName: 'Álisson Ramsés BECKER', name: '알리송', number: 1, position: 'GK', roles: ['GK'], x: 116, y: 40 },
  { id: 'bra_02', csvName: 'Danilo Luiz DA SILVA', name: '다닐루', number: 2, position: 'DF', roles: ['RB'], x: 104, y: 24 },
  { id: 'bra_04', csvName: 'Marcos AOAS CORREA', name: '마르키뉴스', number: 4, position: 'DF', roles: ['CB'], x: 108, y: 36 },
  { id: 'bra_03', csvName: 'Gabriel DOS SANTOS MAGALHÃES', name: '가브리에우 마갈량이스', number: 3, position: 'DF', roles: ['CB'], x: 108, y: 45 },
  { id: 'bra_06', csvName: 'Douglas DOS SANTOS JUSTINO DE MELO', name: '도글라스 산투스', number: 6, position: 'DF', roles: ['LB'], x: 102, y: 58 },
  { id: 'bra_05', csvName: 'Carlos Henrique CASIMIRO', name: '카제미루', number: 5, position: 'MF', roles: ['DM'], x: 96, y: 42 },
  { id: 'bra_17', csvName: 'Bruno GUIMARÃES RODRIGUEZ MOURA', name: '브루누 기마랑이스', number: 17, position: 'MF', roles: ['CM'], x: 92, y: 50 },
  { id: 'bra_07', csvName: 'Vinicius José PAIXÃO DE OLIVEIRA JÚNIOR', name: '비니시우스 주니오르', number: 7, position: 'FW', roles: ['LW'], x: 82, y: 62 },
  { id: 'bra_16', csvName: 'Danilo DOS SANTOS DE OLIVEIRA', name: '다닐루 산투스', number: 16, position: 'MF', roles: ['CM'], x: 90, y: 32 },
  { id: 'bra_09', csvName: 'Endrick Felipe MOREIRA DE SOUSA PESSOA', name: '엔드리크', number: 9, position: 'FW', roles: ['ST'], x: 76, y: 44 },
  { id: 'bra_10', csvName: 'Neymar DA SILVA SANTOS JÚNIOR', name: '네이마르', number: 10, position: 'FW', roles: ['CAM'], x: 78, y: 34 },
]

const mk = (list, team, country) =>
  list.map((p) => toPlayer({ ...p, team, country }))
const posMap = (list) => Object.fromEntries(list.map((p) => [p.id, { x: p.x, y: p.y }]))

const players = [
  ...mk(ESP, 'ESP', 'Spain'),
  ...mk(POR_A, 'POR26', 'Portugal'),
  ...mk(NOR, 'NOR', 'Norway'),
  ...mk(BRA, 'BRA', 'Brazil'),
]

const scenes = {
  _generator: 'scripts/build-scenes-2026.mjs — CSV가 갱신되면 재실행할 것',
  matches: [
    {
      match_id: 'por_esp_2026_r16',
      title: '2026 북중미 월드컵 16강 — 포르투갈 vs 스페인',
      home: 'ESP',
      away: 'POR26',
      actual: '포르투갈 0 : 1 스페인 (2026-07-06, 댈러스 스타디움)',
      moments: [
        {
          id: 'm901_merino',
          minute: 91,
          score: [0, 0],
          situation: '90+1분. 0-0, 연장이 눈앞. 85분에 들어온 교체 선수 둘이 마지막 기회를 만든다.',
          objective: '메리노를 골키퍼와 1대1로 만들어라',
          ball: 'esp_08',
          positions: { ...posMap(ESP), ...posMap(POR_A) },
          easterEgg: {
            passerId: 'esp_07',
            scorerId: 'esp_06',
            title: '그날, 진짜로 있었던 일',
            caption:
              '2026년 7월 6일 댈러스. 85분에 함께 들어온 페란 토레스와 메리노가 90+1분에 경기를 끝냈다. 토레스의 스루패스, 디오구 코스타와의 1대1, 그리고 좌하단 구석. 호날두의 마지막 월드컵 경기였다.',
            images: [],
          },
        },
      ],
    },
    {
      match_id: 'bra_nor_2026_r16',
      title: '2026 북중미 월드컵 16강 — 브라질 vs 노르웨이',
      home: 'NOR',
      away: 'BRA',
      actual: '브라질 1 : 2 노르웨이 (2026-07-05, 뉴욕 뉴저지 스타디움)',
      moments: [
        {
          id: 'm79_haaland',
          minute: 79,
          score: [0, 0],
          situation: '79분. 0-0 팽팽한 균형. 하프타임에 들어온 셸데루프가 왼쪽을 허문다.',
          objective: '홀란의 머리에 크로스를 배달하라',
          ball: 'nor_20',
          positions: { ...posMap(NOR), ...posMap(BRA) },
          easterEgg: {
            passerId: 'nor_20',
            scorerId: 'nor_09',
            title: '그날, 진짜로 있었던 일',
            caption:
              '2026년 7월 5일 뉴저지. 셸데루프가 왼쪽에서 태클을 제치고 올린 크로스를, 홀란이 가브리에우 마갈량이스 위로 솟아올라 알리송의 골문에 꽂았다. 노르웨이는 사상 첫 월드컵 8강에 올랐다.',
            images: [],
          },
        },
      ],
    },
  ],
  // 데이터담당 검수 항목 — 리서치에서 출처가 엇갈리거나 확인 못 한 것들.
  review: {
    status: '검수 필요 (데이터담당)',
    coordinates:
      '모든 선수 좌표는 리서치로 확인한 라인업·포메이션·전개 서술에 근거한 배치 초안이다. ' +
      '중계 영상 기준 실측이 아니므로 장면 느낌이 어긋나면 positions만 고치면 된다.',
    unverified: [
      'POR-ESP: 페란 토레스에게 패스한 선수가 파비안 루이스(ESPN)인지 로드리(Opta)인지 출처가 엇갈린다. 현재 공 소유자를 파비안 루이스(esp_08)로 뒀다.',
      'POR-ESP: 프리킥에서 빠르게 시작된 전개였는지는 ESPN 단독 서술이라 미확인. 현재는 오픈플레이로 배치했다.',
      'POR-ESP: 메리노 슛의 정확한 거리·각도, 85분 더블 교체 후 스페인의 실제 포지션 배열 미확인 (4-2-3-1 유지로 가정).',
      'BRA-NOR: 브라질 선발 11번째 선수 미확인(마르티넬리 추정). 현재 79분 기준 온피치로 다닐루 산투스(bra_16)를 넣었다.',
      'BRA-NOR: 79분 에데르송↔브루누 기마랑이스 교체가 골 앞인지 뒤인지 미확인. 기마랑이스가 아직 뛰는 것으로 뒀다.',
      'BRA-NOR: 홀란 헤더의 박스 안 정확한 지점 미확인.',
    ],
    sources: [
      'https://www.espn.com/soccer/commentary/_/gameId/760506',
      'https://www.espn.com/soccer/lineups/_/gameId/760506',
      'https://theanalyst.com/articles/portugal-vs-spain-stats-world-cup-round-of-16',
      'https://www.espn.com/soccer/commentary/_/gameId/760504',
      'https://www.espn.com/soccer/lineups/_/gameId/760504',
    ],
  },
}

const root = new URL('../src/data/', import.meta.url)
// 기존 players.json에 이어붙인다 (KOR/POR 2022 로스터는 그대로 유지)
const existing = JSON.parse(readFileSync(new URL('players.json', root), 'utf-8'))
const keep = existing.filter((p) => !players.some((n) => n.id === p.id))
writeFileSync(new URL('players.json', root), JSON.stringify([...keep, ...players], null, 2) + '\n')
writeFileSync(new URL('scenes-2026.json', root), JSON.stringify(scenes, null, 2) + '\n')

console.log(`players.json: 기존 ${keep.length}명 + 신규 ${players.length}명`)
console.log(`scenes-2026.json: ${scenes.matches.length}경기`)
for (const m of scenes.matches) console.log(`  - ${m.title} (${m.moments.length} moment)`)
