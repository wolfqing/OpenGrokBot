import { useMemo, useState } from 'react'
import { FieldErrors, createConnection, deleteConnection, testConnection, updateConnection, type ConnectionFields } from '../api'
import { useT, type MessageKey, type T } from '../i18n'
import type { CheckResult, ConnectionsState, FieldError, LlmApi, ModelConnection, ProviderPreset } from '../types'

type Roster = Record<string, { name: string; emoji: string }>

const REGIONS: ProviderPreset['region'][] = ['cn', 'global', 'local', 'custom']
const APIS: LlmApi[] = ['chat', 'anthropic', 'responses']

/** 有专门说明的服务商（条款、该用哪种 key） */
const NOTES: Partial<Record<string, MessageKey>> = {
  anthropic: 'models.note.anthropic',
  openai: 'models.note.openai',
  gemini: 'models.note.gemini',
}

/** 连接在界面上叫什么：起了名字用名字，否则用服务商的名字 */
export function connectionLabel(c: Pick<ModelConnection, 'name' | 'provider'>, providers: ProviderPreset[], t: T): string {
  if (c.name) return c.name
  const p = providers.find((x) => x.id === c.provider)
  return p && p.id !== 'custom' ? p.name : t('models.custom')
}

export function checkText(t: T, r: CheckResult, model: string): string {
  if (r.ok) {
    if (r.modelListed === true) return t('models.check.okListed', { model })
    if (r.modelListed === false) return t('models.check.okUnlisted', { model })
    return t('models.check.ok')
  }
  return (t(`models.check.${r.code}` as MessageKey, { model }) as string | undefined) ?? t('models.check.provider_error')
}

/** 字段错误翻成人话；认不出的代码（更新的网关加的）原样显示 */
export const fieldText = (t: T, e: FieldError): string => (t(`models.field.${e.code}` as MessageKey) as string | undefined) ?? e.code

/** 测试结果一行：成功绿、失败红；失败时附上服务商的原话，方便查 */
function CheckLine({ result, model }: { result: CheckResult | 'testing' | undefined; model: string }) {
  const t = useT()
  if (!result) return null
  if (result === 'testing') return <div className="conn-check">{t('models.form.testing')}</div>
  return (
    <div className={`conn-check ${result.ok ? 'ok' : 'bad'}`} role="status">
      {result.ok ? '✓ ' : '✕ '}{checkText(t, result, model)}
      {!result.ok && result.detail ? <div className="conn-check-detail">{result.status ? `${result.status} · ` : ''}{result.detail}</div> : null}
    </div>
  )
}

export function ModelsDialog({ state, providers, roster, onChange, onClose }: {
  state: ConnectionsState
  providers: ProviderPreset[]
  roster: Roster
  onChange: (next: ConnectionsState) => void
  onClose: () => void
}) {
  const t = useT()
  const [editing, setEditing] = useState<{ id: string } | 'new' | null>(null)
  const [checks, setChecks] = useState<Record<string, CheckResult | 'testing'>>({})
  const [error, setError] = useState<string | null>(null)

  const users = useMemo(() => {
    const out: Record<string, string[]> = {}
    for (const [botId, choice] of Object.entries(state.bots)) {
      const name = roster[botId]?.name
      if (name) (out[choice.connectionId] ??= []).push(name)
    }
    return out
  }, [state.bots, roster])

  const test = async (c: ModelConnection) => {
    setChecks((s) => ({ ...s, [c.id]: 'testing' }))
    try {
      const r = await testConnection({ connectionId: c.id })
      setChecks((s) => ({ ...s, [c.id]: r }))
    } catch {
      setChecks((s) => ({ ...s, [c.id]: { ok: false, code: 'unreachable' } }))
    }
  }

  const remove = async (c: ModelConnection) => {
    if (!window.confirm(t('models.confirmDelete', { name: connectionLabel(c, providers, t) }))) return
    try {
      onChange(await deleteConnection(c.id))
    } catch (err) {
      setError(err instanceof FieldErrors && err.errors[0] ? fieldText(t, err.errors[0]) : String(err))
    }
  }

  const editingConnection = editing && editing !== 'new' ? state.connections.find((c) => c.id === editing.id) : undefined

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal modal-wide" role="dialog" aria-label={t('models.title')} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">{t('models.title')}</div>
          <button className="modal-close" onClick={onClose} aria-label={t('models.close')}>×</button>
        </div>
        {editing ? (
          <ConnectionForm
            key={editing === 'new' ? 'new' : editing.id}
            initial={editingConnection}
            providers={providers}
            onSaved={(next) => { onChange(next); setEditing(null) }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <>
            <p className="conn-intro">{t('models.intro')}</p>
            <div className="conn-list">
              {state.connections.map((c) => {
                const p = providers.find((x) => x.id === c.provider)
                const who = users[c.id]
                return (
                  <div className="conn-card" key={c.id}>
                    <div className="conn-card-head">
                      <span className="conn-name">{connectionLabel(c, providers, t)}</span>
                      {c.builtIn ? <span className="conn-badge" title={t('models.defaultHint')}>{t('models.default')}</span> : null}
                      <span className="conn-model">{c.model}</span>
                    </div>
                    <div className="conn-meta">
                      <span>
                        {c.key.source === 'env' ? t('models.keyFromEnv')
                          : c.key.set ? t('models.keySet', { masked: c.key.masked })
                            : p && !p.needsKey ? t('models.noKeyNeeded') : t('models.noKey')}
                      </span>
                      <span>·</span>
                      <span>{who?.length ? t('models.usedBy', { names: who.join(t.lang === 'zh-CN' ? '、' : ', ') }) : t('models.usedByNobody')}</span>
                    </div>
                    <CheckLine result={checks[c.id]} model={c.model} />
                    <div className="conn-actions">
                      <button onClick={() => void test(c)} disabled={checks[c.id] === 'testing'}>{t('models.test')}</button>
                      <button onClick={() => setEditing({ id: c.id })}>{t('models.edit')}</button>
                      {c.builtIn ? null : <button className="danger" onClick={() => void remove(c)}>{t('models.delete')}</button>}
                    </div>
                  </div>
                )
              })}
            </div>
            {error ? <div className="form-error" role="alert">{error}</div> : null}
            <button className="conn-add" onClick={() => setEditing('new')}>+ {t('models.add')}</button>
          </>
        )}
      </div>
    </div>
  )
}

