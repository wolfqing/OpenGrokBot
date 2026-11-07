import { useEffect, useState } from 'react'
import { FieldErrors, fetchConnectionModels, setBotLlm } from '../api'
import { useT } from '../i18n'
import type { BotLlm, ConnectionsState, ProviderPreset } from '../types'
import { connectionLabel, fieldText } from './ModelsDialog'

/** 对话顶部那一小块：这位同事此刻用哪个 AI。点开就能换 */
export function BotModelChip({ botId, state, providers, onOpen }: {
  botId: string
  state: ConnectionsState
  providers: ProviderPreset[]
  onOpen: () => void
}) {
  const t = useT()
  const choice = state.bots[botId] ?? { connectionId: 'main', model: null }
  const c = state.connections.find((x) => x.id === choice.connectionId) ?? state.connections[0]
  if (!c) return null
  const text = t('picker.chip', { connection: connectionLabel(c, providers, t), model: choice.model ?? c.model })
  return (
    <button className="model-chip" onClick={onOpen} title={text}>
      <span className="model-chip-dot" aria-hidden="true" />
      <span className="model-chip-text">{text}</span>
    </button>
  )
}

export function BotModelPicker({ botId, botName, state, providers, onSaved, onManage, onClose }: {
  botId: string
  botName: string
  state: ConnectionsState
  providers: ProviderPreset[]
  onSaved: (botId: string, llm: BotLlm) => void
  onManage: () => void
  onClose: () => void
}) {
  const t = useT()
  const current = state.bots[botId] ?? { connectionId: 'main', model: null }
  const [connectionId, setConnectionId] = useState(current.connectionId)
  const [model, setModel] = useState(current.model ?? '')
  const [models, setModels] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const connection = state.connections.find((c) => c.id === connectionId)

  // 选了哪个连接就去拿它的模型列表，给模型框做候选；拿不到不要紧，照样能手填
  useEffect(() => {
    let live = true
    setModels([])
    fetchConnectionModels(connectionId)
      .then((r) => { if (live && r.ok) setModels(r.models) })
      .catch(() => {})
    return () => { live = false }
  }, [connectionId])

  const save = async () => {
    setSaving(true)
    try {
      const picked = model.trim()
      onSaved(botId, await setBotLlm(botId, { connectionId, model: picked && picked !== connection?.model ? picked : null }))
      onClose()
    } catch (err) {
      const first = err instanceof FieldErrors ? err.errors[0] : undefined
      setError(first ? fieldText(t, first) : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <form
        className="modal picker" role="dialog" aria-label={t('picker.title', { name: botName })}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); void save() }}
      >
        <div className="modal-title">{t('picker.title', { name: botName })}</div>
        <label>
          <span className="conn-label">{t('picker.connection')}</span>
          <select value={connectionId} onChange={(e) => { setConnectionId(e.target.value); setModel('') }}>
            {state.connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.builtIn ? t('picker.defaultSuffix', { name: connectionLabel(c, providers, t) }) : connectionLabel(c, providers, t)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="conn-label">{t('picker.model')}</span>
          <input
            value={model} list="picker-models" spellCheck={false}
            placeholder={connection ? t('picker.modelDefault', { model: connection.model }) : ''}
            disabled={Boolean(connection?.builtIn && connection.locked.includes('model'))}
            onChange={(e) => setModel(e.target.value)}
          />
          <datalist id="picker-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
        </label>
        <p className="conn-note">{t('picker.nextTurn')}</p>
        {error ? <div className="form-error" role="alert">{error}</div> : null}
        <div className="conn-form-buttons">
          <button type="button" className="link" onClick={onManage}>{t('picker.manage')}</button>
          <span className="spacer" />
          <button type="button" onClick={onClose}>{t('picker.cancel')}</button>
          <button type="submit" className="primary" disabled={saving}>{t('picker.save')}</button>
        </div>
      </form>
    </div>
  )
}
