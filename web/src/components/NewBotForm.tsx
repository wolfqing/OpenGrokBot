import { useState } from 'react'

export function NewBotForm({ onCreate, onCancel }: {
  onCreate: (name: string, role: string) => void
  onCancel: () => void
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
      <div className="new-bot-buttons">
        <button type="submit" disabled={!ready}>Hire</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}
