// 튜토리얼 스테이지 — "따라 그리기".
// engine/match.js의 matchScore(가우시안 커널 궤적 유사도)를 UI에 연결한다.
//
// 왜 따라 그리기가 튜토리얼인가:
//   보드의 핵심 조작은 결국 "궤적을 그린다"는 하나의 동작이다. 규칙을 글로 읽히는 대신
//   실제 역사의 궤적을 한 번 따라 그리게 하면, 조작법과 그날의 장면을 동시에 익힌다.
//   판정(확률)은 개입하지 않는다 — 순수하게 손의 궤적만 본다.
//
// 임계: K.MATCH.FULL(90) 완전 재현 / K.MATCH.PARTIAL(70) 부분 재현.

import { useMemo, useRef, useState } from 'react'
import { matchScore } from '../engine/match'
import { K } from '../engine/constants'
import scenario from '../data/scenarios.json'

const PITCH_W = 120
const PITCH_H = 80
const COARSE = window.matchMedia?.('(pointer: coarse)').matches ?? false
// 궤적 샘플링 간격(px) — 너무 촘촘하면 매칭 계산이 무거워지고, 너무 성기면 점수가 튄다
const SAMPLE_MIN_PX = COARSE ? 6 : 4

const moment = scenario.moments[0]
const tut = moment.tutorial

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const polyline = (pts) => pts.map((p) => `${p.x},${p.y}`).join(' ')

