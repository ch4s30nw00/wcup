// 킥오프 오프닝 — 경기를 고르고 보드가 뜨기 전 사이에 끼는 짧은 화면.
//
// 왜 필요한가: 경기 선택에서 보드로 바로 넘어가면 "어느 경기의 몇 분인지"를
// 카드에서 읽고 곧장 잊어버린 채 전술을 짜게 된다. 중계가 킥오프 전에 양 팀
// 엠블럼과 스코어를 한 번 보여주는 이유와 같다 — 그 3초가 맥락을 심는다.
//
// 유니폼은 보드에 실제로 나올 킷 색을 그대로 쓴다(data/kits.js). 여기서 본 색이
// 곧 보드 위 원의 색이라, 오프닝이 "누가 우리 편인지"를 미리 가르쳐 준다.
//
// 진행: 자동으로 넘어가되(AUTO_MS) 아무 데나 누르면 즉시 건너뛴다.
// 두 번째 판부터는 이미 본 화면이라 붙잡아 두면 안 된다.

import { useEffect } from 'react'
import { kitsFor, teamName, teamCode } from '../data/kits'
import { PitchBackdrop } from './Intro'

// 자동 진행 시간. 마지막 요소(목표)가 뜨고 약 1초 뒤에 넘어간다.
const AUTO_MS = 4200

// 연장(90 초과)은 "90+x"로 — 경기 선택 화면과 같은 규칙
const displayMinute = (m) => (m > 90 ? `90+${m - 90}′` : `${m}′`)
const minuteText = (moment) => moment.minuteLabel ?? displayMinute(moment.minute)

// 타이틀은 "2026 북중미 월드컵 16강 — 포르투갈 vs 스페인" 꼴이다.
// 앞부분(대회·라운드)만 쓴다 — 팀 이름은 아래 유니폼 옆에 크게 따로 나오므로 겹친다.
// 구분자가 없는 제목이면 통째로 쓴다(잘라내다 빈 문자열이 되는 것보다 낫다).
const competitionOf = (title) => String(title ?? '').split('—')[0].trim() || title

// 유니폼 실루엣. 어깨-소매-몸통을 한 path로 그리고, 깃과 소매·밑단 트림만
// ring 색으로 덧그린다. 흰 킷이 검은 배경에서 뭉개지지 않도록 테두리는 항상 넣는다.
const SHIRT_BODY =
  'M 22 10 L 34 5 C 36 14, 64 14, 66 5 L 78 10 L 98 34 L 84 51 L 76 43 L 76 100 ' +
  'C 58 106, 42 106, 24 100 L 24 43 L 16 51 L 2 34 Z'
const SHIRT_COLLAR = 'M 34 5 C 36 15, 64 15, 66 5'

function Jersey({ kit, code }) {
  return (
    <svg className="ko-jersey" viewBox="-3 0 106 112" aria-hidden="true">
      <path d={SHIRT_BODY} fill={kit.body} stroke={kit.ring} strokeWidth="1.6" strokeLinejoin="round" />
      <path d={SHIRT_COLLAR} fill="none" stroke={kit.ring} strokeWidth="3.4" strokeLinecap="round" />
      {/* 소매 끝·밑단 트림 — 단색 판때기로 보이지 않게 하는 최소한의 디테일 */}
      <path d="M 16 51 L 24 43" stroke={kit.ring} strokeWidth="2.4" fill="none" />
      <path d="M 84 51 L 76 43" stroke={kit.ring} strokeWidth="2.4" fill="none" />
      <text className="ko-jersey-code" x="50" y="72" textAnchor="middle" fill={kit.num}>
        {code}
      </text>
    </svg>
  )
}

// 한 팀 블록 — 유니폼 + 국가명 + (조작하는 팀이면) 감독 배지.
// GK 색을 작은 점으로 함께 보여준다: 보드에서 골키퍼만 색이 다른 이유를 여기서 미리 알린다.
function TeamSide({ kit, code, name, mine, side }) {
  return (
    <div className={`ko-team ko-team-${side}`}>
      <Jersey kit={kit} code={code} />
      <div className="ko-team-name">{name}</div>
      <div className="ko-team-meta">
        <span className="ko-gk-dot" style={{ background: kit.gk }} />
        <span>GK</span>
      </div>
      {/* 배지는 한쪽에만 붙지만 자리는 양쪽 다 잡아둔다 — 안 그러면 두 팀 블록 높이가
          어긋나 가운데 VS가 한쪽으로 밀린다 */}
      <div className={`ko-mine${mine ? '' : ' ko-mine-off'}`} aria-hidden={!mine}>
        당신이 지휘합니다
      </div>
    </div>
  )
}

export default function Kickoff({ matchId, scenario, moment, carrier, onDone }) {
  // 자동 진행. onDone이 매 렌더 새 함수라도 타이머가 리셋되지 않도록 matchId에만 건다 —
  // 도중에 타이머가 다시 걸리면 오프닝이 영영 안 끝난다.
  useEffect(() => {
    const t = setTimeout(onDone, AUTO_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId])

  // 키보드로도 건너뛸 수 있어야 한다 — 데모에서 마우스 없이 넘길 때가 있다.
  useEffect(() => {
    const onKey = () => onDone()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId])

  const [homeKit, awayKit] = kitsFor(matchId)
  // home이 플레이어가 조작하는 팀이다(buildMatch 참고). 그래서 항상 왼쪽에 둔다 —
  // 실제 경기 표기 순서(타이틀)와 어긋날 수 있지만, 여기서 중요한 건 "내 팀이 어느 쪽인가"다.
  const [homeScore, awayScore] = moment.score

  return (
    <div className="screen kickoff-screen" onClick={onDone} role="presentation">
      <PitchBackdrop />
      <div className="ko-content">
        <div className="ko-competition">{competitionOf(scenario.title)}</div>

        <div className="ko-teams">
          <TeamSide kit={homeKit} code={teamCode(scenario.home)} name={teamName(scenario.home)} mine side="home" />
          <div className="ko-vs">VS</div>
          <TeamSide kit={awayKit} code={teamCode(scenario.away)} name={teamName(scenario.away)} side="away" />
        </div>

        <div className="ko-scoreline">
          <span className="ko-minute">{minuteText(moment)}</span>
          <span className="ko-score">
            {homeScore} <i>:</i> {awayScore}
          </span>
          {carrier && (
            <span className="ko-carrier">
              ⚪ {carrier.name} <b>{carrier.number}</b>
            </span>
          )}
        </div>

        <div className="ko-objective">🎯 {moment.objective}</div>
        <div className="ko-skip">화면을 누르면 바로 시작합니다</div>
      </div>
    </div>
  )
}
