# ⚽ 터치라인 — "당신이 히딩크였다면?"

DAKER 월간 해커톤 「내가 축구 감독이라면 — 월드컵 전술 웹서비스 챌린지」 출품작.

실제 월드컵 명경기의 결정적 순간으로 돌아가, 전술보드 위에서 드리블·패스·슛·오프볼 런을
직접 설계하고 그 전개가 성공했을지를 확률 엔진으로 판정받는 웹 게임입니다.
백엔드 없는 클라이언트 완결형(Vite + React + SVG)이고, 시드 PRNG라 같은 링크(`?seed=`)면
누구에게나 같은 결과가 재현됩니다.

## 실행

```bash
npm install
npm run dev      # 개발 서버
npm run build    # 배포 빌드
npm run lint     # oxlint
```

## 프로젝트 구조

```
src/
├── data/                  ← 데이터 담당 팀원 작업 영역
│   ├── players.json         선수 데이터 (능력치 포함)
│   ├── scenarios.json       경기 시나리오 (재현할 "순간" 정의)
│   └── formations.json      포메이션별 기본 배치 좌표
├── engine/                ← 수식 담당 팀원 작업 영역 (React 몰라도 됨)
│   ├── resolve.js           확률 판정 엔진 — 산술식 스펙 ①~⑤가 들어가는 곳
│   ├── match.js             궤적 매칭 점수 — 스펙 ⑥ (아직 UI 미연결)
│   ├── geometry.js          베지어 궤적·최단거리 등 기하 공통 부품 (스펙 ①)
│   ├── playback.js          판정 결과 → 재연 애니메이션 (순수 연출, 판정과 무관)
│   └── commentary.js        중계 자막 멘트 풀
├── components/
│   └── TacticsBoard.jsx     SVG 전술보드 (드래그 입력·렌더링)
└── App.jsx                  상태 관리 + 화면 조립
```

**경계 규칙**: UI는 `resolveSequence(actions, ctx) → { pTotal, outcome, steps, reason, seed }`
시그니처에만 의존합니다. 수식 내부를 아무리 바꿔도 이 입출력 형태만 유지되면 UI는 안 깨집니다.

## 팀원별 작업 가이드

### 선수 데이터 (`src/data/players.json`)

현재 더미는 0~100 스케일 · 6스탯입니다. 항목 예시:

```json
{
  "id": "kor_07", "name": "손흥민", "team": "KOR", "number": 7,
  "position": "FW", "roles": ["LW"],
  "attributes": {
    "technical": { "shooting": 88, "passing": 84 },
    "mental":    { "decisions": 85, "composure": 86 },
    "physical":  { "pace": 90, "stamina": 85 }
  },
  "overall": 87, "condition": 100
}
```

- `team`은 scenarios.json의 `home`/`away`와 매칭돼 자동으로 스쿼드가 갈립니다.
- 배열 순서 = formations.json 슬롯 순서 (GK → DF → MF → FW).
- **스케일이 FM 1~20으로 바뀌면** [resolve.js](src/engine/resolve.js)의 `norm()` 한 줄만
  `S/20` 기준으로 바꾸면 됩니다 (어댑터 패턴).
- 스펙에 등장하는 `vision`·`tackle`·`technique`·`finishing`/`heading` 스탯은 아직 더미에
  없어서 `decisions` 등으로 임시 대체 중 — 필드가 생기면 resolve.js의 TODO 주석 위치만 교체.

### 경기 데이터 (`src/data/scenarios.json`)

```json
{
  "match_id": "kor_por_2022",
  "title": "…", "home": "KOR", "away": "POR",
  "actual": { "score": [2, 1], "formation": "4-2-3-1" },
  "moments": [{
    "id": "m91_counter", "minute": 91, "score": [1, 1],
    "situation": "상황 설명", "objective": "미션 문구",
    "ball": "kor_07"
  }]
}
```

