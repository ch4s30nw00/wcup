// 튜토리얼 코치 — 기술을 하나씩 가르친다.
//
// 설계: 설명과 미션을 **한 카드에 함께** 둔다. 실제 전술보드 위에서 돌리므로
// 별도의 연습용 화면이 없다 — 연습판에서 익힌 조작은 본 게임에서 다시 헤매게 되지만,
// 여기서 익힌 건 그대로 실전이기 때문이다.
//
// 예전에는 "설명 카드 → [해보기 ▶] → 미션 스트립"으로 두 단계였다. 그런데 막상 해볼 때
// 설명이 사라져서, 조작이 헷갈리면 되돌아갈 방법이 없었다. 이제 설명을 띄운 채로 미션을
// 수행하고, 카드가 보드를 가릴 때만 사용자가 접는다 — 강제 2단계에서 선택 1단계로.

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

export function TutorialCoach({ step, collapsed, state, onToggle, onNext, onSkip, onExit }) {
  const s = TUTORIAL_STEPS[step]
  if (!s) return null
  const last = step === TUTORIAL_STEPS.length - 1
  const cleared = !s.mission || !!s.done?.(state)

  return (
    <div className={`coach${collapsed ? ' collapsed' : ''}`}>
      <div className="coach-head">
        <span className="coach-step">
          STEP {step + 1} / {TUTORIAL_STEPS.length}
        </span>
        <span className="coach-head-btns">
          {/* 접기 — 카드가 보드를 가릴 때. 접어도 미션과 버튼은 남는다 */}
          <button
            className="coach-fold"
            onClick={onToggle}
            title={collapsed ? '설명 펼치기' : '설명 접기 (보드가 가릴 때)'}
            aria-label={collapsed ? '설명 펼치기' : '설명 접기'}
          >
            {collapsed ? '▴' : '▾'}
          </button>
          <button className="coach-x" onClick={onExit} title="튜토리얼 끝내기">
            ✕
          </button>
        </span>
      </div>

      {!collapsed && (
        <>
          <h3>{s.title}</h3>
          <p className="coach-body">{withIcons(s.body)}</p>
          {s.tip && <p className="coach-tip">💡 {s.tip}</p>}
        </>
      )}

      {/* 미션은 접어도 남는다 — 지금 무엇을 해야 하는지가 카드의 핵심이다 */}
      {s.mission && (
        <div className="coach-mission">
          <span className={cleared ? 'ok' : 'wait'}>{cleared ? '✓' : '○'}</span>
          <span>{s.mission}</span>
        </div>
      )}

      <div className="coach-actions">
        {/* 미션을 끝내기 전에는 눌리지 않는다 — 활성화되는 순간이 곧 "됐다"는 신호다 */}
        <button className="coach-go" onClick={onNext} disabled={!cleared}>
          {last ? '튜토리얼 끝내기' : '다음 →'}
        </button>
        {s.mission && !cleared && (
          <button className="coach-skip" onClick={onSkip}>
            건너뛰기
          </button>
        )}
      </div>
    </div>
  )
}
