// scripts/build-scenes-2026.mjs — 2026 월드컵 장면 데이터 생성기 (현재 7경기).
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

function toPlayer({ id, team, csvName, name, number, position, roles, stats, heightCm, country }) {
  // csvName이 없으면 인라인 stats를 쓴다 — CSV 데이터베이스에 없는 선수(경기 중 투입된
  // 교체 선수 등)를 임의 스탯으로 넣을 때. statSource로 fm26과 구분한다.
  if (!csvName) {
    if (!stats) throw new Error(`csvName도 stats도 없다: ${name}`)
    return { id, name, team, number, position, roles, heightCm: heightCm ?? 180, stats, statSource: 'manual', condition: 100 }
  }
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
  { id: 'esp_23', csvName: 'Unai SIMÓN MENDIBIL', name: '우나이 시몬', number: 23, position: 'GK', roles: ['GK'] },
  { id: 'esp_12', csvName: 'Pedro Antonio PORRO SAUCEDA', name: '페드로 포로', number: 12, position: 'DF', roles: ['RB'] },
  { id: 'esp_22', csvName: 'Pau CUBARSI I PAREDES', name: '파우 쿠바르시', number: 22, position: 'DF', roles: ['CB'] },
  { id: 'esp_14', csvName: 'Aymeric LAPORTE FEVRE', name: '아이메릭 라포르트', number: 14, position: 'DF', roles: ['CB'] },
  { id: 'esp_24', csvName: 'Marc CUCURELLA SASETA', name: '마르크 쿠쿠렐라', number: 24, position: 'DF', roles: ['LB'] },
  { id: 'esp_16', csvName: 'Rodrigo HERNÁNDEZ CASCANTE', name: '로드리', number: 16, position: 'MF', roles: ['DM'] },
  { id: 'esp_08', csvName: 'Fabian RUIZ PEÑA', name: '파비안 루이스', number: 8, position: 'MF', roles: ['CM'] },
  { id: 'esp_19', csvName: 'Lamine Yamal NASRAOUI EBANA', name: '라민 야말', number: 19, position: 'FW', roles: ['RW'] },
  { id: 'esp_06', csvName: 'Mikel MERINO ZAZÓN', name: '미켈 메리노', number: 6, position: 'MF', roles: ['CAM'] },
  { id: 'esp_07', csvName: 'Ferran TORRES GARCÍA', name: '페란 토레스', number: 7, position: 'FW', roles: ['LW'] },
  { id: 'esp_21', csvName: 'Mikel OYARZABAL UGARTE', name: '미켈 오야르사발', number: 21, position: 'FW', roles: ['ST'] },
]
const POR_A = [
  { id: 'p26_01', csvName: 'Diogo MEIRELES DA COSTA', name: '디오구 코스타', number: 1, position: 'GK', roles: ['GK'] },
  { id: 'p26_05', csvName: 'José Diogo DALOT TEIXEIRA', name: '디오구 달로트', number: 5, position: 'DF', roles: ['RB'] },
  { id: 'p26_03', csvName: 'Rúben DOS SANTOS GATO ALVES DIAS', name: '후벵 디아스', number: 3, position: 'DF', roles: ['CB'] },
  { id: 'p26_13', csvName: 'Renato DA PALMA VEIGA', name: '헤나투 베이가', number: 13, position: 'DF', roles: ['CB'] },
  { id: 'p26_02', csvName: 'Nélson CABRAL SEMEDO', name: '넬송 세메두', number: 2, position: 'DF', roles: ['LB'] },
  { id: 'p26_15', csvName: 'João Pedro GONÇALVES NEVES', name: '주앙 네베스', number: 15, position: 'MF', roles: ['DM'] },
  { id: 'p26_10', csvName: 'Bernardo MOTA VEIGA DE CARVALHO E SILVA', name: '베르나르두 실바', number: 10, position: 'MF', roles: ['CM'] },
  { id: 'p26_17', csvName: 'Rafael Alexandre DA CONCEIÇÃO LEÃO', name: '하파엘 레앙', number: 17, position: 'FW', roles: ['LW'] },
  { id: 'p26_08', csvName: 'Bruno Miguel BORGES FERNANDES', name: '브루누 페르난드스', number: 8, position: 'MF', roles: ['CAM'] },
  { id: 'p26_26', csvName: 'Francisco FERNANDES DA CONCEIÇÃO', name: '프란시스쿠 콘세이상', number: 26, position: 'FW', roles: ['RW'] },
  { id: 'p26_07', csvName: 'Cristiano Ronaldo DOS SANTOS AVEIRO', name: '크리스티아누 호날두', number: 7, position: 'FW', roles: ['ST'] },
  // 아래 다섯은 90+1분 장면에는 없다 — 이 경기 선발이었다가 교체로 나간 선수들이다.
  // 온필드 명단은 positions가 정하므로 벤치로 남지만, 로스터에 있어야 등번호가 제자리를 지킨다.
  // (이들이 빠져 있던 탓에 20·18·11번이 교체 투입 선수에게 잘못 붙어 있었다.)
  { id: 'p26_20', csvName: 'João Pedro CAVACO CANCELO', name: '주앙 칸셀루', number: 20, position: 'DF', roles: ['RB'] },
  { id: 'p26_25', csvName: 'Nuno Alexandre TAVARES MENDES', name: '누누 멘드스', number: 25, position: 'DF', roles: ['LB'] },
  { id: 'p26_23', csvName: 'Vitor MACHADO FERREIRA', name: '비티냐', number: 23, position: 'MF', roles: ['CM'] },
  { id: 'p26_18', csvName: 'Pedro LOMBA NETO', name: '페드루 네투', number: 18, position: 'FW', roles: ['RW'] },
  { id: 'p26_11', csvName: 'João FÉLIX SEQUEIRA', name: '주앙 펠릭스', number: 11, position: 'FW', roles: ['ST'] },
]

