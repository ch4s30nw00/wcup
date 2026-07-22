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
            const { matchId, positions } = JSON.parse(body)
            if (!matchId || !positions || typeof positions !== 'object') throw new Error('matchId/positions 누락')

            const store = read('./src/data/positions.json')
            if (!store.positions[matchId]) throw new Error(`모르는 경기: ${matchId}`)
            // 좌표만 갈아끼운다 — 명단(키 집합)이 바뀌면 안 된다.
            const known = Object.keys(store.positions[matchId]).sort().join()
            const incoming = Object.keys(positions).sort().join()
            if (known !== incoming) throw new Error('선수 명단이 원본과 다르다 — 저장을 거부한다')

            store.positions[matchId] = positions
            write('./src/data/positions.json', store)

            // 화면이 읽는 쪽도 같이
            if (matchId === 'kor_por_2022') {
              const scn = read('./src/data/scenarios.json')
              scn.moments[0].positions = positions
              write('./src/data/scenarios.json', scn)
            } else {
              const scenes = read('./src/data/scenes-2026.json')
              const m = scenes.matches.find((x) => x.match_id === matchId)
              if (!m) throw new Error(`scenes-2026.json에 없는 경기: ${matchId}`)
              m.moments[0].positions = positions
              write('./src/data/scenes-2026.json', scenes)
            }

            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: true, matchId, count: Object.keys(positions).length }))
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
  plugins: [react(), positionsWriter()],
})
