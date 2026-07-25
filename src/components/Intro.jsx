// 인트로(타이틀) 화면과 경기 선택 화면.
// 화면 전환 상태는 App이 들고, 여기는 표시와 콜백만 담당한다.
import { MATCHES } from '../data/matches'

// 연장(90 초과)은 "90+x"가 아니라 실제 분을 그대로 쓴다 — 모먼트가 minuteLabel을 주면 그걸 우선한다.
const displayMinute = (m) => (m > 90 ? `90+${m - 90}′` : `${m}′`)
const minuteText = (moment) => moment.minuteLabel ?? displayMinute(moment.minute)

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

export function MatchSelect({ matchId, onPick, onBack, onTutorial }) {
  return (
    <div className="screen select-screen">
      <PitchBackdrop />
      <div className="select-content">
        <div className="select-head">
          <button className="ctrl select-back" onClick={onBack}>‹ 뒤로</button>
          <h2>경기 선택</h2>
        </div>

        <div className="match-cards">
          {/* 튜토리얼 — 실제 궤적을 따라 그리며 조작법과 그날의 장면을 동시에 익힌다 */}
          <button className="match-card tutorial" onClick={onTutorial}>
            <div className="match-card-top">
              <span className="match-badge tut">TUTORIAL</span>
              <span className="match-minute">90+1′</span>
            </div>
            <div className="match-title">따라 그리기 — 그날의 전개</div>
            <p className="match-desc">
              실제로 공이 지나간 길을 손끝으로 따라 그려보세요. 궤적 유사도로 재현도를 채점합니다.
            </p>
            <div className="match-cta">튜토리얼 시작 ▶</div>
          </button>

          {MATCHES.map((m) => {
            const moment = m.moments[0]
            return (
              <button
                key={m.match_id}
                className={`match-card playable${m.match_id === matchId ? ' current' : ''}`}
                onClick={() => onPick(m.match_id)}
              >
                <div className="match-card-top">
                  <span className="match-badge live">PLAYABLE</span>
                  <span className="match-minute">{minuteText(moment)}</span>
                </div>
                <div className="match-title">{m.title}</div>
                <div className="match-score">
                  {m.home} <b>{moment.score[0]} : {moment.score[1]}</b> {m.away}
                </div>
                <p className="match-desc">{moment.situation}</p>
                <div className="match-objective">🎯 {moment.objective}</div>
                <div className="match-cta">경기 시작 ▶</div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
