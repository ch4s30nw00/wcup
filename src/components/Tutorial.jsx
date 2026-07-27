// 튜토리얼 코치 — 기술을 하나씩 가르친다.
//
// 설계: 카드로 설명 → 실제 보드에서 직접 해보기 → 완료를 감지하면 다음 기술.
// 별도의 연습용 화면을 두지 않고 **진짜 전술보드 위에서** 돌린다. 연습판에서 익힌 조작은
// 본 게임에서 다시 헤매게 되지만, 여기서 익힌 건 그대로 실전이기 때문이다.

import { TUTORIAL_STEPS } from './tutorialSteps'

// 보드에 실제로 그려지는 공을 그대로 축소한 아이콘.
// ⚪ 이모지를 쓰다가 "글에 있는 공이랑 보드에 있는 공이 다르다"는 말을 들었다 —
// 실제 공은 흰 원 가운데 검은 점이 박혀 있고, 폰트마다 ⚪ 모양도 제각각이다.
// 비율(중앙 점 = 반지름의 0.4배, 테두리 0.25)은 TacticsBoard의 공 렌더와 같은 값이다.
function BallIcon() {
  return (
    <svg className="coach-ball" viewBox="-1.25 -1.25 2.5 2.5" aria-label="공" role="img">
      <circle r="0.95" fill="#fff" stroke="#10141c" strokeWidth="0.25" />
      <circle r="0.38" fill="#10141c" />
    </svg>
  )
}

// 본문의 [ball] 토큰을 공 아이콘으로 바꾼다. 단계 정의(tutorialSteps.js)를 문자열
// 데이터로 유지하기 위한 최소 장치 — 거기에 JSX를 넣으면 fast-refresh가 깨진다.
function withIcons(text) {
  return String(text)
    .split('[ball]')
    .flatMap((part, i) => (i === 0 ? [part] : [<BallIcon key={`b${i}`} />, part]))
}

export function TutorialCoach({ step, reading, state, onPractice, onNext, onSkip, onExit }) {
  const s = TUTORIAL_STEPS[step]
  if (!s) return null
  const last = step === TUTORIAL_STEPS.length - 1
  const cleared = !s.mission || !!s.done?.(state)

  return (
    <div className={`coach ${reading ? 'coach-card' : 'coach-strip'}`}>
      <div className="coach-head">
        <span className="coach-step">
          STEP {step + 1} / {TUTORIAL_STEPS.length}
        </span>
        <button className="coach-x" onClick={onExit} title="튜토리얼 끝내기">
          ✕
        </button>
      </div>

      {reading ? (
        <>
          <h3>{s.title}</h3>
          <p className="coach-body">{withIcons(s.body)}</p>
          {s.tip && <p className="coach-tip">💡 {s.tip}</p>}
          <div className="coach-actions">
            {s.mission ? (
              <button className="coach-go" onClick={onPractice}>
                해보기 ▶
              </button>
            ) : (
              <button className="coach-go" onClick={onNext}>
                {last ? '튜토리얼 끝내기' : '다음 →'}
              </button>
            )}
            {s.mission && (
              <button className="coach-skip" onClick={onSkip}>
                건너뛰기
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="coach-mission">
            <span className={cleared ? 'ok' : 'wait'}>{cleared ? '✓' : '○'}</span>
            <span>{s.mission}</span>
          </div>
          <div className="coach-actions">
            {cleared ? (
              <button className="coach-go" onClick={onNext}>
                {last ? '끝내기' : '다음 →'}
              </button>
            ) : (
              <button className="coach-skip" onClick={onSkip}>
                건너뛰기
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