// ── 장면 B: 브라질 1-2 노르웨이 (2026-07-05, 16강) ──────────────────
// 홀란 79분 선제골. 셸데루프가 왼쪽에서 약한 태클을 제치고 올린 크로스를
// 가브리에우 마갈량이스 위로 뛰어올라 헤더. 홈(공격) = 노르웨이.
//
// 배치 근거: 왼쪽(y<40)에서 크로스가 올라오고 홀란이 박스 안 중앙에서 마주친다.
// 크로스 판정 기하(K.CROSS: |y-40|≥18, 도착 x≥102)를 만족하도록 셸데루프를 y=14에 뒀다.
const NOR = [
  { id: 'nor_01', csvName: 'Ørjan Haskjold NYLAND', name: '외르얀 뉠란', number: 1, position: 'GK', roles: ['GK'] },
  { id: 'nor_14', csvName: 'Fredrik AURSNES', name: '프레드리크 아우르스네스', number: 14, position: 'DF', roles: ['RB'] },
  { id: 'nor_03', csvName: 'Kristoffer Vassbakk Köpp AJER', name: '크리스토페르 아예르', number: 3, position: 'DF', roles: ['CB'] },
  { id: 'nor_17', csvName: 'Torbjørn Lysaker HEGGEM', name: '토르비외른 헤겜', number: 17, position: 'DF', roles: ['CB'] },
  { id: 'nor_05', csvName: 'David Møller WOLFE', name: '다비드 묄레르 볼페', number: 5, position: 'DF', roles: ['LB'] },
  { id: 'nor_10', csvName: 'Martín ØDEGAARD', name: '마르틴 외데고르', number: 10, position: 'MF', roles: ['CAM'] },
  { id: 'nor_06', csvName: 'Patrick BERG', name: '파트리크 베르그', number: 6, position: 'MF', roles: ['DM'] },
  { id: 'nor_08', csvName: 'Sander Gard Bolin BERGE', name: '산데르 베르게', number: 8, position: 'MF', roles: ['CM'] },
  { id: 'nor_22', csvName: 'Oscar BOBB', name: '오스카르 보브', number: 22, position: 'FW', roles: ['RW'] },
  { id: 'nor_09', csvName: 'Erling Braut HAALAND', name: '엘링 홀란', number: 9, position: 'FW', roles: ['ST'] },
  { id: 'nor_21', csvName: 'Andreas Rædergård SCHJELDERUP', name: '안드레아스 셸데루프', number: 21, position: 'FW', roles: ['LW'] },
]
const BRA = [
  { id: 'bra_01', csvName: 'Álisson Ramsés BECKER', name: '알리송', number: 1, position: 'GK', roles: ['GK'] },
  { id: 'bra_13', csvName: 'Danilo Luiz DA SILVA', name: '다닐루', number: 13, position: 'DF', roles: ['RB'] },
  { id: 'bra_04', csvName: 'Marcos AOAS CORREA', name: '마르키뉴스', number: 4, position: 'DF', roles: ['CB'] },
  { id: 'bra_03', csvName: 'Gabriel DOS SANTOS MAGALHÃES', name: '가브리에우 마갈량이스', number: 3, position: 'DF', roles: ['CB'] },
  { id: 'bra_16', csvName: 'Douglas DOS SANTOS JUSTINO DE MELO', name: '도글라스 산투스', number: 16, position: 'DF', roles: ['LB'] },
  { id: 'bra_05', csvName: 'Carlos Henrique CASIMIRO', name: '카제미루', number: 5, position: 'MF', roles: ['DM'] },
  { id: 'bra_08', csvName: 'Bruno GUIMARÃES RODRIGUEZ MOURA', name: '브루누 기마랑이스', number: 8, position: 'MF', roles: ['CM'] },
  { id: 'bra_07', csvName: 'Vinicius José PAIXÃO DE OLIVEIRA JÚNIOR', name: '비니시우스 주니오르', number: 7, position: 'FW', roles: ['LW'] },
  { id: 'bra_18', csvName: 'Danilo DOS SANTOS DE OLIVEIRA', name: '다닐루 산투스', number: 18, position: 'MF', roles: ['CM'] },
  { id: 'bra_19', csvName: 'Endrick Felipe MOREIRA DE SOUSA PESSOA', name: '엔드리크', number: 19, position: 'FW', roles: ['ST'] },
  { id: 'bra_10', csvName: 'Neymar DA SILVA SANTOS JÚNIOR', name: '네이마르', number: 10, position: 'FW', roles: ['CAM'] },
  // 미드필더 에데르송(아탈란타) — 79분 브루누 기마랑이스와 교체 투입. CSV 데이터베이스에는
  // 동명이인 골키퍼만 있어 스탯은 임의값(수비형 미드필더 기준)으로 넣는다.
  {
    id: 'bra_02', name: '에데르송', number: 2, position: 'MF', roles: ['DM'], heightCm: 183,
    stats: { flair: 11, finishing: 8, dribbling: 12, longshots: 11, crossing: 10, passing: 14, heading: 12, strength: 14, acceleration: 12, pace: 12, jumping: 13, balance: 13, marking: 14, tackle: 15, positioning: 14, anticipation: 14 },
  },
]

