import { useState } from 'react'

export function NewBotForm({ onCreate, onCancel, error }: {
  onCreate: (name: string, role: string) => void
  onCancel: () => void
  /** 网关拒绝的原因（比如重名），就地显示 */
  error?: string
}) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const ready = name.trim().length > 0

  return (
    <form
      className="new-bot"
      onSubmit={(e) => { e.preventDefault(); if (ready) onCreate(name.trim(), role.trim()) }}
    >
      <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      <input placeholder="What do they do?" value={role} onChange={(e) => setRole(e.target.value)} />
      {error ? <div className="form-error" role="alert">{error}</div> : null}
      <div className="new-bot-buttons">
        <button type="submit" disabled={!ready}>Hire</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}
