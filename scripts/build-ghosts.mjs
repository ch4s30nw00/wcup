// scripts/build-ghosts.mjs — StatsBomb 공개 데이터에서 "유령 좌표"를 뽑는다.
//   node scripts/build-ghosts.mjs
//
// 왜 필요한가: 장면 좌표는 사람이 중계 화면을 보고 찍는다. 그런데 눈대중이라
// 오차가 생기고, 좌표 오차는 판정을 크게 흔든다(scripts/coord-sensitivity.mjs 참고 —
// ±3m면 상대 86명 중 62명의 판정이 2%p 이상 바뀐다).
//
// StatsBomb 공개 데이터에는 그 순간의 실측 좌표가 일부 들어 있다. 다만 전부는 아니다:
//   · 이벤트의 location  — 공을 만진 선수 1명. 이름 있음. 정확함.
//   · shot.freeze_frame  — 슛 순간에만. 이름 있음. 화면에 보인 선수만(보통 12명 안팎).
//   · 360 freeze frame   — 거의 모든 이벤트. **이름 없음**(teammate/actor/keeper뿐).
//                          화면에 보인 선수만이라 8~20명으로 들쭉날쭉하다.
// 그래서 이 데이터로 좌표를 자동 생성할 수는 없다. 사람이 찍되 **맞춰볼 기준점**으로 쓴다.
//
// 좌표는 StatsBomb 원본 그대로 저장한다 — y축을 뒤집을지 말지는 화면에서 켜고 끈다.
// 우리 보드와 StatsBomb의 y 방향이 같은지가 아직 확정이 아니라서, 판단을 사람에게 남긴다.
//
// 주의: StatsBomb은 이벤트를 **그 이벤트를 기록한 팀이 x=120으로 공격하는 좌표계**로
// 적는다. 아래 프레임은 전부 한국 이벤트라 우리 보드와 x 방향이 이미 같다.
// 다른 경기를 추가할 땐 상대팀 이벤트를 고르지 않도록 주의할 것 (필요하면 120-x, 80-y).

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'

const CACHE = new URL('../.statsbomb-cache/', import.meta.url)
const RAW = 'https://raw.githubusercontent.com/statsbomb/open-data/master/data'

// 뽑을 프레임. minute/second는 StatsBomb 시계 기준.
const PLAN = {
  kor_por_2022: {
    sbMatch: 3857262,
    source: 'StatsBomb open data · 2022 WC · match 3857262',
    frames: [
      { id: 'pre', label: '90:16 김문환 걷어냄 (4초 전)', minute: 90, second: 16, type: 'Clearance' },
      { id: 'now', label: '90:20 손흥민 볼 회수 (이 순간)', minute: 90, second: 20, type: 'Ball Recovery' },
      { id: 'shot', label: '90:28 황희찬 슛 (8초 뒤 · 이름 있음)', minute: 90, second: 28, type: 'Shot' },
    ],
  },
}

async function grab(path) {
  if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true })
  const file = new URL(path.replaceAll('/', '_'), CACHE)
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf-8'))
  process.stdout.write(`  내려받는 중 ${path} … `)
  const res = await fetch(`${RAW}/${path}`)
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
  const json = await res.json()
  writeFileSync(file, JSON.stringify(json))
  console.log('완료')
  return json
}

const out = { _note: '', matches: {} }
out._note =
  'StatsBomb 공개 데이터에서 뽑은 실측 기준점(유령). 좌표는 StatsBomb 원본 그대로다 — ' +
  'y 뒤집기는 보드에서 켜고 끈다. 자동 생성용이 아니라 손으로 찍을 때 대조하는 용도. ' +
  '만든 방법은 scripts/build-ghosts.mjs 참고.'

for (const [matchId, cfg] of Object.entries(PLAN)) {
  console.log(`■ ${matchId} (StatsBomb ${cfg.sbMatch})`)
  const events = await grab(`events/${cfg.sbMatch}.json`)
  let frames360 = []
  try {
    frames360 = await grab(`three-sixty/${cfg.sbMatch}.json`)
  } catch {
    console.log('  360 데이터 없음 — 이름 있는 프레임만 쓴다')
  }
  const by360 = new Map(frames360.map((f) => [f.event_uuid, f]))

  const sets = []
  for (const spec of cfg.frames) {
    const e = events.find(
      (ev) => ev.minute === spec.minute && ev.second === spec.second && ev.type.name === spec.type,
    )
    if (!e) {
      console.log(`  ✗ ${spec.label} — 이벤트를 못 찾음`)
      continue
    }
    // 공을 만진 선수는 언제나 이름과 정확한 좌표가 있다.
    const named = [{ x: e.location[0], y: e.location[1], side: 'home', name: e.player.name, actor: true }]
    for (const p of e.shot?.freeze_frame ?? [])
      named.push({
        x: p.location[0],
        y: p.location[1],
        side: p.teammate ? 'home' : 'away',
        name: p.player.name,
        role: p.position?.name,
      })
    // 이름 있는 프레임이 없을 때만 익명 360으로 메운다 — 둘을 겹치면 같은 사람이 두 번 뜬다.
    const anon = []
    if (named.length === 1)
      for (const p of by360.get(e.id)?.freeze_frame ?? []) {
        if (p.actor) continue // 이미 named에 있다
        anon.push({ x: p.location[0], y: p.location[1], side: p.teammate ? 'home' : 'away', keeper: !!p.keeper })
      }
    sets.push({ id: spec.id, label: spec.label, named, anon })
    console.log(`  ✓ ${spec.label} — 이름 ${named.length}명 + 익명 ${anon.length}명`)
  }
  out.matches[matchId] = { source: cfg.source, sets }
}

const dest = new URL('../src/data/ghosts.json', import.meta.url)
writeFileSync(dest, JSON.stringify(out, null, 2) + '\n')
console.log(`\nsrc/data/ghosts.json 기록 완료`)