// ── 로스터: 아래 5경기용 ────────────────────────────────────────────
// 2022 KOR(kor_*)과 2026 KOR(k26_*)은 다른 팀으로 둔다 — 같은 대회가 아니고
// 등번호도 다르다(예: 이강인 18 → 19). 좌표는 여기 두지 않고 경기별 POS_*에 둔다.
// 등번호·선발 명단·교체는 ESPN 라인업 페이지와 각국 협회 발표 번호로 확인했다(review.sources).
const KOR26 = [
  { id: 'k26_01', csvName: 'Seunggyu KIM', name: '김승규', number: 1, position: 'GK', roles: ['GK'] },
  { id: 'k26_02', csvName: 'Hanbeom LEE', name: '이한범', number: 2, position: 'DF', roles: ['CB'] },
  { id: 'k26_03', csvName: 'Gihyuk LEE', name: '이기혁', number: 3, position: 'DF', roles: ['CB'] },
  { id: 'k26_04', csvName: 'Minjae KIM', name: '김민재', number: 4, position: 'DF', roles: ['CB'] },
  { id: 'k26_06', csvName: 'Inbeom HWANG', name: '황인범', number: 6, position: 'MF', roles: ['CM'] },
  { id: 'k26_07', csvName: 'Heung Min SON', name: '손흥민', number: 7, position: 'FW', roles: ['LW'] },
  { id: 'k26_08', csvName: 'Seungho PAIK', name: '백승호', number: 8, position: 'MF', roles: ['CM'] },
  { id: 'k26_09', csvName: 'Guesung CHO', name: '조규성', number: 9, position: 'FW', roles: ['ST'] },
  { id: 'k26_11', csvName: 'Hee Chan HWANG', name: '황희찬', number: 11, position: 'FW', roles: ['LW'] },
  { id: 'k26_13', csvName: 'Taeseok LEE', name: '이태석', number: 13, position: 'DF', roles: ['LB'] },
  { id: 'k26_15', csvName: 'Moonhwan KIM', name: '김문환', number: 15, position: 'DF', roles: ['RB'] },
  { id: 'k26_18', csvName: 'Hyeongyu OH', name: '오현규', number: 18, position: 'FW', roles: ['ST'] },
  { id: 'k26_19', csvName: 'Kangin LEE', name: '이강인', number: 19, position: 'MF', roles: ['CAM'] },
  { id: 'k26_20', csvName: 'Hyunjun YANG', name: '양현준', number: 20, position: 'FW', roles: ['RW'] },
  { id: 'k26_22', csvName: 'Youngwoo SEOL', name: '설영우', number: 22, position: 'DF', roles: ['RB'] },
  { id: 'k26_23', csvName: 'Jens CASTROP', name: '옌스 카스트로프', number: 23, position: 'MF', roles: ['CM'] },
  { id: 'k26_24', csvName: 'Jingyu KIM', name: '김진규', number: 24, position: 'MF', roles: ['CM'] },
  { id: 'k26_25', csvName: 'Jisung EOM', name: '엄지성', number: 25, position: 'FW', roles: ['LW'] },
]
const CZE = [
  { id: 'cze_01', csvName: 'Matěj KOVÁŘ', name: '마테이 코바르시', number: 1, position: 'GK', roles: ['GK'] },
  { id: 'cze_04', csvName: 'Robin HRANÁČ', name: '로빈 흐라나치', number: 4, position: 'DF', roles: ['CB'] },
  { id: 'cze_05', csvName: 'Vladimír COUFAL', name: '블라디미르 초우팔', number: 5, position: 'DF', roles: ['RB'] },
  { id: 'cze_06', csvName: 'Štěpán CHALOUPEK', name: '슈테판 할로우페크', number: 6, position: 'DF', roles: ['CB'] },
  { id: 'cze_07', csvName: 'Ladislav KREJČÍ', name: '라디슬라프 크레이치', number: 7, position: 'DF', roles: ['CB'] },
  { id: 'cze_09', csvName: 'Adam HLOŽEK', name: '아담 흘로제크', number: 9, position: 'FW', roles: ['LW'] },
  { id: 'cze_18', csvName: 'Michal SADÍLEK', name: '미할 사딜레크', number: 18, position: 'MF', roles: ['CM'] },
  { id: 'cze_19', csvName: 'Tomáš CHORÝ', name: '토마시 호리', number: 19, position: 'FW', roles: ['ST'] },
  { id: 'cze_20', csvName: 'Jaroslav ZELENÝ', name: '야로슬라프 젤레니', number: 20, position: 'DF', roles: ['LB'] },
  { id: 'cze_22', csvName: 'Tomáš SOUČEK', name: '토마시 소우체크', number: 22, position: 'MF', roles: ['DM'] },
  { id: 'cze_24', csvName: 'Alexandr SOJKA', name: '알렉산드르 소이카', number: 24, position: 'MF', roles: ['CM'] },
]
const ENG = [
  { id: 'eng_01', csvName: 'Jordan Lee PICKFORD', name: '조던 픽퍼드', number: 1, position: 'GK', roles: ['GK'] },
  { id: 'eng_02', csvName: 'Ezri Ngoyo KONSA', name: '에즈리 콘사', number: 2, position: 'DF', roles: ['RB'] },
  { id: 'eng_03', csvName: "Nico O'REILLY", name: '니코 오라일리', number: 3, position: 'MF', roles: ['CM'] },
  { id: 'eng_05', csvName: 'John STONES', name: '존 스톤스', number: 5, position: 'DF', roles: ['CB'] },
  { id: 'eng_06', csvName: 'Addji Keaninkin Marc-Isreal GUEHI', name: '마크 게히', number: 6, position: 'DF', roles: ['CB'] },
  { id: 'eng_08', csvName: 'Elliot Junior ANDERSON', name: '엘리엇 앤더슨', number: 8, position: 'MF', roles: ['DM'] },
  { id: 'eng_09', csvName: 'Harry Edward KANE', name: '해리 케인', number: 9, position: 'FW', roles: ['ST'] },
  { id: 'eng_10', csvName: 'Jude Victor William BELLINGHAM', name: '주드 벨링엄', number: 10, position: 'MF', roles: ['CAM'] },
  { id: 'eng_15', csvName: 'Daniel Johnson BURN', name: '댄 번', number: 15, position: 'DF', roles: ['LB'] },
  { id: 'eng_17', csvName: 'Morgan Elliot ROGERS', name: '모건 로저스', number: 17, position: 'MF', roles: ['RW'] },
  { id: 'eng_25', csvName: 'Diop Tehuti Djed-Hotep SPENCE', name: '제드 스펜스', number: 25, position: 'DF', roles: ['LB'] },
]
const ARG = [
  { id: 'arg_02', csvName: 'Marcos Nicolás SENESI BARON', name: '마르코스 세네시', number: 2, position: 'DF', roles: ['CB'] },
  { id: 'arg_03', csvName: 'Nicolás Alejandro TAGLIAFICO', name: '니콜라스 탈리아피코', number: 3, position: 'DF', roles: ['LB'] },
  { id: 'arg_04', csvName: 'Gonzalo Ariel MONTIEL', name: '곤살로 몬티엘', number: 4, position: 'DF', roles: ['RB'] },
  { id: 'arg_05', csvName: 'Leandro Daniel PAREDES', name: '레안드로 파레데스', number: 5, position: 'MF', roles: ['DM'] },
  { id: 'arg_07', csvName: 'Rodrigo Javier DE PAUL', name: '로드리고 데 파울', number: 7, position: 'MF', roles: ['CM'] },
  { id: 'arg_09', csvName: 'Julián ÁLVAREZ', name: '훌리안 알바레스', number: 9, position: 'FW', roles: ['ST'] },
  { id: 'arg_10', csvName: 'Lionel Andrés MESSI', name: '리오넬 메시', number: 10, position: 'FW', roles: ['RW'] },
  { id: 'arg_13', csvName: 'Cristian Gabriel ROMERO', name: '크리스티안 로메로', number: 13, position: 'DF', roles: ['CB'] },
  { id: 'arg_15', csvName: 'Nicolas Ivan GONZALEZ', name: '니콜라스 곤살레스', number: 15, position: 'FW', roles: ['LW'] },
  { id: 'arg_17', csvName: 'Giuliano SIMEONE', name: '줄리아노 시메오네', number: 17, position: 'FW', roles: ['RW'] },
  { id: 'arg_19', csvName: 'Nicolas Hernan Gonzalo OTAMENDI', name: '니콜라스 오타멘디', number: 19, position: 'DF', roles: ['CB'] },
  { id: 'arg_20', csvName: 'Alexis MAC ALLISTER', name: '알렉시스 맥 알리스터', number: 20, position: 'MF', roles: ['CM'] },
  { id: 'arg_22', csvName: 'Lautaro Javier MARTÍNEZ', name: '라우타로 마르티네스', number: 22, position: 'FW', roles: ['ST'] },
  { id: 'arg_23', csvName: 'Damián Emiliano MARTÍNEZ', name: '에밀리아노 마르티네스', number: 23, position: 'GK', roles: ['GK'] },
  { id: 'arg_24', csvName: 'Enzo Jeremías FERNÁNDEZ', name: '엔소 페르난데스', number: 24, position: 'MF', roles: ['CM'] },
  { id: 'arg_25', csvName: 'Facundo Axel MEDINA', name: '파쿤도 메디나', number: 25, position: 'DF', roles: ['CB'] },
  { id: 'arg_26', csvName: 'Nahuel MOLINA LUCERO', name: '나우엘 몰리나', number: 26, position: 'DF', roles: ['RB'] },
]
// 결승 106분에 뛰던 스페인 선수 중 16강 로스터(ESP)에 없는 넷.
const ESP_EXTRA = [
  { id: 'esp_04', csvName: 'Eric GARCÍA MARTRET', name: '에리크 가르시아', number: 4, position: 'DF', roles: ['CB'] },
  { id: 'esp_17', csvName: 'Nicholas WILLIAMS ARTHUER', name: '니코 윌리엄스', number: 17, position: 'FW', roles: ['LW'] },
  { id: 'esp_18', csvName: 'Martin ZUBIMENDI IBAÑEZ', name: '마르틴 수비멘디', number: 18, position: 'MF', roles: ['DM'] },
  { id: 'esp_20', csvName: 'Pedro GONZÁLEZ LÓPEZ', name: '페드리', number: 20, position: 'MF', roles: ['CM'] },
  // POR-ESP 85분에 메리노와 교체된 선수 (페드리는 파비안 루이스와 교체, 위에 이미 있다).
  { id: 'esp_10', csvName: 'Daniel OLMO CARVAJAL', name: '다니 올모', number: 10, position: 'MF', roles: ['CAM'] },
]