type Draft = { provider: string; name: string; apiKey: string; baseURL: string; api: LlmApi; model: string; vision: boolean }

function draftFrom(c: ModelConnection | undefined, providers: ProviderPreset[]): Draft {
  if (c) return { provider: c.provider || 'custom', name: c.name, apiKey: '', baseURL: c.baseURL, api: c.api, model: c.model, vision: c.vision }
  const p = providers.find((x) => x.region !== 'custom') ?? providers[0]
  return { provider: p?.id ?? 'custom', name: '', apiKey: '', baseURL: p?.baseURL ?? '', api: p?.api ?? 'chat', model: p?.defaultModel ?? '', vision: p?.vision ?? false }
}

/** 新加或编辑一个连接。默认连接被环境变量锁住的字段只读。 */
export function ConnectionForm({ initial, providers, onSaved, onCancel }: {
  initial?: ModelConnection
  providers: ProviderPreset[]
  onSaved: (next: ConnectionsState) => void
  onCancel: () => void
}) {
  const t = useT()
  const [draft, setDraft] = useState<Draft>(() => draftFrom(initial, providers))
  const [check, setCheck] = useState<CheckResult | 'testing' | undefined>()
  const [models, setModels] = useState<string[]>([])
  const [errors, setErrors] = useState<FieldError[]>([])
  const [saving, setSaving] = useState(false)
  const [planOk, setPlanOk] = useState(false)
  const preset = providers.find((p) => p.id === draft.provider)
  const locked = new Set(initial?.locked ?? [])
  const isCustom = !preset || preset.id === 'custom'
  const needsPlanOk = Boolean(preset?.plan) && !planOk && initial?.provider !== draft.provider
  const errorFor = (key: string) => errors.find((e) => e.key === key)

  const pickProvider = (id: string) => {
    const p = providers.find((x) => x.id === id)
    const was = providers.find((x) => x.id === draft.provider)
    // 换了服务商，刚粘的 key 一起清掉：一家的 key 绝不带去另一家。环境变量定死的字段保持原样；
    // 名字还是上一家的预设名（没人改过）就跟着换
    setDraft((d) => ({
      ...d,
      provider: id,
      apiKey: '',
      name: d.name === was?.name ? '' : d.name,
      api: p?.api ?? 'chat',
      baseURL: locked.has('baseURL') ? d.baseURL : p?.baseURL ?? '',
      model: locked.has('model') ? d.model : p?.defaultModel ?? '',
      vision: locked.has('vision') ? d.vision : p?.vision ?? false,
    }))
    setErrors([])
    setCheck(undefined)
    setModels([])
    setPlanOk(false)
  }

  /** 编辑时只发改过的字段（没改的锁定字段不能出现在请求里）；key 留空 = 不动 */
  const fields = (): ConnectionFields => {
    const out: ConnectionFields = {}
    const was = initial ? draftFrom(initial, providers) : undefined
    // 环境变量定死的字段一律不发（发了网关就回 locked）
    const changed = <K extends keyof Draft>(k: K) => !locked.has(k) && (!was || draft[k] !== was[k])
    if (changed('provider')) out.provider = draft.provider
    if (changed('name') && !initial?.builtIn) out.name = draft.name.trim()
    if (changed('baseURL')) out.baseURL = draft.baseURL.trim()
    if (changed('api') && isCustom && !initial?.builtIn) out.api = draft.api
    if (changed('model')) out.model = draft.model.trim()
    if (changed('vision')) out.vision = draft.vision
    if (draft.apiKey.trim()) out.apiKey = draft.apiKey.trim()
    return out
  }

  const runTest = async () => {
    setCheck('testing')
    try {
      const r = await testConnection({ ...(initial ? { connectionId: initial.id } : {}), ...fields() })
      setCheck(r)
      const listed = r.ok ? r.models : r.models ?? []
      if (listed.length) setModels(listed)
      setErrors([])
    } catch (err) {
      setCheck(undefined)
      setErrors(err instanceof FieldErrors ? err.errors : [{ key: '', code: 'invalid' }])
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      onSaved(initial ? await updateConnection(initial.id, fields()) : await createConnection(fields()))
    } catch (err) {
      setErrors(err instanceof FieldErrors ? err.errors : [{ key: '', code: 'invalid' }])
    } finally {
      setSaving(false)
    }
  }

  const label = (key: MessageKey, field: string) => (
    <span className="conn-label">
      {t(key)}{locked.has(field) ? <span className="conn-locked"> · {t('models.form.lockedBy')}</span> : null}
    </span>
  )
  const err = (field: string) => {
    const e = errorFor(field)
    return e ? <div className="form-error" role="alert">{fieldText(t, e)}</div> : null
  }
  const note = NOTES[draft.provider]

  return (
    <form className="conn-form" onSubmit={(e) => { e.preventDefault(); if (!needsPlanOk) void save() }}>
      <div className="conn-form-title">
        {initial ? t('models.form.editTitle', { name: connectionLabel(initial, providers, t) }) : t('models.form.newTitle')}
      </div>
      <label>
        {label('models.form.provider', 'provider')}
        <select value={draft.provider} onChange={(e) => pickProvider(e.target.value)} disabled={locked.has('provider')}>
          {REGIONS.map((region) => {
            const inRegion = providers.filter((p) => p.region === region)
            return inRegion.length ? (
              <optgroup key={region} label={t(`models.region.${region}` as MessageKey)}>
                {inRegion.map((p) => <option key={p.id} value={p.id}>{p.id === 'custom' ? t('models.custom') : p.name}</option>)}
              </optgroup>
            ) : null
          })}
        </select>
        {err('provider')}
      </label>
      {note ? <p className="conn-note">{t(note)}</p> : null}
      {preset?.plan ? (
        <div className="conn-plan" role="note">
          <p>{t('models.planWarning')}</p>
          {needsPlanOk ? (
            <label className="conn-check-row">
              <input type="checkbox" checked={planOk} onChange={(e) => setPlanOk(e.target.checked)} />
              {t('models.form.planAgree')}
            </label>
          ) : null}
        </div>
      ) : null}
      {initial?.builtIn ? null : (
        <label>
          {label('models.form.name', 'name')}
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={preset && !isCustom ? preset.name : ''} />
          {err('name')}
        </label>
      )}
      {preset && !preset.needsKey ? null : (
        <label>
          <span className="conn-label">
            {t('models.form.apiKey')}{locked.has('apiKey') ? <span className="conn-locked"> · {t('models.form.lockedBy')}</span> : null}
            {preset?.keyUrl ? <a className="conn-link" href={preset.keyUrl} target="_blank" rel="noreferrer">{t('models.form.getKey')} ↗</a> : null}
          </span>
          <input
            type="password" autoComplete="off" spellCheck={false} value={draft.apiKey} disabled={locked.has('apiKey')}
            onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            placeholder={initial?.key.set ? `${initial.key.masked} — ${t('models.form.apiKeyKeep')}` : ''}
          />
          {err('apiKey')}
        </label>
      )}
      <label>
        {label('models.form.baseURL', 'baseURL')}
        <input value={draft.baseURL} disabled={locked.has('baseURL')} spellCheck={false} onChange={(e) => setDraft({ ...draft, baseURL: e.target.value })} />
        {err('baseURL')}
      </label>
      {isCustom && !initial?.builtIn ? (
        <label>
          {label('models.form.api', 'api')}
          <select value={draft.api} onChange={(e) => setDraft({ ...draft, api: e.target.value as LlmApi })}>
            {APIS.map((a) => <option key={a} value={a}>{t(`models.form.api.${a}` as MessageKey)}</option>)}
          </select>
          {err('api')}
        </label>
      ) : null}
      <label>
        {label('models.form.model', 'model')}
        <input
          value={draft.model} list="conn-models" disabled={locked.has('model')} spellCheck={false}
          onChange={(e) => setDraft({ ...draft, model: e.target.value })}
        />
        <datalist id="conn-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
        {err('model')}
      </label>
      <label className="conn-check-row">
        <input type="checkbox" checked={draft.vision} disabled={locked.has('vision')} onChange={(e) => setDraft({ ...draft, vision: e.target.checked })} />
        {t('models.form.vision')}
      </label>
      {err('')}
      <CheckLine result={check} model={draft.model} />
      <div className="conn-form-buttons">
        <button type="button" onClick={() => void runTest()} disabled={check === 'testing' || needsPlanOk}>{t('models.test')}</button>
        <span className="spacer" />
        <button type="button" onClick={onCancel}>{t('models.form.cancel')}</button>
        <button type="submit" className="primary" disabled={saving || needsPlanOk}>{t('models.form.save')}</button>
      </div>
    </form>
  )
}
