// 인트로(타이틀) 화면과 경기 선택 화면.
// 화면 전환 상태는 App이 들고, 여기는 표시와 콜백만 담당한다.
import scenario from '../data/scenarios.json'

// 아직 시나리오 데이터가 없는 예정 경기 — 카드로만 노출 (확장 로드맵 표시용)
const UPCOMING_MATCHES = [
  {
    id: 'kor_ita_2002',
    title: '2002 한일 월드컵 16강 — 대한민국 vs 이탈리아',
    minute: '연장 후반 117′',
    desc: '골든골 한 방이면 8강. 안정환의 순간으로.',
  },
  {
    id: 'kor_ger_2018',
    title: '2018 러시아 월드컵 F조 3차전 — 대한민국 vs 독일',
    minute: '후반 추가시간',
    desc: '카잔의 기적 — 디펜딩 챔피언을 무너뜨린 두 골.',
  },
]

const displayMinute = (m) => (m > 90 ? `90+${m - 90}′` : `${m}′`)

// 배경: 전술보드와 같은 규격(120x80)의 피치 라인을 은은하게 깔아 세계관을 통일
function PitchBackdrop() {
  return (
    <svg className="intro-pitch-bg" viewBox="0 0 120 80" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="0.35">
        <rect x="1" y="1" width="118" height="78" />
        <line x1="60" y1="1" x2="60" y2="79" />
        <circle cx="60" cy="40" r="12" />
        <rect x="1" y="20" width="18" height="40" />
        <rect x="101" y="20" width="18" height="40" />
        <rect x="1" y="31" width="6" height="18" />
        <rect x="113" y="31" width="6" height="18" />
      </g>
    </svg>
  )
}

export function TitleScreen({ onStart }) {
  return (
    <div className="screen intro-screen">
      <PitchBackdrop />
      <div className="intro-content">
        <div className="intro-kicker">World Cup · Tactics Challenge</div>
        <h1 className="intro-title">⚽ 터치라인</h1>
        <p className="intro-tagline">
          그날의 결정적 순간으로 돌아간다.
          <br />
          이번엔, 당신이 감독이다.
        </p>
        <button className="intro-play" onClick={onStart}>
          PLAY&ensp;▶
        </button>
      </div>
    </div>
  )
}

export function MatchSelect({ onPick, onBack }) {
  const moment = scenario.moments[0]
  return (
    <div className="screen select-screen">
      <PitchBackdrop />
      <div className="select-content">
        <div className="select-head">
          <button className="ctrl select-back" onClick={onBack}>‹ 뒤로</button>
          <h2>경기 선택</h2>
        </div>

        <div className="match-cards">
          <button className="match-card playable" onClick={onPick}>
            <div className="match-card-top">
              <span className="match-badge live">PLAYABLE</span>
              <span className="match-minute">{displayMinute(moment.minute)}</span>
            </div>
            <div className="match-title">{scenario.title}</div>
            <div className="match-score">
              {scenario.home} <b>{moment.score[0]} : {moment.score[1]}</b> {scenario.away}
            </div>
            <p className="match-desc">{moment.situation}</p>
            <div className="match-objective">🎯 {moment.objective}</div>
            <div className="match-cta">경기 시작 ▶</div>
          </button>

          {UPCOMING_MATCHES.map((m) => (
            <div key={m.id} className="match-card locked" aria-disabled="true">
              <div className="match-card-top">
                <span className="match-badge soon">COMING SOON</span>
                <span className="match-minute">{m.minute}</span>
              </div>
              <div className="match-title">{m.title}</div>
              <p className="match-desc">{m.desc}</p>
              <div className="match-lock">🔒</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
