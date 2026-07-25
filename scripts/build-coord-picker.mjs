// scripts/build-coord-picker.mjs — 좌표 피커가 읽을 데이터 파일을 만든다.
//   node scripts/build-coord-picker.mjs
//
// 왜 있는가: 장면 좌표는 중계 영상을 보고 사람이 찍어야 한다(공개 위치추적 API가 없다).
// 숫자를 손으로 세는 대신 docs/coord-picker.html에서 선수를 끌어다 놓고,
// 나온 결과를 build-scenes-2026.mjs의 POS_* 상수에 붙여넣는 흐름을 쓴다.
//
// 피커는 file://로 그냥 열리는 정적 페이지다. file:// 에서는 fetch가 막히므로
// JSON을 가져오지 못한다 — 그래서 데이터를 <script>로 읽을 수 있는 .js에 담는다.

import { readFileSync, writeFileSync } from 'node:fs'

const root = new URL('../src/data/', import.meta.url)
const read = (f) => JSON.parse(readFileSync(new URL(f, root), 'utf-8'))

const players = read('players.json')
const matches = [read('scenarios.json'), ...read('scenes-2026.json').matches]

// 붙여넣을 대상 상수 이름. build-scenes-2026.mjs에 실제로 있는 것만 적는다 —
// 없으면 피커가 match_id로 이름을 지어내고 "직접 확인" 주석을 붙인다.
const CONST_NAME = {
  kor_cze_2026_g1: 'POS_KOR_CZE',
  kor_mex_2026_g2: 'POS_KOR_MEX',
  kor_rsa_2026_g3: 'POS_KOR_RSA',
  eng_arg_2026_sf: 'POS_ARG_ENG',
  arg_esp_2026_final: 'POS_ESP_ARG',
}

const byId = Object.fromEntries(players.map((p) => [p.id, p]))

const data = {
  generatedAt: new Date().toISOString().slice(0, 10),
  matches: matches.map((m) => {
    const moment = m.moments[0]
    const ids = Object.keys(moment.positions ?? {})
    const missing = ids.filter((id) => !byId[id])
    if (missing.length) throw new Error(`${m.match_id}: players.json에 없는 id — ${missing.join(', ')}`)
    return {
      id: m.match_id,
      title: m.title,
      home: m.home,
      away: m.away,
      constName: CONST_NAME[m.match_id] ?? null,
      // 16강 2경기는 POS_* 없이 배열의 x/y를 쓰고 있어 붙여넣을 상수가 없다.
      // 그런 경기는 피커에서 읽기 전용 참고용으로만 열린다.
      minute: moment.minute,
      situation: moment.situation,
      ball: moment.ball,
      players: ids.map((id) => ({
        id,
        name: byId[id].name,
        number: byId[id].number,
        team: byId[id].team,
        pos: byId[id].position,
        x: moment.positions[id].x,
        y: moment.positions[id].y,
      })),
    }
  }),
}

const out = new URL('../docs/coord-picker-data.js', import.meta.url)
writeFileSync(out, `// 자동 생성 — scripts/build-coord-picker.mjs\nwindow.PICKER_DATA = ${JSON.stringify(data, null, 2)}\n`)

console.log(`docs/coord-picker-data.js: ${data.matches.length}경기`)
for (const m of data.matches) {
  const tag = m.constName ?? '(붙여넣을 상수 없음 — 참고용)'
  console.log(`  - ${m.id.padEnd(20)} ${String(m.players.length).padStart(2)}명  ${tag}`)
}