- `ball` = 그 순간 공을 소유한 선수 id (전개의 시작점).
- 지금은 첫 번째 moment만 로드합니다. 스테이지 시스템이 붙으면 moment 배열이 그대로
  스테이지 목록이 됩니다.

### 판정 수식 (`src/engine/resolve.js`)

산술식 스펙 문서와 코드의 대응:

| 스펙 | 위치 | 상태 |
|---|---|---|
| ① 벡터 내적 최단거리 | [geometry.js](src/engine/geometry.js) `segPointDist` / `minDistToPath` | 스펙대로 구현 |
| ② 직선 패스 (M_dist·M_def) | [resolve.js](src/engine/resolve.js) `calcPass` + `defenseFactor` | **M_def 식 보정함** — 스펙 식은 d=0(수비수가 경로 위)에서 페널티가 사라지는 방향이라, 붙을수록 페널티가 커지도록 `e^(-β·tackle·(R-d))`로 뒤집어 둠. 팀원 확인 필요 |
| ③ 곡선 패스 (호 길이 L, κ) | `calcPass` (직선/곡선 공용) | 호 길이 페널티는 반영. κ(트릭샷) 항은 technique 스탯 확정 후 |
| ④ 슈팅 (침착성·거리·각도·블로커) | `calcShot` | 스펙대로 구현 (+게임 재미용 `SHOT_SCALE` 보정, GK는 블로커 제외) |
| ⑤ 시퀀스 총 확률 | `resolveSequence`의 `pTotal` | **확인 대기** — 스펙 식이 자체 검증 예시(0.7⁵→0.55)와 안 맞아 일단 순수 곱 |
| ⑥ 궤적 매칭 | [match.js](src/engine/match.js) `matchScore` | 수식 구현 완료, UI 미연결 (튜토리얼 스테이지용) |

밸런싱 상수(`DEF_RADIUS`, `ALPHA_*`, `BETA_*`, `D0_SHOT`, `R_BLOCK` 등)는 전부
resolve.js 상단에 모여 있습니다.

---

# 코드 해설 (아키텍처 투어)

처음 저장소를 열었을 때 코드가 어떻게 굴러가는지 이 섹션만 읽으면 따라갈 수 있게 정리했습니다.

## 전체 그림: 한 판이 흘러가는 길

```
data/*.json  ──▶  App.jsx  ──▶  TacticsBoard.jsx   (계획 단계: 드래그로 지시 입력)
 (선수/경기)      (상태 관리)      (SVG 그리기/입력)
                     │
                     │  "전술 확정" 버튼
                     ▼
              engine/resolve.js    ← 확률 계산 + 주사위 굴림 (판정, 순식간에 끝남)
                     │
                     ▼
              engine/playback.js   ← 이미 정해진 결과를 애니메이션으로 "재연"
                     │
                     ▼
              화면에 프레임 갱신 + 중계 자막 (commentary.js)
```

설계 사상 중 제일 중요한 것 하나: **판정과 연출의 완전 분리**. 확정 버튼을 누르는 순간
`resolveSequence()`가 성공/실패를 전부 계산해서 끝내고, 그 뒤에 도는 애니메이션은 이미
정해진 결과를 보여주는 연극일 뿐입니다. 애니메이션 중 선수가 어디에 있든 결과에 영향이
없습니다. 그래서 수식 작업은 resolve.js만, 연출 작업은 playback.js만 보면 됩니다.

모든 좌표는 **가로 120 × 세로 80** 가상 피치 좌표계(대략 미터 단위, x=0 우리 골대 →
x=120 상대 골대)를 씁니다. 화면 픽셀이 아니라 이 좌표로 모든 계산을 하고, SVG의
viewBox가 알아서 화면 크기에 맞춰 늘려줍니다.

## 시작점: index.html → main.jsx

[index.html](index.html)엔 `<div id="root">` 하나만 있고, [main.jsx](src/main.jsx)가
`createRoot(...).render(<App />)`로 그 div 안을 React에 맡깁니다. 이후 화면 갱신은 전부
React 담당.

