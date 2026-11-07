import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionsState, ModelConnection, ProviderPreset } from '../types'
import { BotModelChip, BotModelPicker } from './BotModelPicker'
import { ModelsDialog } from './ModelsDialog'

const providers: ProviderPreset[] = [
  { id: 'deepseek', name: 'DeepSeek', region: 'cn', api: 'chat', baseURL: 'https://api.deepseek.com', needsKey: true, keyUrl: 'https://platform.deepseek.com/api_keys', defaultModel: 'deepseek-flash', vision: true, docsUrl: '' },
  { id: 'anthropic', name: 'Claude', region: 'global', api: 'anthropic', baseURL: 'https://api.anthropic.com', needsKey: true, keyUrl: 'https://platform.claude.com/settings/keys', defaultModel: 'claude-opus-5-5', vision: true, docsUrl: '' },
  { id: 'glm-coding', name: 'GLM Coding Plan', region: 'cn', api: 'chat', plan: true, baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', needsKey: true, keyUrl: '', defaultModel: 'glm-5.3', vision: false, docsUrl: '' },
  { id: 'custom', name: 'OpenAI-compatible', region: 'custom', api: 'chat', baseURL: '', needsKey: true, keyUrl: '', defaultModel: '', vision: false, docsUrl: '' },
]

const main: ModelConnection = {
  id: 'main', name: 'DeepSeek', provider: 'deepseek', api: 'chat', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', vision: true,
  builtIn: true, key: { set: true, masked: 'sk-…1234', source: 'file' }, locked: [],
}
const claude: ModelConnection = {
  id: 'c-12345678', name: 'Claude', provider: 'anthropic', api: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-opus-5-5',
  vision: true, builtIn: false, key: { set: true, masked: 'sk-…mnop', source: 'file' }, locked: [],
}
const state: ConnectionsState = {
  connections: [main, claude],
  bots: { researcher: { connectionId: 'c-12345678', model: 'claude-haiku-5-5' }, chief: { connectionId: 'main', model: null } },
}
const roster = { researcher: { name: 'Scout', emoji: '🔎' }, chief: { name: 'Chief', emoji: '🎖' } }

/** 装成网关：按路径回预先写好的 JSON，记下请求体 */
function mockFetch(routes: Record<string, (body: unknown) => { status?: number; body: unknown }>) {
  const calls: { method: string; path: string; body: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const method = init?.method ?? 'GET'
    calls.push({ method, path, body })
    const route = routes[`${method} ${path}`]
    const reply = route ? route(body) : { status: 404, body: {} }
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}

afterEach(() => { vi.unstubAllGlobals() })

describe('ModelsDialog', () => {
  it('lists the default connection first, with who uses what, and never a raw key', () => {
    render(<ModelsDialog state={state} providers={providers} roster={roster} onChange={() => {}} onClose={() => {}} />)
    const cards = screen.getAllByText(/Key sk-…/).map((el) => el.closest('.conn-card') as HTMLElement)
    expect(within(cards[0]!).getByText('Default')).toBeInTheDocument()
    expect(within(cards[0]!).getByText('Used by Chief')).toBeInTheDocument()
    expect(within(cards[1]!).getByText('Used by Scout')).toBeInTheDocument()
    // 默认连接没有删除按钮
    expect(within(cards[0]!).queryByRole('button', { name: 'Delete' })).toBeNull()
    expect(within(cards[1]!).getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('adds a Claude connection with its preset filled in, and says which key to use', async () => {
    const calls = mockFetch({ 'POST /api/connections': () => ({ status: 201, body: { ...state, created: 'c-87654321' } }) })
    const onChange = vi.fn()
    render(<ModelsDialog state={{ ...state, connections: [main] }} providers={providers} roster={roster} onChange={onChange} onClose={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /Add a connection/ }))
    await userEvent.selectOptions(screen.getByLabelText(/^Service/), 'anthropic')
    expect(screen.getByText(/Claude Pro or Max sign-in cannot be used here/)).toBeInTheDocument()
    expect(screen.getByDisplayValue('claude-opus-5-5')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText(/API key/), 'sk-ant-api03-abcdefghijklmnop')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(calls[0]!.body).toEqual({
      provider: 'anthropic', name: '', baseURL: 'https://api.anthropic.com', model: 'claude-opus-5-5', vision: true,
      apiKey: 'sk-ant-api03-abcdefghijklmnop',
    })
  })

  it('shows the gateway’s reason next to the field it refused', async () => {
    mockFetch({ 'POST /api/connections': () => ({ status: 400, body: { error: 'invalid_connection', errors: [{ key: 'apiKey', code: 'subscription_token' }] } }) })
    render(<ModelsDialog state={state} providers={providers} roster={roster} onChange={() => {}} onClose={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /Add a connection/ }))
    await userEvent.selectOptions(screen.getByLabelText(/^Service/), 'anthropic')
    await userEvent.type(screen.getByLabelText(/API key/), 'sk-ant-oat01-abcdefghijklmnop')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Claude subscription sign-in token')
  })

  it('makes you read the terms before saving a subscription plan key', async () => {
    render(<ModelsDialog state={state} providers={providers} roster={roster} onChange={() => {}} onClose={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /Add a connection/ }))
    await userEvent.selectOptions(screen.getByLabelText(/^Service/), 'glm-coding')
    expect(screen.getByRole('note')).toHaveTextContent('subscription plan key')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await userEvent.click(screen.getByLabelText('I understand, use it anyway'))
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('edits only what changed, and keeps the stored key unless a new one is typed', async () => {
    const calls = mockFetch({ 'PATCH /api/connections/c-12345678': () => ({ body: state }) })
    render(<ModelsDialog state={state} providers={providers} roster={roster} onChange={() => {}} onClose={() => {}} />)
    const card = screen.getByText('Used by Scout').closest('.conn-card') as HTMLElement
    await userEvent.click(within(card).getByRole('button', { name: 'Edit' }))
    const model = screen.getByDisplayValue('claude-opus-5-5')
    await userEvent.clear(model)
    await userEvent.type(model, 'claude-sonnet-5-5')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.body).toEqual({ model: 'claude-sonnet-5-5' })
  })

  it('switches the default connection without touching what an environment variable pins', async () => {
    const calls = mockFetch({ 'PATCH /api/connections/main': () => ({ body: state }) })
    const pinned = { ...main, locked: ['model'] }
    render(<ModelsDialog state={{ ...state, connections: [pinned, claude] }} providers={providers} roster={roster} onChange={() => {}} onClose={() => {}} />)
    const card = screen.getByText('Used by Chief').closest('.conn-card') as HTMLElement
    await userEvent.click(within(card).getByRole('button', { name: 'Edit' }))
    await userEvent.selectOptions(screen.getByLabelText(/^Service/), 'custom')
    expect(screen.getByDisplayValue('deepseek-flash')).toBeDisabled()
    // 默认连接存不了接口，不给选
    expect(screen.queryByLabelText(/^Speaks/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.body).not.toHaveProperty('model')
    expect(calls[0]!.body).toMatchObject({ provider: 'custom', baseURL: '' })
  })

  it('clears a pasted key when you switch to another service', async () => {
    render(<ModelsDialog state={state} providers={providers} roster={roster} onChange={() => {}} onClose={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /Add a connection/ }))
    await userEvent.type(screen.getByLabelText(/API key/), 'sk-deepseek-abcdefghijklmnop')
    await userEvent.selectOptions(screen.getByLabelText(/^Service/), 'anthropic')
    expect(screen.getByLabelText(/API key/)).toHaveValue('')
  })

  it('tests a stored connection and says what came back', async () => {
    mockFetch({ 'POST /api/connections/test': () => ({ body: { ok: false, code: 'quota', status: 402, detail: 'insufficient balance' } }) })
    render(<ModelsDialog state={state} providers={providers} roster={roster} onChange={() => {}} onClose={() => {}} />)
    const card = screen.getByText('Used by Scout').closest('.conn-card') as HTMLElement
    await userEvent.click(within(card).getByRole('button', { name: 'Test' }))
    expect(await within(card).findByRole('status')).toHaveTextContent('out of credit or quota')
  })
})

describe('picking a teammate’s AI', () => {
  it('shows the connection and model on the thread header', () => {
    render(<BotModelChip botId="researcher" state={state} providers={providers} onOpen={() => {}} />)
    expect(screen.getByRole('button')).toHaveTextContent('Claude · claude-haiku-5-5')
    render(<BotModelChip botId="chief" state={state} providers={providers} onOpen={() => {}} />)
    expect(screen.getAllByRole('button')[1]).toHaveTextContent('DeepSeek · deepseek-flash')
  })

  it('saves a new connection for the teammate, using the connection default when the model is left empty', async () => {
    const calls = mockFetch({
      'GET /api/connections/main/models': () => ({ body: { ok: true, models: ['deepseek-flash', 'deepseek-pro'] } }),
      'GET /api/connections/c-12345678/models': () => ({ body: { ok: true, models: [] } }),
      'PUT /api/bots/researcher/llm': (body) => ({ body }),
    })
    const onSaved = vi.fn()
    render(<BotModelPicker botId="researcher" botName="Scout" state={state} providers={providers} onSaved={onSaved} onManage={() => {}} onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: 'Which AI does Scout use?' })).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Connection'), 'main')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('researcher', { connectionId: 'main', model: null }))
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ connectionId: 'main', model: null })
  })
})
