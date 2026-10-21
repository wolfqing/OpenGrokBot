import { useState } from 'react'
import type { QuestionPayload } from '../types'

/** 同事问你一个有几个选项的问题：点一下就答了；多选的勾好再提交；也可以直接在下面打字回。 */
export function QuestionChip({ payload, onAnswer }: {
  payload: QuestionPayload
  onAnswer: (choices: string[]) => void
}) {
  const [picked, setPicked] = useState<string[]>([])
  /** 点下去就先按「已答」显示，别让连点发两次；网关那头也会对第二次回 409 */
  const [sent, setSent] = useState<string[] | null>(null)
  const open = payload.status === 'open' && !sent
  const answer = (choices: string[]) => {
    setSent(choices)
    onAnswer(choices)
  }
  const toggle = (option: string) =>
    setPicked((p) => (p.includes(option) ? p.filter((x) => x !== option) : [...p, option]))

  if (!open) {
    const chosen = payload.answer ?? sent ?? []
    return (
      <div className="question-chip resolved">
        <div className="question-label">{payload.status === 'skipped' ? 'Answered in chat' : 'Answered'}</div>
        <div className="question-text">{payload.question}</div>
        <div className="question-options">
          {payload.options.map((o) => (
            <span key={o} className={`question-option${chosen.includes(o) ? ' chosen' : ''}`}>
              {chosen.includes(o) ? '✓ ' : ''}{o}
            </span>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="question-chip">
      <div className="question-label">{payload.multi ? 'Pick any that apply' : 'Pick one'}</div>
      <div className="question-text">{payload.question}</div>
      <div className="question-options">
        {payload.options.map((o) => payload.multi ? (
          <button key={o} className={`question-option${picked.includes(o) ? ' chosen' : ''}`} aria-pressed={picked.includes(o)} onClick={() => toggle(o)}>
            {o}
          </button>
        ) : (
          <button key={o} className="question-option" onClick={() => answer([o])}>{o}</button>
        ))}
      </div>
      {payload.multi ? (
        <button className="question-submit" disabled={picked.length === 0} onClick={() => answer(picked)}>Submit</button>
      ) : null}
      <div className="question-hint">Or type your own answer below.</div>
    </div>
  )
}
