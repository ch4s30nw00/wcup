// scripts/build-stats.mjs — 선수 능력치를 우리 템플릿으로 산출한다.
//   node scripts/build-stats.mjs          (덮어쓰기)
//   node scripts/build-stats.mjs --dry    (미리보기만)
//
// 왜 이 파일이 있는가
// ------------------
// 능력치는 "사실"이 아니라 평가다. 그래서 남의 평가표를 가져다 쓰면 그건 남의 저작물이고,
// 대회 규정도 "선수·팀·경기 데이터는 더미 데이터를 직접 구성하여 사용하는 것을 권장"한다.
// 이 스크립트는 능력치를 **외부 자료 없이** 만든다. 입력은 셋뿐이다:
//
//   1) roles[0]  — 역할 (공식 라인업에서 나오는 사실)
//   2) overall   — 이 선수가 대략 어느 급인가 (우리가 매긴 한 자리 숫자)
//   3) heightCm  — 신장 (사실)
//
// 산식은 kor_ita_2002 / kor_ger_2018 두 경기의 66명을 손으로 만들 때 쓴 방식을
// 그대로 명문화한 것이다(커밋 afd0aba: "포지션 템플릿 + 종합력 스케일"). 그때는 사람이
// 머릿속으로 하던 걸 여기서는 표로 고정해, 누가 돌려도 같은 값이 나오게 했다.
//
//   능력치 = 기준값(역할) + 기울기(역할, 능력치) × (overall − 76) + 신장보정
//
// 기준값과 기울기는 그 66명에 최소제곱을 걸어 얻은 값을 반올림하고, 표본이 얇거나
// 잡음이 큰 항목(예: DM 7명에서 나온 finishing 기울기)은 축구 상식으로 눌러 정리했다.
//
// 기울기가 능력치마다 다른 이유: 잘하는 공격수는 결정력이 크게 오르지만 태클은 거의
// 그대로다. 역할의 핵심 능력치만 가파르게 오르고 나머지는 완만하게 따라 오른다.

import { readFileSync, writeFileSync } from 'node:fs'

const FILE = new URL('../src/data/players.json', import.meta.url)
const REF = 76 // 기준 overall. 이 값에서 BASE가 그대로 나온다.

const KEYS = [
  'flair', 'finishing', 'dribbling', 'longshots', 'crossing', 'passing', 'heading', 'strength',
  'acceleration', 'pace', 'jumping', 'balance', 'marking', 'tackle', 'positioning', 'anticipation',
]

// roles[0] → 원형. 겸업 선수는 첫 역할을 따른다(손흥민 ['LW','ST'] → W).
const ARCH = {
  GK: 'GK', CB: 'CB', LB: 'FB', RB: 'FB',
  DM: 'DM', CM: 'CM', CAM: 'AM', AM: 'AM',
  LW: 'W', RW: 'W', ST: 'ST',
}

// overall 76에서의 기준값.
const BASE = {
  GK: { flair: 8, finishing: 2, dribbling: 4, longshots: 3, crossing: 3, passing: 9, heading: 8, strength: 12, acceleration: 9, pace: 9, jumping: 13, balance: 12, marking: 2, tackle: 3, positioning: 14, anticipation: 14 },
  CB: { flair: 6, finishing: 5, dribbling: 7, longshots: 5, crossing: 6, passing: 11, heading: 14, strength: 15, acceleration: 10, pace: 11, jumping: 13, balance: 11, marking: 14, tackle: 14, positioning: 13, anticipation: 12 },
  FB: { flair: 10, finishing: 6, dribbling: 12, longshots: 8, crossing: 13, passing: 12, heading: 8, strength: 11, acceleration: 14, pace: 14, jumping: 9, balance: 12, marking: 11, tackle: 12, positioning: 11, anticipation: 11 },
  DM: { flair: 9, finishing: 8, dribbling: 10, longshots: 11, crossing: 9, passing: 14, heading: 11, strength: 13, acceleration: 10, pace: 10, jumping: 10, balance: 12, marking: 13, tackle: 14, positioning: 13, anticipation: 13 },
  CM: { flair: 12, finishing: 10, dribbling: 12, longshots: 13, crossing: 12, passing: 14, heading: 9, strength: 11, acceleration: 11, pace: 12, jumping: 8, balance: 12, marking: 9, tackle: 11, positioning: 11, anticipation: 13 },
  AM: { flair: 14, finishing: 12, dribbling: 14, longshots: 13, crossing: 12, passing: 15, heading: 8, strength: 8, acceleration: 13, pace: 13, jumping: 7, balance: 14, marking: 5, tackle: 6, positioning: 11, anticipation: 13 },
  W: { flair: 14, finishing: 12, dribbling: 15, longshots: 11, crossing: 14, passing: 12, heading: 7, strength: 8, acceleration: 16, pace: 15, jumping: 8, balance: 14, marking: 5, tackle: 6, positioning: 10, anticipation: 11 },
  ST: { flair: 12, finishing: 14, dribbling: 13, longshots: 12, crossing: 8, passing: 10, heading: 14, strength: 14, acceleration: 14, pace: 14, jumping: 13, balance: 12, marking: 4, tackle: 5, positioning: 13, anticipation: 14 },
}