## 데이터 조합 (App.jsx 상단)

```js
const homeSquad = playersData.filter((p) => p.team === scenario.home)  // KOR만 골라서
const basePlayers = homeSquad.map((p, i) => ({ ...p, x: slots[i].x, y: slots[i].y }))  // i번째 선수 → i번째 슬롯
const opponents = awaySquad.map((p, i) => ({ ...p, x: 120 - slots[i].x, y: 80 - slots[i].y }))  // 상대는 좌우 반전
```

`{ ...p, x, y }`는 스프레드 문법 — 선수 객체를 복사하면서 좌표를 얹습니다. `byId`는
`id → 선수` 사전이라 어디서든 즉시 조회할 수 있습니다.

## geometry.js — 선과 점의 수학

- **2차 베지어 곡선**: 시작 A, 끝 B, 제어점 C로 휘어진 선을 만드는 표준 방식. 모든 궤적이
  이거고, 직선은 "제어점이 중간에 있는 베지어"로 통일 → 직선/곡선 분기가 코드에 없음.
- **`samplePath`** — 곡선을 33개 점의 폴리라인으로 근사. 곡선을 직접 다루는 대신 점
  목록으로 바꿔서 이후 모든 계산(길이·거리·공 위치)을 단순한 점/선분 문제로 만드는 게 핵심.
- **`pathLength`** — 점 사이 거리 합 = 호 길이. 휘어 가면 자동으로 길어져 거리 페널티 증가.
- **`minDistToPath`** — 수비수가 경로에서 얼마나 가까운가(스펙 ① 내적 사영을 선분마다).
  가장 가까웠던 지점의 진행률(frac)도 돌려줘서 실패 시 차단 연출 좌표로 씁니다.
- **`handleFromCtrl`/`ctrlFromHandle`** — 유저가 끄는 하얀 점(곡선 가운데)과 베지어
  제어점은 위치가 달라서 상호 변환. 제어점을 직접 끌면 곡선이 손을 안 따라와 직관성이 떨어짐.

## resolve.js — 판정 엔진

- **`mulberry32(seed)`**: 같은 시드면 항상 같은 난수열. URL `?seed=` 재현의 핵심.
- **`norm()`**: 능력치 0~100 → 확률 계수 0.3~1.0. 하한 0.3은 "저능력 선수도 확률적
  기여"(스펙). 데이터 스케일이 바뀌면 이 한 줄만 교체하는 어댑터.
- **확률 계산 3형제** — 셋 다 구조는 `기본 능력치 × 거리 페널티 × 수비 페널티`:
  - `calcPass`: 패스 정확도 × `e^(-α/vision × L)` × 수비 차단 (스펙 ②③)
  - `calcDribble`: 기본치 (pace+composure)/2, 거리 페널티 더 가혹 (길게 끌수록 위험)
  - `calcShot`: 슛×침착 보정 × 거리 가우시안 × **각도 개방도 `sin(θ/2)`**(양 포스트
    사잇각, xG 모델 표준) × 블로커 (스펙 ④). `SHOT_SCALE`은 순수 xG가 너무 짜서 넣은
    재미 보정.
  - `defenseFactor`: 경로의 33개 점마다 수비수 최단거리 → 오라(6m) 안이면
    `e^(-β·tackle·(R-d))` 곱. 가장 위협적인 수비수(`worst`)를 기억해 실패 시 "걔가
    끊었다" 연출로 넘김.
- **`resolveSequence`**: ① 모든 액션 확률 먼저 계산(패널 표시용) → ② 순서대로
  `rng() < p` 주사위, 첫 실패 뒤는 `success: null` → ③ 결과 요약(GOAL/ADVANCE/
  INTERCEPTED/MISS + reason 문장).

## App.jsx — 상태의 심장

React 개념 세 가지만 알면 됩니다:

- **`useState`** — 바뀌면 화면도 다시 그려야 하는 변수. `set...()`을 부르면 React가 App
  함수를 다시 실행해 화면 갱신.
