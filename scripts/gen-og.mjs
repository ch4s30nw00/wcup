// scripts/gen-og.mjs — 링크 미리보기(OG) 이미지 생성기.  실행: node scripts/gen-og.mjs
//
// 카카오톡·디스코드·트위터에 링크를 붙였을 때 뜨는 1200×630 썸네일(public/og.png)을 만든다.
// 제목·설명은 og:title / og:description 메타태그가 담당하므로 이미지는 "시각적 후크"만 맡는다
// → 폰트 렌더링이 필요 없고, 그래서 외부 의존성 0으로 만들 수 있다(node:zlib만 사용).
//
// 그림 내용: 실제 게임 보드와 같은 잔디·라인 위에 90+1 역습 전개
//           (손흥민 드리블 → 황희찬 패스 → 슛)를 그려 "이런 걸 그리는 게임"임을 한눈에 보인다.
//
// 좌표계는 게임과 동일한 120×80 피치. 단, 링크 미리보기는 작게 뜨므로 전체를 담지 않고
// **공격 진영으로 당겨서** 그린다(x 28~120) — 축소돼도 궤적과 선수가 읽힌다.

import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const W = 1200
const H = 630
const X0 = 28 // 이 x(미터)가 이미지 맨 왼쪽
const SCALE = W / (120 - X0) // 1m당 픽셀
const Y0 = 40 - H / SCALE / 2 // 세로는 피치 중앙 기준으로 잘라낸다
const px = (x) => (x - X0) * SCALE
const py = (y) => (y - Y0) * SCALE

const buf = Buffer.alloc(W * H * 3)

const setPx = (x, y, [r, g, b], a = 1) => {
  x = Math.round(x)
  y = Math.round(y)
  if (x < 0 || y < 0 || x >= W || y >= H) return
  const i = (y * W + x) * 3
  buf[i] = buf[i] * (1 - a) + r * a
  buf[i + 1] = buf[i + 1] * (1 - a) + g * a
  buf[i + 2] = buf[i + 2] * (1 - a) + b * a
}
const fillRect = (x, y, w, h, c) => {
  for (let j = Math.max(0, Math.round(y)); j < Math.min(H, Math.round(y + h)); j++)
    for (let i = Math.max(0, Math.round(x)); i < Math.min(W, Math.round(x + w)); i++) setPx(i, j, c)
}
// 굵기 있는 선 — 선분 주변을 훑으며 거리로 안티에일리어싱
const line = (x1, y1, x2, y2, c, thick = 3) => {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const steps = Math.ceil(len * 2)
  for (let s = 0; s <= steps; s++) {
    const t = s / steps
    const cx = x1 + dx * t
    const cy = y1 + dy * t
    const r = thick / 2
    for (let j = -Math.ceil(r); j <= Math.ceil(r); j++)
      for (let i = -Math.ceil(r); i <= Math.ceil(r); i++) {
        const d = Math.hypot(i, j)
        if (d <= r) setPx(cx + i, cy + j, c, Math.min(1, r - d + 0.5))
      }
  }
}
const circle = (cx, cy, r, c, fill = true, thick = 3) => {
  for (let j = -Math.ceil(r) - 2; j <= Math.ceil(r) + 2; j++)
    for (let i = -Math.ceil(r) - 2; i <= Math.ceil(r) + 2; i++) {
      const d = Math.hypot(i, j)
      const a = fill ? Math.min(1, r - d + 0.5) : Math.min(1, thick / 2 - Math.abs(d - r) + 0.5)
      if (a > 0) setPx(cx + i, cy + j, c, a)
    }
}
const rectOutline = (x, y, w, h, c, thick = 3) => {
  line(x, y, x + w, y, c, thick)
  line(x + w, y, x + w, y + h, c, thick)
  line(x + w, y + h, x, y + h, c, thick)
  line(x, y + h, x, y, c, thick)
}
// 2차 베지어 (게임의 궤적과 같은 곡선)
const quad = (a, cp, b, c, thick = 5) => {
  let prev = a
  for (let s = 1; s <= 60; s++) {
    const t = s / 60
    const u = 1 - t
    const p = {
      x: u * u * a.x + 2 * u * t * cp.x + t * t * b.x,
      y: u * u * a.y + 2 * u * t * cp.y + t * t * b.y,
    }
    line(prev.x, prev.y, p.x, p.y, c, thick)
    prev = p
  }
}
// 화살촉
const arrow = (from, to, c, size = 13) => {
  const ang = Math.atan2(to.y - from.y, to.x - from.x)
  const wing = 2.5
  for (const s of [ang + wing, ang - wing]) line(to.x, to.y, to.x + Math.cos(s) * size, to.y + Math.sin(s) * size, c, 5)
}

