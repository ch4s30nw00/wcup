# 배포 가이드

> **현재 배포 주소: https://touchline-beige.vercel.app**
> (Vercel 프로젝트명 `touchline` · `touchline.vercel.app`은 전 세계에서 이미 선점되어 접미사가 붙었습니다)

터치라인은 **정적 사이트**입니다. 서버·DB·백엔드가 없고, `npm run build`가 만드는 `dist/`
폴더(약 300KB)를 정적 호스팅에 올리면 그게 곧 서비스입니다. 서버를 빌리거나 관리할 일이 없습니다.

- 호스팅: **Vercel** (무료 Hobby 플랜)
- 도메인: `https://<프로젝트명>.vercel.app` (커스텀 도메인 연결 가능)

---

## 1. 지금 당장 배포하기 (혼자 가능, 5분)

저장소 권한과 무관하게 로컬 빌드를 바로 올리는 방법입니다. 급할 때 이걸 씁니다.

```bash
npm install
npm run build

npx vercel login      # 브라우저가 열립니다 (GitHub 계정으로 로그인)
npx vercel --prod     # 첫 실행은 프로젝트 이름 등을 몇 개 물어봅니다
```

마지막 줄에 `https://...vercel.app` URL이 찍히면 끝입니다. 이후 재배포는 `npx vercel --prod` 한 줄.

> **첫 실행 질문 답안**
> - `Set up and deploy?` → **y**
> - `Which scope?` → 본인 계정
> - `Link to existing project?` → **n**
> - `Project name?` → `touchline` (이 이름이 URL이 됩니다)
> - `In which directory is your code?` → `./`
> - 빌드 설정 → 전부 **기본값** (`vercel.json`이 이미 잡아둡니다)

---

## 2. 자동 배포 파이프라인 (권장, 팀장 조치 1회 필요)

이걸 켜두면 **손으로 배포할 일이 없어집니다.**

| 언제 | 무슨 일이 | 왜 좋은가 |
|---|---|---|
| PR을 올리면 | 그 PR 전용 **미리보기 URL**이 자동 생성되고 PR에 댓글로 붙음 | 시안을 팀끼리 링크로 돌려볼 수 있음 |
| master에 머지되면 | **프로덕션 자동 배포** | 배포 담당이 아무것도 안 해도 최신이 유지됨 |
| 아무 때나 | GitHub Actions가 검증·린트·빌드 실행 | 깨진 코드가 배포되지 않음 |

### 팀장(저장소 소유자)에게 요청할 것 — 딱 한 번

> 저장소가 **비공개**라 Vercel이 코드를 읽으려면 소유자 승인이 필요합니다.
> 아래 중 하나만 해주면 됩니다.

**방법 A — 팀장이 직접 연결 (가장 간단, 2분)**
1. https://vercel.com 에 GitHub 계정으로 로그인
2. **Add New… → Project**
3. `ch4s30nw00/wcup` 선택 → **Import**
4. 설정은 건드리지 말고 **Deploy** (`vercel.json`이 다 잡아둠)
5. 생성된 프로젝트에서 **Settings → Git → Connected Git Repository** 확인
6. 배포 담당자를 **Settings → Members**로 초대

**방법 B — 배포 담당자에게 권한 위임**
1. 저장소 **Settings → Collaborators**에서 배포 담당자를 **Admin**으로 변경
2. 그 뒤 배포 담당자가 방법 A를 수행

### 연결 후 설정할 환경변수

Vercel 프로젝트 **Settings → Environment Variables**:

| 이름 | 값 | 용도 |
|---|---|---|
| `VITE_SITE_URL` | 실제 배포 URL (예: `https://touchline.vercel.app`) | 링크 미리보기(OG) 이미지의 절대경로 |

> 설정하지 않으면 저장소의 `.env` 기본값이 쓰입니다. 도메인이 확정되면 반드시 갱신하세요 —
> 값이 틀리면 카카오톡·디스코드에서 썸네일이 깨집니다.

---

## 3. 배포 후 확인 목록

```bash
# 배포된 URL로 아래를 확인
```

- [ ] 사이트가 뜨고 전술보드가 조작되는가
- [ ] **링크 미리보기** — 카카오톡·디스코드에 URL을 붙여 썸네일·제목이 뜨는지
      (안 뜨면 `VITE_SITE_URL`이 실제 도메인과 다른 것)
- [ ] **공유 링크** — 전술을 짜고 실행 → `🔗 이 전술 공유하기` → 복사된 링크를
      **시크릿 창**에서 열었을 때 같은 전술·같은 결과가 나오는지
- [ ] 모바일에서 가로 회전 안내가 뜨는지

> 카카오톡은 링크 미리보기를 캐시합니다. OG를 고친 뒤에도 옛 썸네일이 보이면
> https://developers.kakao.com/tool/debugger/sharing 에서 캐시를 초기화하세요.

---

## 4. `vercel.json` 설정 근거

JSON은 주석을 지원하지 않고 Vercel 스키마가 여분 속성을 거부하므로, 설정 의도를 여기에 적어둡니다.

| 경로 | 캐시 | 왜 |
|---|---|---|
| `/assets/(.*)` | 1년 · immutable | 번들 파일명에 해시가 붙어서(`index-a1b2c3.js`) 내용이 바뀌면 파일명도 바뀝니다. 영구 캐시가 안전하고 재방문이 즉시 뜹니다 |
| `/` | 캐시 안 함 | `index.html`이 캐시되면 배포해도 옛 화면이 남습니다. 팀 시안 확인이 어긋나는 가장 흔한 원인 |
| `/og.png` | 1일 | 크롤러가 주기적으로 다시 읽어가되, 무한 캐시로 옛 썸네일이 박히지 않게 |

`framework: "vite"`를 명시해 두면 Vercel이 빌드 설정을 자동 추론하다 실패하는 경우가 없습니다.

## 5. 알아두면 좋은 것

**대역폭**: Vercel 무료 플랜은 월 100GB. 이 앱은 1회 방문에 약 300KB이므로 **약 33만 조회**까지
감당합니다. 그 이상 터질 것 같으면 Cloudflare Pages(대역폭 무제한)로 옮기면 되고,
`vercel.json` 외에는 고칠 게 없습니다.

**롤백**: Vercel 대시보드 → Deployments에서 이전 배포의 `⋯` → **Promote to Production**.
잘못 나가도 30초면 되돌립니다.

**커스텀 도메인**: 도메인을 사면 Settings → Domains에서 연결할 수 있습니다(무료·HTTPS 자동).
연결하면 `VITE_SITE_URL`도 새 도메인으로 갱신하세요.