- **`useMemo`** — 의존값이 바뀔 때만 다시 계산하는 파생값 캐시.
- **`useRef`** — 리렌더와 무관한 보관함 (여기선 재생 취소 핸들 `playbackRef`).

상태는 딱 두 덩어리입니다:

```js
const [chainActs, setChainActs] = useState([])  // 공 전개 체인: 유저 지시의 "원본" (목표만)
const [runs, setRuns] = useState([])            // 오프볼 런 목록 (afterIndex = 출발 앵커)
```

**왜 `chainActs`(원본)와 `chain`(완성본)이 따로 있나** — 이 파일에서 제일 중요한 부분.
패스의 출발점은 "그 시점에 공 가진 선수가 서 있는 곳"인데 그건 앞선 드리블/런에 따라
달라집니다. 그래서 `useMemo` 블록이 지시 목록을 처음부터 순서대로 걸어가며 선수별 현재
위치(`pos`)를 갱신하고 각 지시에 출발점(`from`)을 채워 완성본 `chain`을 만듭니다. 같은
원리로 `runs → runLegs`, 최종 위치 `planPos`, 체인 끝에 공을 갖는 `carrierId`도 유도.
`runs`의 `afterIndex`는 "체인 몇 번째 액션 전에 출발하는 런인가"라는 앵커 — 덕분에
"주고 → 침투 → 되받기" 시간차 플레이가 표현됩니다.

지시 편집 함수들은 전부 `set...((prev) => 새배열)` 패턴입니다. React에서 배열 상태는
직접 수정하지 않고 항상 새로 만들어 넣어야 변경이 감지됩니다.

- `setDribble` — 공 가진 선수 드래그. 시작이면 새 레그 추가, 끄는 중엔 목표만 갱신
- `addPass` — 동료에 놓으면 pass, 골문 존이면 shot
- `removeChainFrom(i)` — 체인이라 i번째를 지우면 뒤도 전부 삭제 (출발점이 무너지므로)
- `setRunTarget` — 마지막 런이 이미 체인에 "소비"됐으면(그 위치로 패스를 받았으면) 새 런
  추가, 아니면 기존 런 조정

확정 버튼(`handleConfirm`)은 판정 → `setPhase('playing')` → `playSequence` 시작.
`phase`가 `plan → playing → done`으로 흐르고, 재생 중엔 playback이 매 프레임
`setFrame`으로 좌표를 흘려보내면 보드가 그 좌표로 그립니다.

## TacticsBoard.jsx — 입력과 그리기

하나의 큰 `<svg viewBox="0 0 120 80">`. `toPitch()`가 마우스 픽셀 좌표를 비율로 나눠
피치 좌표로 변환합니다.

드래그는 `onPointerDown`에서 잡은 대상의 종류(`kind`: dribble/run/ball/핸들)를
`dragRef`에 기록 → `onPointerMove`에서 종류별 App 콜백 호출 → `onPointerUp`에서 마무리.

- 4px 미만 움직임은 드래그가 아닌 **클릭**(선수 정보 표시)
- 목표를 출발점 근처로 되돌리면 **지시 취소**
- 공을 놓을 때: 골문 존(`x≥106`)이면 슛, 아니면 9 이내 가장 가까운 동료에게 **스냅**해서
  패스 (정밀 조준을 요구하지 않는 게임적 처리)

렌더링은 레이어 쌓기: 잔디 → 라인 → 수비 오라(드래그 중에만) → 런 점선 → 체인 선(번호
뱃지) → 상대 → 고스트(자리 옮긴 선수의 원래 위치) → 아군 → 곡률 핸들 → 공. 재생 중엔
선수 위치를 playback이 주는 프레임에서, 계획 중엔 `planPos`에서 읽습니다.

## playback.js — 재연 애니메이션 (제일 복잡한 파일)