// ── 색 (게임 화면과 동일) ──
const GRASS = [47, 125, 63]
const GRASS_ALT = [42, 115, 57]
const LINE_C = [230, 242, 230]
const KOR = [200, 16, 46]
const POR = [30, 58, 110]
const PASS_C = [255, 210, 62]
const MOVE_C = [219, 228, 242]
const SHOT_C = [255, 107, 94]
const WHITE = [255, 255, 255]
const DARK = [16, 20, 28]

// ── 잔디 + 라인 ──
fillRect(0, 0, W, H, GRASS)
for (let i = 0; i < 10; i += 2) fillRect(px(i * 12), 0, px(i * 12 + 12) - px(i * 12), H, GRASS_ALT)

line(px(60), py(0), px(60), py(80), LINE_C) // 하프라인
circle(px(60), py(40), px(69.15) - px(60), LINE_C, false)
circle(px(60), py(40), 5, LINE_C)
line(px(119), py(0), px(119), py(80), LINE_C) // 골라인
rectOutline(px(102), py(18), px(119) - px(102), py(62) - py(18), LINE_C)
rectOutline(px(113.5), py(30), px(119) - px(113.5), py(50) - py(30), LINE_C)
circle(px(107), py(40), 5, LINE_C) // 페널티 마크
// 상대 골문
fillRect(px(119), py(36.34), px(120) - px(119), py(43.66) - py(36.34), DARK)

// ── 전개: 90+1 역습 (드리블 → 패스 → 슛) ──
const P = (x, y) => ({ x: px(x), y: py(y) })
const son = P(40, 32)
const dribEnd = P(78, 35)
const hwang = P(103, 47)
const goal = P(118, 40)

quad(son, P(59, 30), dribEnd, MOVE_C, 6)
arrow(P(70, 32.6), dribEnd, MOVE_C, 16)
quad(dribEnd, P(90, 38), hwang, PASS_C, 7)
arrow(P(97, 44), hwang, PASS_C, 17)
quad(hwang, P(111, 43), goal, SHOT_C, 7)
arrow(P(115, 41.5), goal, SHOT_C, 17)

// ── 수비 (포르투갈) ──
for (const [x, y] of [[66, 42], [90, 28], [95, 55], [82, 59], [113.5, 40]]) {
  circle(px(x), py(y), 17, POR)
  circle(px(x), py(y), 17, WHITE, false, 3)
}
// ── 아군 (대한민국) — 전개에 참여하는 선수 ──
for (const [x, y] of [[40, 32], [103, 47], [72, 60]]) {
  circle(px(x), py(y), 18, KOR)
  circle(px(x), py(y), 18, WHITE, false, 3)
}
// ── 공 (드리블이 끝나 패스가 떠나는 지점) ──
circle(dribEnd.x + 13, dribEnd.y - 13, 10, WHITE)
circle(dribEnd.x + 13, dribEnd.y - 13, 10, DARK, false, 2)

// ── 가장자리 비네트 + 하단 브랜드 바 (썸네일에서 테두리가 또렷해진다) ──
for (let y = H - 90; y < H; y++) {
  const a = ((y - (H - 90)) / 90) ** 1.7 * 0.6
  for (let x = 0; x < W; x++) setPx(x, y, DARK, a)
}
for (let y = 0; y < 70; y++) {
  const a = (1 - y / 70) ** 1.7 * 0.45
  for (let x = 0; x < W; x++) setPx(x, y, DARK, a)
}
fillRect(0, H - 9, W, 9, PASS_C)

// ── PNG 인코딩 (node:zlib만 사용) ──
const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
const crc32 = (b) => {
  let c = -1
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 2 // color type: truecolor RGB
// 스캔라인마다 필터 바이트(0 = None)를 앞에 붙인다
const raw = Buffer.alloc(H * (W * 3 + 1))
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0
  buf.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

const out = new URL('../public/og.png', import.meta.url)
writeFileSync(out, png)
console.log(`og.png 생성 완료 — ${W}×${H}, ${(png.length / 1024).toFixed(0)}KB`)