// overall 1점당 상승폭. 적지 않은 능력치는 DEFAULT_SLOPE를 쓴다.
const DEFAULT_SLOPE = { GK: 0.16, CB: 0.18, FB: 0.20, DM: 0.18, CM: 0.15, AM: 0.16, W: 0.21, ST: 0.20 }
const SLOPE = {
  GK: { passing: 0.42, heading: 0.45, strength: 0.25, positioning: 0.34, anticipation: 0.40 },
  CB: { passing: 0.42, heading: 0.30, strength: 0.41, pace: 0.23, marking: 0.27, tackle: 0.33, positioning: 0.56, anticipation: 0.37 },
  FB: { dribbling: 0.43, crossing: 0.27, passing: 0.27, acceleration: 0.31, marking: 0.21, tackle: 0.25, anticipation: 0.29 },
  DM: { passing: 0.30, longshots: 0.25, strength: 0.29, marking: 0.25, tackle: 0.29, positioning: 0.43, anticipation: 0.43 },
  CM: { flair: 0.22, dribbling: 0.42, longshots: 0.25, passing: 0.33, anticipation: 0.32 },
  AM: { flair: 0.40, finishing: 0.51, dribbling: 0.23, longshots: 0.39, passing: 0.38, positioning: 0.24, anticipation: 0.19 },
  W: { finishing: 0.38, dribbling: 0.25, longshots: 0.35, crossing: 0.43, acceleration: 0.35, balance: 0.19 },
  ST: { flair: 0.26, finishing: 0.37, dribbling: 0.34, balance: 0.26, positioning: 0.37, anticipation: 0.44 },
}

// 신장 보정. 큰 선수는 공중에서 유리하고 잔발이 무겁다 — 축구에서 늘 쓰는 상식이다.
// z = (키 − 역할 표준키) / 6, [-2, 2]로 자른다.
const REF_H = { GK: 188, CB: 186, FB: 179, DM: 182, CM: 179, AM: 176, W: 177, ST: 183 }
const H_SENS = { heading: 0.9, jumping: 0.9, strength: 0.6, balance: -0.5, acceleration: -0.4, dribbling: -0.3, pace: -0.2 }

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// 반올림 경계를 선수·능력치마다 다르게 잡는다(결정론적 디더링).
//
// 왜 필요한가: 기울기가 0.2 근처라 overall 1점 차이(≈0.2)가 반올림에 통째로 삼켜진다.
// 그러면 같은 역할·비슷한 키에 평가가 1점 다른 두 선수가 16개 능력치 전부 똑같이 나온다
// (황희찬 77 vs 엄지성 76이 실제로 그랬다). 반올림 문턱을 0.5 고정이 아니라 선수마다
// 다른 값으로 두면, 그 0.2가 "누군가는 올라가고 누군가는 안 올라가는" 차이로 살아난다.
// 문턱이 [0,1)에 고르게 퍼지므로 팀 전체로 보면 기댓값은 그대로다 — 값을 부풀리지 않는다.
// id와 능력치 이름만으로 정해지므로 몇 번을 돌려도 같은 결과가 나온다.
function dither(id, key) {
  let h = 2166136261
  for (const s of `${id}:${key}`) {
    h ^= s.charCodeAt(0)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 1000) / 1000
}

export function archetypeOf(player) {
  const a = ARCH[player.roles?.[0]]
  if (!a) throw new Error(`${player.id}: 알 수 없는 역할 ${JSON.stringify(player.roles)}`)
  return a
}

export function buildStats(player) {
  const a = archetypeOf(player)
  const base = BASE[a]
  const dOv = (player.overall ?? REF) - REF
  const z = clamp(((player.heightCm ?? REF_H[a]) - REF_H[a]) / 6, -2, 2)
  const out = {}
  for (const k of KEYS) {
    const slope = SLOPE[a][k] ?? DEFAULT_SLOPE[a]
    const raw = base[k] + slope * dOv + (H_SENS[k] ?? 0) * z
    out[k] = clamp(Math.floor(raw + dither(player.id, k)), 1, 20)
  }
  return out
}

// --- 실행 -------------------------------------------------------------------
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const dry = process.argv.includes('--dry')
  const players = JSON.parse(readFileSync(FILE, 'utf-8'))

  let changed = 0
  let worst = { d: -1 }
  const byArch = {}
  for (const p of players) {
    const next = buildStats(p)
    const a = archetypeOf(p)
    byArch[a] = (byArch[a] ?? 0) + 1
    let d = 0
    for (const k of KEYS) d = Math.max(d, Math.abs(next[k] - (p.stats?.[k] ?? 0)))
    if (d > 0) changed++
    if (d > worst.d) worst = { d, name: p.name, id: p.id, arch: a }
    p.stats = next
  }

  console.log(`선수 ${players.length}명 · 원형별`, byArch)
  console.log(`능력치가 바뀐 선수 ${changed}명 · 최대 변동 ${worst.d} (${worst.name} ${worst.id} ${worst.arch})`)

  if (dry) {
    console.log('--dry 이므로 저장하지 않았다.')
  } else {
    writeFileSync(FILE, `${JSON.stringify(players, null, 2)}\n`, 'utf-8')
    console.log('src/data/players.json 저장 완료')
  }
}