export default function Tutorial({ onDone, onBack }) {
  const svgRef = useRef(null)
  const drawingRef = useRef(false)
  const [userPts, setUserPts] = useState([])
  const [score, setScore] = useState(null)

  const answer = tut.answerPath

  // 정답 궤적의 각 꺾인 점 = 액션 경계. 안내 뱃지를 여기에 붙인다.
  const nodes = useMemo(
    () => answer.map((p, i) => ({ ...p, i, leg: tut.legs[i - 1] ?? null })),
    [answer],
  )

  function toPitch(e) {
    const rect = svgRef.current.getBoundingClientRect()
    return {
      x: clamp(((e.clientX - rect.left) / rect.width) * PITCH_W, 0, PITCH_W),
      y: clamp(((e.clientY - rect.top) / rect.height) * PITCH_H, 0, PITCH_H),
      px: e.clientX,
      py: e.clientY,
    }
  }

  function start(e) {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drawingRef.current = true
    const p = toPitch(e)
    setScore(null)
    setUserPts([{ x: p.x, y: p.y, px: p.px, py: p.py }])
  }

  function move(e) {
    if (!drawingRef.current) return
    const p = toPitch(e)
    setUserPts((ps) => {
      const last = ps[ps.length - 1]
      // 화면 픽셀 기준으로 일정 간격 이상 움직였을 때만 샘플을 남긴다
      if (last && Math.hypot(p.px - last.px, p.py - last.py) < SAMPLE_MIN_PX) return ps
      return [...ps, { x: p.x, y: p.y, px: p.px, py: p.py }]
    })
  }

  function end() {
    if (!drawingRef.current) return
    drawingRef.current = false
    setUserPts((ps) => {
      // 점이 2개 미만이면 궤적이 아니다 (그냥 탭)
      if (ps.length < 2) {
        setScore(null)
        return ps
      }
      setScore(matchScore(ps, answer))
      return ps
    })
  }

  const grade =
    score == null
      ? null
      : score >= K.MATCH.FULL
        ? { key: 'full', label: '완전 재현', text: '그날의 궤적 그대로입니다. 이제 보드로 갑니다.' }
        : score >= K.MATCH.PARTIAL
          ? { key: 'partial', label: '부분 재현', text: '큰 흐름은 맞았습니다. 꺾이는 지점을 더 붙여보세요.' }
          : { key: 'fail', label: '다시', text: '경로가 많이 벗어났습니다. 점선을 눈으로 따라가며 천천히.' }

  const reset = () => {
    setUserPts([])
    setScore(null)
  }

  return (
    <div className="screen tutorial-screen">
      <div className="tutorial-content">
        <div className="select-head">
          <button className="ctrl select-back" onClick={onBack}>‹ 뒤로</button>
          <h2>{tut.title}</h2>
        </div>
        <p className="tutorial-intro">{tut.intro}</p>

        <svg
          ref={svgRef}
          className="tactics-board tutorial-board"
          viewBox={`0 0 ${PITCH_W} ${PITCH_H}`}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        >
          {/* 잔디 + 라인 (보드와 같은 규격) */}
          <rect width={PITCH_W} height={PITCH_H} fill="#2f7d3f" />
          {[0, 2, 4, 6, 8].map((i) => (
            <rect key={i} x={i * 24} width={12} height={PITCH_H} fill="#2a7339" />
          ))}
          <g stroke="#e6f2e6" strokeWidth="0.5" fill="none" opacity="0.9">
            <rect x="1" y="1" width={PITCH_W - 2} height={PITCH_H - 2} />
            <line x1="60" y1="1" x2="60" y2={PITCH_H - 1} />
            <circle cx="60" cy="40" r="9.15" />
            <rect x="1" y="18" width="17" height="44" />
            <rect x={PITCH_W - 18} y="18" width="17" height="44" />
            <rect x="1" y="30" width="5.5" height="20" />
            <rect x={PITCH_W - 6.5} y="30" width="5.5" height="20" />
          </g>
          <rect x={118.6} y={36.34} width={1.4} height={7.32} fill="#10141c" stroke="#e6f2e6" strokeWidth="0.35" />

          {/* 정답 궤적 (따라 그릴 점선) */}
          <polyline
            points={polyline(answer)}
            fill="none"
            stroke="#ffd23e"
            strokeWidth="0.9"
            strokeDasharray="2.4 1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.85"
          />

          {/* 액션 경계 노드 + 설명 */}
          {nodes.map((n) => (
            <g key={n.i} pointerEvents="none">
              <circle cx={n.x} cy={n.y} r="1.5" fill="#10141c" stroke="#ffd23e" strokeWidth="0.4" />
              <text x={n.x} y={n.y + 0.6} textAnchor="middle" fontSize="1.9" fontWeight="700" fill="#ffd23e">
                {n.i + 1}
              </text>
              {n.leg && (
                <text
                  x={clamp(n.x, 14, PITCH_W - 14)}
                  y={n.y - 3}
                  textAnchor="middle"
                  fontSize="2.3"
                  fill="#f0f4f0"
                  stroke="#1a3a22"
                  strokeWidth="0.4"
                  paintOrder="stroke"
                >
                  {n.leg.label}
                </text>
              )}
            </g>
          ))}

          {/* 사용자가 그린 궤적 */}
          {userPts.length > 1 && (
            <polyline
              points={polyline(userPts)}
              fill="none"
              stroke={grade?.key === 'fail' ? '#ff6b5e' : '#fff'}
              strokeWidth="0.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.95"
              pointerEvents="none"
            />
          )}
        </svg>

        <div className="tutorial-bar">
          {score == null ? (
            <span className="tutorial-hint">
              노란 점선을 손가락(또는 마우스)으로 <b>한 번에 이어서</b> 따라 그리세요.
            </span>
          ) : (
            <span className={`tutorial-score ${grade.key}`}>
              <b>{score.toFixed(0)}점</b> — {grade.label}. {grade.text}
            </span>
          )}
          <button className="ctrl" onClick={reset} disabled={!userPts.length}>
            다시 그리기
          </button>
          <button className="kickoff" onClick={onDone}>
            {score != null && score >= K.MATCH.PARTIAL ? '보드로 이동 ▶' : '건너뛰고 시작 ▶'}
          </button>
        </div>
      </div>
    </div>
  )
}