const mk = (list, team, country) =>
  list.map((p) => toPlayer({ ...p, team, country }))

const players = [
  ...mk(ESP, 'ESP', 'Spain'),
  ...mk(ESP_EXTRA, 'ESP', 'Spain'),
  ...mk(POR_A, 'POR26', 'Portugal'),
  ...mk(NOR, 'NOR', 'Norway'),
  ...mk(BRA, 'BRA', 'Brazil'),
  ...mk(KOR26, 'KOR26', 'Korea Republic'),
  ...mk(CZE, 'CZE', 'Czechia'),
  ...mk(ENG, 'ENG', 'England'),
  ...mk(ARG, 'ARG', 'Argentina'),
]

// ── 경기별 좌표 ─────────────────────────────────────────────────────
// 좌표는 여기 있지 않다. src/data/positions.json이 원본이다 —
// 게임의 "좌표 편집" 모드가 그 파일에 직접 쓰기 때문에, 여기 상수로 두면
// 편집한 값이 다음 생성 때 덮어써진다.
//
// 규칙(편집할 때 지켜야 하는 것): 피치는 120×80, home(공을 가진 팀)이 x=120
// 골문을 향해 공격한다. y가 클수록 공격 방향 기준 오른쪽. 크로스가 성립하려면
// 올리는 지점이 |y-40|≥18, 받는 지점이 x≥102여야 한다(K.CROSS).
// 각 맵의 키 = 그 시점에 실제로 그라운드에 있던 선수(교체·퇴장 반영).
const POSITIONS = JSON.parse(readFileSync(new URL('../src/data/positions.json', import.meta.url), 'utf-8')).positions
const posOf = (matchId) => {
  const p = POSITIONS[matchId]
  if (!p) throw new Error(`positions.json에 좌표가 없다: ${matchId}`)
  return p
}