입력은 "판정 끝난 결과", 출력은 매 프레임 `onFrame({home, opp, ball, caption})`.
3단계로 이해하면 됩니다.

**(a) 시간표 만들기 (시작 전 1회)**

- 공 액션들(`legs`)을 순차 배치. 소요시간 = 거리 ÷ 속도(패스 22m/s, 드리블 6.5 등),
  사이 0.2초. 실패 뒤 액션은 시간표에서 제외. 빗나간 슛은 목표점을 골대 밖으로 옮겨 연출.
- **오프볼 런은 역산 배치**: "패스 도착 순간에 러너도 도착"하도록 도착 시각에서 달리는
  시간을 빼 출발 시각을 정함 → 패스가 날아가는 동안 침투가 동시에 진행되는 겹침이 기본.
  아무리 일찍 출발해도 못 맞추면 공 쪽 시간표를 뒤로 밀어줌.
- 실패 시 `interceptor`: 차단 수비수가 차단 지점으로 달려가 공 도착 순간 뺏는 스크립트.
- 중계 자막(`captions`)도 미리 전부 생성 — 시드 난수라 리플레이해도 같은 멘트.

**(b) 매 프레임 루프 (`tick`, requestAnimationFrame ~60fps)**

1. **스크립트 우선**: 지시된 이동 중인 선수는 궤적 위 해당 지점에 강제 배치(`ease`로
   가속-감속).
2. **공 위치**(`ballAt`): 비행 중엔 궤적 위, 소유 중엔 소유자 발밑. 실패한 패스는 차단
   지점(`capFrac`)에서 멈춤.
3. **나머지 전원은 조향 시뮬레이션**(`integrate` — 가속 한계 있는 속도 적분): 아군은 공
   전진량만큼 라인 업(`ROW_K_HOME`), 상대는 내려앉기 + 가까운 2명 압박 + DF 소프트 마킹.
   선수별 시드 고정 노이즈로 잔움직임. **전부 눈요기, 판정과 무관.**
4. **이벤트 리액션**: 슛 순간 전원 멈칫(`freeze`), 골 세리머니(`ringOf` — 득점자 주위로
   모임), 뺏기면 공수 전환 무빙.
5. 좌표+공+자막을 `onFrame`으로 전달, 끝나면 `onDone`.

`events`(약속 시스템): "이 선수는 t 시점까지 이 지점에 있어야 한다"는 목록. 패스 받을
선수가 미리 그 자리에 못 박혀 있으면 어색하니, 이동 소요시간이 임박할 때까지 일반 무빙을
하다가 시간 맞춰 출발하게 하는 장치.

**(c) 취소**: `playSequence`는 `{ cancel }`을 반환, "다시 조정" 버튼이 `cancel()`로
루프를 끊음.

## commentary.js / match.js

- **commentary.js** — 이벤트별 멘트 풀에서 시드 난수로 하나 뽑아 이름을 끼움.
  `hasBatchim`은 한글 마지막 글자의 받침 유무를 유니코드 계산(`(ch-0xAC00) % 28`)으로
  판별해 **이/가, 을/를 조사를 자동으로** 맞춥니다.
- **match.js** — 스펙 ⑥ 궤적 매칭(가우시안 신뢰도). 아직 어디서도 안 부름 — 튜토리얼
  스테이지(안정환 골든골 재현) 만들 때 연결할 자리.

## 요약: 누가 뭘 몰라도 되는가

| 파일 | 몰라도 되는 것 | 이유 |
|---|---|---|
| resolve.js | React | 순수 함수 — 입력 객체 → 확률/결과 |
| playback.js | 수식 | 판정 결과를 받아 그림만 그림 |
| data/*.json | 코드 | 스키마만 지키면 자동 반영 |
| App.jsx / TacticsBoard.jsx | — | 상태 관리와 SVG 입력의 본체 (UI 담당 영역) |

---

## 일정

- 기획서 마감: 2026-07-27
- 최종 제출: 2026-08-03 (이후 커밋 실격)
