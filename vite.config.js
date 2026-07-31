import { readFileSync, writeFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 좌표 편집 모드(개발 전용)가 저장을 누르면 여기로 POST가 온다.
// 왜 서버가 필요한가: 장면 좌표는 중계 영상을 보고 사람이 찍어야 하는데,
// 브라우저는 파일을 못 쓴다. 클립보드로 옮겨 붙이는 건 22명 × 8경기라 실수가 난다.
//
// 원본은 src/data/positions.json이다. 화면이 실제로 읽는 파일(scenes-2026.json /
// scenarios.json)도 같이 고쳐 HMR로 즉시 반영되게 한다 — 둘 다 생성물이라
// `npm run scenes`를 다시 돌려도 positions.json에서 같은 결과가 나온다.
//
// apply: 'serve'라 프로덕션 빌드에는 존재하지 않는다.
function positionsWriter() {
  const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf-8'))
  const write = (p, v) => writeFileSync(new URL(p, import.meta.url), JSON.stringify(v, null, 2) + '\n')

  return {
    name: 'positions-writer',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__positions', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end('POST only')
        }
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          try {
            const { matchId, positions, ballOwnerId } = JSON.parse(body)
            if (!matchId || !positions || typeof positions !== 'object') throw new Error('matchId/positions 누락')

            const store = read('./src/data/positions.json')
            if (!store.positions[matchId]) throw new Error(`모르는 경기: ${matchId}`)
            // 좌표만 갈아끼운다 — 명단(키 집합)이 바뀌면 안 된다.
            const known = Object.keys(store.positions[matchId]).sort().join()
            const incoming = Object.keys(positions).sort().join()
            if (known !== incoming) throw new Error('선수 명단이 원본과 다르다 — 저장을 거부한다')
            if (ballOwnerId && !positions[ballOwnerId]) throw new Error('공 소유자가 온필드 명단에 없다')

            store.positions[matchId] = positions
            store.ballOwners = { ...(store.ballOwners ?? {}), ...(ballOwnerId ? { [matchId]: ballOwnerId } : {}) }
            write('./src/data/positions.json', store)

            // 화면이 읽는 쪽도 같이. 경기마다 파일이 다르다 — 손으로 쓴 과거 명경기는
            // 각자 파일에, CSV 생성 2026 경기는 scenes-2026.json 안에 들어있다.
            const SOLO_FILE = {
              kor_por_2022: './src/data/scenarios.json',
              kor_ita_2002: './src/data/kor_ita_2002.json',
              kor_ger_2018: './src/data/kor_ger_2018.json',
            }
            if (SOLO_FILE[matchId]) {
              const scn = read(SOLO_FILE[matchId])
              scn.moments[0].positions = positions
              if (ballOwnerId) scn.moments[0].ball = ballOwnerId
              write(SOLO_FILE[matchId], scn)
            } else {
              const scenes = read('./src/data/scenes-2026.json')
              const m = scenes.matches.find((x) => x.match_id === matchId)
              if (!m) throw new Error(`scenes-2026.json에 없는 경기: ${matchId}`)
              m.moments[0].positions = positions
              if (ballOwnerId) m.moments[0].ball = ballOwnerId
              write('./src/data/scenes-2026.json', scenes)
            }

            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: true, matchId, count: Object.keys(positions).length, ballOwnerId }))
          } catch (e) {
            res.statusCode = 400
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: String(e.message ?? e) }))
          }
        })
      })
    },
  }
}

// 재현 구역(이스터에그 슛 지점)을 고치면 여기로 POST가 온다.
// positionsWriter와 같은 구조다 — 원본은 src/data/egg-shots.json이고,
// 화면이 읽는 파일에도 같은 값을 복사해 HMR로 즉시 반영한다.
//
// 왜 서버가 필요한가: 슛 지점은 경기 영상을 보며 사람이 찍는 값이라 화면에서 끌어
// 옮기는 게 가장 정확한데, 브라우저는 파일을 못 쓴다. 값만 읽어 손으로 옮겨 적으면
// 영상 보다가 흐름이 끊기고 오타가 난다.
//
// apply: 'serve'라 프로덕션 빌드에는 존재하지 않는다.
function eggShotWriter() {
  const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf-8'))
  const write = (p, v) => writeFileSync(new URL(p, import.meta.url), JSON.stringify(v, null, 2) + '\n')

  return {
    name: 'egg-shot-writer',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__eggshot', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end('POST only')
        }
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          try {
            const { matchId, shot } = JSON.parse(body)
            if (!matchId || !shot) throw new Error('matchId/shot 누락')
            const num = (v, name) => {
              if (!Number.isFinite(v)) throw new Error(`${name}이 숫자가 아니다`)
              return v
            }
            // 피치 밖 좌표나 0 반경이 저장되면 판정이 조용히 망가진다 — 여기서 막는다.
            const x = num(shot.x, 'x')
            const y = num(shot.y, 'y')
            if (x < 0 || x > 120 || y < 0 || y > 80) throw new Error('좌표가 피치(120x80) 밖이다')
            const rx = num(shot.rx, 'rx')
            const ry = num(shot.ry, 'ry')
            if (rx < 1 || ry < 1) throw new Error('반경이 너무 작다 (1m 이상)')

            const store = read('./src/data/egg-shots.json')
            const prev = store.shots[matchId]
            if (!prev) throw new Error(`모르는 경기: ${matchId}`)
            // note는 사람이 쓴 메모다 — 좌표를 고쳐도 지우지 않는다.
            store.shots[matchId] = { x, y, rx, ry, ...(prev.note ? { note: prev.note } : {}) }
            write('./src/data/egg-shots.json', store)

            // 화면이 읽는 쪽에도 복사. note는 표시용 데이터가 아니라 빼고 넣는다.
            const SOLO_FILE = {
              kor_por_2022: './src/data/scenarios.json',
              kor_ita_2002: './src/data/kor_ita_2002.json',
              kor_ger_2018: './src/data/kor_ger_2018.json',
            }
            if (SOLO_FILE[matchId]) {
              const scn = read(SOLO_FILE[matchId])
              scn.moments[0].easterEgg.shot = { x, y, rx, ry }
              write(SOLO_FILE[matchId], scn)
            } else {
              const scenes = read('./src/data/scenes-2026.json')
              const m = scenes.matches.find((s) => s.match_id === matchId)
              if (!m) throw new Error(`scenes-2026.json에 없는 경기: ${matchId}`)
              m.moments[0].easterEgg.shot = { x, y, rx, ry }
              write('./src/data/scenes-2026.json', scenes)
            }

            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: true, matchId, shot: { x, y, rx, ry } }))
          } catch (e) {
            res.statusCode = 400
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: String(e.message ?? e) }))
          }
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), positionsWriter(), eggShotWriter()],
})