const scenes = {
  _generator: 'scripts/build-scenes-2026.mjs — CSV가 갱신되면 재실행할 것',
  matches: [
    {
      match_id: 'kor_cze_2026_g1',
      title: '2026 북중미 월드컵 A조 1차전 — 대한민국 vs 체코',
      home: 'KOR26',
      away: 'CZE',
      actual: '대한민국 2 : 1 체코 (2026-06-11, 과달라하라)',
      // 그날 중계에서 한국은 화면 오른쪽에서 왼쪽으로 공격했다. 좌표는 엔진 규칙대로
      // (홈이 x=120으로 공격) 두고, 보드를 그릴 때만 좌우를 뒤집어 중계 화면과 맞춘다.
      viewFlipX: true,
      moments: [
        {
          id: 'm80_oh',
          minute: 80,
          score: [1, 1],
          situation:
            '80분. 59분 크레이치에게 먼저 실점해 끌려가다, 67분 이강인의 도움을 받은 황인범이 동점을 만들었다. 69분에 손흥민 대신 들어온 오현규가 최전방에 있다 — 생애 첫 월드컵, 투입 11분째다.',
          // 국내 보도가 확인해 주는 건 "황인범의 측면 크로스를 쇄도하던 오현규가 왼발로 밀어 넣었다"까지다.
          // 좌우 어느 쪽 측면인지는 기사에 없어 캡션에서도 특정하지 않는다.
          objective: '오현규에게 크로스를 배달하라',
          ball: 'k26_06',
          positions: posOf('kor_cze_2026_g1'),
          easterEgg: {
            passerId: 'k26_06',
            scorerId: 'k26_18',
            title: '그날, 진짜로 있었던 일',
            caption:
              '2026년 6월 11일 과달라하라. 동점골의 주인공 황인범이 이번엔 측면에서 크로스를 올렸고, 쇄도하던 오현규가 왼발로 밀어 넣었다. 손흥민 대신 들어와 11분 만에 터뜨린 생애 첫 월드컵 골이었다. 대한민국 2:1 체코 — 한국이 월드컵 조별리그 첫 경기를 이긴 건 16년 만이자 통산 네 번째였다.',
            images: [],
            video: { youtubeId: 'Bj1CFtGUOvc', start: 129, credit: 'KBS News' },
          },
        },
      ],
    },
    {
      match_id: 'por_esp_2026_r16',
      title: '2026 북중미 월드컵 16강 — 포르투갈 vs 스페인',
      home: 'ESP',
      away: 'POR26',
      actual: '포르투갈 0 : 1 스페인 (2026-07-06, 댈러스 스타디움)',
      // 그날 중계에서 스페인은 화면 오른쪽에서 왼쪽으로 공격했다. 좌표는 엔진 규칙대로
      // (홈이 x=120으로 공격) 두고, 보드를 그릴 때만 좌우를 뒤집어 중계 화면과 맞춘다.
      viewFlipX: true,
      moments: [
        {
          id: 'm901_merino',
          minute: 91,
          score: [0, 0],
          situation: '90+1분. 0-0, 연장이 눈앞. 85분에 들어온 교체 선수 둘이 마지막 기회를 만든다.',
          objective: '메리노를 골키퍼와 1대1로 만들어라',
          ball: 'esp_08',
          positions: posOf('por_esp_2026_r16'),
          easterEgg: {
            passerId: 'esp_07',
            scorerId: 'esp_06',
            title: '그날, 진짜로 있었던 일',
            caption:
              '짧게 내준 공이 파비안 루이스에서 로드리에게 돌아갔고, 로드리의 원터치가 멈춰 선 포르투갈 미드필드를 단번에 넘겨 페란 토레스에게 닿았다. 토레스가 백라인 사이로 찔러주자 투입 6분 된 메리노가 달려들어 논스톱으로, 낮게 포스트 안쪽으로 밀어 넣었다. 포르투갈 0:1 스페인 — 스페인은 2010년 우승 이후 첫 8강에 올랐고, 호날두는 여섯 번의 월드컵과 27경기를 그렇게 끝냈다.',
            images: [],
            video: { youtubeId: 'dN-d4TH-6Go', start: 133, credit: 'KBS News' },
            // 로드리를 거친 4터치다. 아래 자동 계산은 ball·passer·scorer 셋뿐이라
            // 3명까지밖에 못 만든다 — 경유자가 있는 장면은 여기에 직접 적는다.
            sequence: ['esp_08', 'esp_16', 'esp_07', 'esp_06'],
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
          situation:
            '79분. 5회 우승국 브라질과 28년 만에 월드컵으로 돌아온 노르웨이가 0-0으로 맞서 있다. 후반에 투입된 셸데루프가 왼쪽을 흔들기 시작했고, 홀란은 이 대회에서만 벌써 다섯 골을 넣었다.',
          objective: '홀란의 머리를 향해 왼쪽에서 띄워라',
          ball: 'nor_21',
          positions: posOf('bra_nor_2026_r16'),
          easterEgg: {
            passerId: 'nor_21',
            scorerId: 'nor_09',
            title: '그날, 진짜로 있었던 일',
            caption:
              '2026년 7월 5일 뉴저지. 셸데루프가 왼쪽에서 띄운 크로스를 홀란이 가브리에우 마갈량이스를 밀어내고 솟아올라 아래로 찍어 넣었다. 알리송이 몸을 던졌지만 닿지 않은 79분 선제골. 홀란은 90분에 다닐루 산투스의 다리 사이로 한 골을 더 넣었고 — 이번에도 셸데루프의 어시스트였다 — 네이마르의 90+10분 페널티는 이미 늦었다. 브라질 1:2 노르웨이, 노르웨이는 28년 만에 돌아온 월드컵에서 사상 첫 8강에 올랐다.',
            images: [],
            video: { youtubeId: 'A7DaVMZpeXg', start: 122, credit: 'KBS News' },
          },
        },
      ],
    },
    {
      match_id: 'eng_arg_2026_sf',
      title: '2026 북중미 월드컵 4강 — 잉글랜드 vs 아르헨티나',
      home: 'ARG',
      away: 'ENG',
      actual: '잉글랜드 1 : 2 아르헨티나 (2026-07-15, 애틀랜타)',
      moments: [
        {
          // 84:46 "De Paul control" 프레임을 그대로 옮긴 장면 — 엔소 동점골 직전이다.
          id: 'm85_enzo',
          minute: 85,
          score: [0, 1],
          situation:
            '85분, 0-1. 55분 로저스의 크로스를 고든이 뒷문에서 밀어넣은 뒤로 잉글랜드는 열한 명을 다 내려 세웠다. 81분에 탈리아피코를 빼고 라우타로까지 넣은 총공격 — 왼쪽에서 데 파울이 공을 잡았고, 박스 앞에 엔소 페르난데스가 혼자 서 있다.',
          objective: '엔소에게 중거리 슛 각을 열어줘라',
          ball: 'arg_07',
          positions: posOf('eng_arg_2026_sf'),
          easterEgg: {
            passerId: 'arg_10',
            scorerId: 'arg_24',
            title: '그날, 진짜로 있었던 일',
            caption:
              '2026년 7월 15일 애틀랜타. 밀어붙이던 아르헨티나가 메시를 거쳐 공을 뒤로 뺐고, 엔소 페르난데스가 박스 앞에서 그대로 감아 찼다. 85분 동점골 — 7분 뒤 라우타로의 역전 헤더까지, 잉글랜드의 결승행은 여기서부터 무너졌다.',
            images: [],
          },
        },
      ],
    },
    {
      match_id: 'arg_esp_2026_final',
      title: '2026 북중미 월드컵 결승 — 아르헨티나 vs 스페인',
      home: 'ESP',
      away: 'ARG',
      actual: '스페인 1 : 0 아르헨티나 (연장, 2026-07-19, 뉴저지 메트라이프 스타디움)',
      // 그날 중계 방향에 맞춘다 — 좌표는 엔진 규칙대로(홈이 x=120으로 공격) 두고,
      // 보드를 그릴 때만 좌우를 뒤집는다.
      viewFlipX: true,
      moments: [
        {
          id: 'm106_ferran',
          minute: 106,
          score: [0, 0],
          situation:
            '연장 후반 106분, 0-0. 93분에 엔소 페르난데스가 쿠바르시에게 무리한 태클로 퇴장당해 아르헨티나는 10명이다. 오른쪽 끝에서 라민 야말이 수비 둘을 벗기고 공을 잡았다. 포로가 오버래핑으로 붙고, 62분에 들어온 페란 토레스가 뒷문의 니코 윌리엄스 뒤로 파고든다.',
          objective: '포로의 크로스를 니코 윌리엄스의 머리로 페란 토레스에게 떨궈라',
          // 이 시점에 아르헨티나가 10명인 이유. verify.mjs가 "양 팀 11명" 검사를
          // 이 값만큼 깎아서 한다 — 좌표를 빠뜨린 것과 구분하기 위해 명시한다.
          sentOff: ['arg_24'],
          ball: 'esp_19',
          positions: posOf('arg_esp_2026_final'),
          easterEgg: {
            passerId: 'esp_17',
            scorerId: 'esp_07',
            title: '그날, 진짜로 있었던 일',
            caption:
              '2026년 7월 19일 뉴저지. 페드로 포로의 크로스를 니코 윌리엄스가 뒤로 떨궜고, 페란 토레스가 원터치로 골문 천장에 꽂았다. 스페인 1:0 — 사상 두 번째 월드컵 우승, 그리고 메시의 마지막 결승전.',
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
      'POR-ESP: 프리킥에서 빠르게 시작된 전개였는지는 ESPN 단독 서술이라 미확인. 현재는 오픈플레이로 배치했다.',
      'POR-ESP: 메리노 슛의 정확한 거리·각도, 85분 더블 교체 후 스페인의 실제 포지션 배열 미확인 (4-2-3-1 유지로 가정).',
      'BRA-NOR: 브라질 선발 11번째 선수 미확인(마르티넬리 추정). 현재 79분 기준 온피치로 다닐루 산투스(bra_18)를 넣었다.',
      'BRA-NOR: 79분 에데르송↔브루누 기마랑이스 교체가 골 앞인지 뒤인지 미확인. 교체가 골보다 먼저였다고 보고 에데르송(bra_02)을 온필드에 뒀다. 이 에데르송은 미드필더(아탈란타)로, CSV에 없어 스탯은 임의값이다.',
      'BRA-NOR: 홀란 헤더의 박스 안 정확한 지점 미확인.',
      'ESP 등번호 수정: 포로 2→12, 쿠바르시 5→22 (스페인축구협회 발표 번호 기준). 기존 esp_02/esp_05 id도 함께 바뀌었다.',
      'POR26 등번호 수정: 달로트 20→5, 베이가 14→13, 네베스 18→15, 콘세이상 11→26. id도 p26_05/p26_13/p26_15/p26_26으로 함께 바뀌었다. ' +
        '틀린 번호는 모두 이 경기에 선발로 나왔다 교체된 선수의 것이었다 — 20=칸셀루, 18=페드루 네투, 11=주앙 펠릭스. ' +
        'ESPN 라인업과 FPF 발표 번호 두 출처가 일치한다. 그 다섯(칸셀루·누누 멘드스·비티냐·페드루 네투·주앙 펠릭스)과 ' +
        '스페인의 다니 올모(10, 85분 메리노와 교체)를 로스터에 넣어 번호가 다시 밀리지 않게 했다.',
      'ARG: 결승 102분에 교체 투입된 세네시의 등번호가 출처마다 다르다. 협회 발표 번호 목록에는 2번이 발레르디로 돼 있으나 CSV 로스터·경기 리포트에는 세네시가 있다. 현재 세네시를 2번으로 뒀다.',
      'KOR-CZE: 크로스 지점과 오현규의 마무리 지점은 여전히 미확인이다. 라인업·교체 시각은 ESPN으로 확인했다.',
      'ENG-ARG: 90+2분 결승골 득점자를 라우타로 마르티네스로 뒀다. 일부 요약문이 엔소 페르난데스로 잘못 적고 있으나 Sky·ESPN 헤드라인은 라우타로다.',
      'ENG-ARG: 85분 장면 좌표는 84:46 "De Paul control" 프레임(105×68m)을 120×80으로 환산해 넣었다. 다음 두 값만 프레임에서 오지 않았다 — ' +
        '(1) 에밀리아노 마르티네스(arg_23)가 프레임에 아예 없어 기존 90+2분 장면의 (32, 40)을 그대로 뒀다. ' +
        '(2) 훌리안 알바레스의 x_m이 정확히 52.5(=105의 절반)로, 다른 값과 달리 딱 떨어져 미배치 기본값으로 의심된다. 일단 받은 값대로 환산해 넣었다(x=60.0).',
      'ESP-ARG: 포로 크로스 → 니코 윌리엄스 헤더 떨구기 → 페란 토레스 마무리의 3단 전개를, 엔진이 패스 1회만 다루므로 "니코 → 페란" 구간만 재현하도록 잘랐다.',
    ],
    // 한 번 확인해서 결론이 난 것들 — 나중에 같은 의문이 다시 올라오지 않도록 남긴다.
    confirmed: [
      'ARG-ESP 결승 106분 골: 실제 전개는 포로의 크로스 → 니코 윌리엄스 헤더 → 페란 토레스 마무리다(Yahoo). ' +
        '장면은 야말이 공을 잡은 데서 시작하도록 각색했다 — 야말의 크로스는 페란이 마르티네스 정면으로 헤더했다 막힌 별개의 기회였고 ' +
        '골 장면과는 다른 순간이다. 이스터에그(마지막 패스 니코 → 페란)는 실제 골 그대로다.',
      'ENG-ARG: 85분 장면에서 메시(x=114)가 잉글랜드 최후방 2번째(x=111.9)보다 앞이라 오프사이드 위치다. 버그가 아니라 받은 프레임 그대로다 ' +
        '(원본에서도 메시 99.72 > 잉글랜드 2번째 97.94). 실축에서도 공에 관여하지 않으면 반칙이 아니고, 엔진에서는 오프볼 런으로 메시를 내려 받으면 풀린다 — ' +
        '그 자체가 이 장면의 퍼즐이다.',
      'ENG-ARG: 엔소의 실제 골은 34m 중거리포이고 엔진의 34m 슛 확률은 하한인 2%다. 실제 전개를 그대로 재현하면 성공률이 1% 안팎에 묶인다. ' +
        '엔소를 23m까지 끌어올리면 5.1%가 되지만 그러면 "중거리포"가 아니게 된다. 이스터에그를 희귀 연출로 두는 선택이다.',
      'KOR-CZE: 이태석(13)은 이 경기에 뛰지 않았다. 로스터에 유일한 LB로 등록돼 있지만 온피치에서 빠진 것은 누락이 아니다. ' +
        '백라인이 이한범·김민재·이기혁의 백3에 설영우가 오른쪽 윙백, 엄지성이 왼쪽 높은 자리인 구조라 풀백 자리가 애초에 비어 있는 게 맞다.',
      'KOR-CZE: 80분 결승골을 헤더로 단정하지 않는다. 알자지라 기사가 확인해 주는 것은 황인범이 오른쪽에서 올린 크로스까지이고 ' +
        '("He then made the cross from the right flank for Oh Hyeon-gyu\'s decisive strike in the 80th minute."), 머리로 마무리했다는 서술은 어느 출처에도 없다. ' +
        'objective에서 "머리에"를 뺐다. 엔진의 헤더 판정은 데이터가 아니라 직전 패스의 크로스 기하로 자동 결정되므로(resolve.js의 isCrossGeometry) 판정·확률에는 영향이 없다.',
    ],
    sources: [
      'https://www.espn.com/soccer/commentary/_/gameId/760506',
      'https://www.espn.com/soccer/lineups/_/gameId/760506',
      'https://theanalyst.com/articles/portugal-vs-spain-stats-world-cup-round-of-16',
      'https://www.espn.com/soccer/commentary/_/gameId/760504',
      'https://www.espn.com/soccer/lineups/_/gameId/760504',
      'https://www.espn.com/soccer/lineups/_/gameId/760414',
      'https://www.espn.com/soccer/lineups/_/gameId/760441',
      'https://www.espn.com/soccer/lineups/_/gameId/760466',
      'https://www.espn.com/soccer/lineups/_/gameId/760515',
      'https://www.espn.com/soccer/lineups/_/gameId/760517',
      'https://www.aljazeera.com/sports/2026/6/12/south-korea-vs-czechia-world-cup-2026-oh-hyeon-gyu-hwang-in-beom',
      'https://www.cbssports.com/soccer/news/mexico-vs-south-korea-live-updates-world-cup-2026-score-result/live/',
      'https://theanalyst.com/articles/south-africa-vs-south-korea-stats-world-cup-2026',
      'https://www.skysports.com/football/england-vs-argentina/report/549867',
      'https://www.espn.com/soccer/story/_/id/49404214/spain-1-0-argentina-world-cup-2026-result-score-recap-ferran-torres-enzo-fernandez',
      'https://www.englandfootball.com/articles/2026/Jun/02/england-men-fifa-world-cup-2026-squad-numbers-revealed-20260206',
    ],
  },
}

const root = new URL('../src/data/', import.meta.url)
// 기존 players.json에 이어붙인다 (KOR/POR 2022 로스터는 그대로 유지).
// 여기서 만드는 팀은 통째로 갈아끼운다 — id로만 걸러내면 등번호를 고쳤을 때
// (예: 포로 esp_02 → esp_12) 옛 id가 유령으로 남는다.
const teams = new Set(players.map((p) => p.team))
const existing = JSON.parse(readFileSync(new URL('players.json', root), 'utf-8'))
const keep = existing.filter((p) => !teams.has(p.team))
// video는 위 장면 정의에 직접 넣어 뒀다 — scenes-2026.json은 통째로 다시 쓰이므로
// 생성기가 모르는 필드는 재생성 때 그대로 사라진다.
// 이스터에그 판정용 필드 (App.jsx eggMatched 참고):
//   sequence — 공을 주고받은 선수 순서. ball==passer면 [ball, scorer], 아니면 [ball, passer, scorer].
//              재료가 셋뿐이라 3명이 한계다. 그 사이를 거쳐 간 선수가 있으면(포르투갈-스페인의
//              로드리) 장면 정의에 직접 적고, 여기서는 건드리지 않는다.
//   shot     — 마지막 슛 위치 기준점 + 타원 허용 반경(rx·ry).
//              값은 egg-shots.json이 원본이다 (positions.json과 같은 자리) — 여기 박아두면
//              개발 모드에서 마커를 끌어 고친 값이 재생성 때 되돌아간다.
const EGG_SHOT = JSON.parse(readFileSync(new URL('../src/data/egg-shots.json', import.meta.url), 'utf-8')).shots
for (const s of scenes.matches) {
  const m = s.moments[0]
  const e = m.easterEgg
  if (!e) continue
  e.sequence ??= m.ball === e.passerId ? [m.ball, e.scorerId] : [m.ball, e.passerId, e.scorerId]
  // note는 사람이 읽는 메모라 화면 데이터로 내보내지 않는다
  const { note: _note, ...shot } = EGG_SHOT[s.match_id] ?? { x: 108, y: 42, rx: 12, ry: 8 }
  e.shot = shot
}

writeFileSync(new URL('players.json', root), JSON.stringify([...keep, ...players], null, 2) + '\n')
writeFileSync(new URL('scenes-2026.json', root), JSON.stringify(scenes, null, 2) + '\n')

console.log(`players.json: 기존 ${keep.length}명 + 신규 ${players.length}명`)
console.log(`scenes-2026.json: ${scenes.matches.length}경기`)
for (const m of scenes.matches) console.log(`  - ${m.title} (${m.moments.length} moment)`)
