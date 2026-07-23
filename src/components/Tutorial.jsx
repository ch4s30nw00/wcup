// 튜토리얼 코치 — 기술을 하나씩 가르친다.
//
// 설계: 카드로 설명 → 실제 보드에서 직접 해보기 → 완료를 감지하면 다음 기술.
// 별도의 연습용 화면을 두지 않고 **진짜 전술보드 위에서** 돌린다. 연습판에서 익힌 조작은
// 본 게임에서 다시 헤매게 되지만, 여기서 익힌 건 그대로 실전이기 때문이다.

import { TUTORIAL_STEPS } from './tutorialSteps'

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
          <p className="coach-body">{s.body}</p>
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
