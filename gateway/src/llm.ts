import type { Config } from './config.js'

export type ChatMsg = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: unknown[]
}

export type ToolDef = { type: 'function'; function: { name: string; description?: string; parameters: unknown } }
export type ToolCall = { id: string; name: string; args: unknown }
export type AssistantTurn = { content: string | null; toolCalls: ToolCall[]; raw: ChatMsg }

export interface LLM {
  chat(messages: ChatMsg[], tools: ToolDef[]): Promise<AssistantTurn>
}

export function createLLM(config: Config, fetchImpl: typeof fetch = fetch): LLM {
  if (config.model === 'stub') return createStubLLM()
  return {
    async chat(messages, tools) {
      const res = await fetchImpl(`${config.baseURL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: config.model, messages, ...(tools.length ? { tools } : {}) }),
      })
      if (!res.ok) {
        throw new Error(`LLM API ${res.status}: ${(await res.text()).slice(0, 300)}`)
      }
      type WireToolCall = { id: string; function?: { name?: string; arguments?: string } }
      const data = (await res.json()) as {
        choices?: { message?: { role: 'assistant'; content?: string | null; tool_calls?: WireToolCall[] } }[]
      }
      const msg = data.choices?.[0]?.message
      if (!msg) throw new Error('LLM API: empty choices')
      return {
        content: msg.content ?? null,
        toolCalls: (msg.tool_calls ?? []).map((t) => ({
          id: t.id,
          name: t.function?.name ?? '',
          args: safeParseJson(t.function?.arguments),
        })),
        raw: msg as ChatMsg,
      }
    },
  }
}

function safeParseJson(s: unknown): unknown {
  if (typeof s !== 'string') return null
  try { return JSON.parse(s) } catch { return null }
}

function stubToolTurn(name: string, args: unknown): AssistantTurn {
  const id = `stub-${name}`
  return {
    content: null,
    toolCalls: [{ id, name, args }],
    raw: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
  }
}

function stubText(content: string): AssistantTurn {
  return { content, toolCalls: [], raw: { role: 'assistant', content } }
}

/** 最后一条用户消息里提到的网址，用来触发 stub 的浏览器脚本。 */
function findUrl(messages: ChatMsg[]): string | null {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  const match = lastUser.match(/\bhttps?:\/\/\S+|\b[a-z0-9-]+\.(?:com|org|net|io|dev|ai)\b/i)
  if (!match) return null
  return match[0].startsWith('http') ? match[0] : `https://${match[0]}`
}

/**
 * OPENGROKBOT_MODEL=stub：离线 dev/e2e 用的脚本化假模型。
 * 提到网址就走「开网页 → 截图贴回聊天」，否则发一条标准汇报 chip。
 */
function createStubLLM(): LLM {
  return {
    async chat(messages) {
      const last = messages[messages.length - 1]
      if (last?.role === 'tool') {
        const result = String(last.content ?? '')
        // 刚导航完就拍张照贴回线程，凑齐 M2 的验收链路
        if (result.startsWith('Now on ')) {
          return stubToolTurn('browser_screenshot', { caption: result.slice('Now on '.length, 120) })
        }
        return stubText('All filed. Ping me when you want the next pass.')
      }
      const url = findUrl(messages)
      if (url) return stubToolTurn('browser_goto', { url })
      const args = {
        kind: 'report',
        payload: {
          lines: [
            { system: 'Web', result: 'sources reviewed', count: '6 pages' },
            { system: 'Brief', result: 'drafted', count: '0 sent' },
          ],
          closing: 'One thing needs you today: approve the brief and I will file it.',
        },
      }
      const toolCall = { id: 'stub-1', type: 'function', function: { name: 'message_user', arguments: JSON.stringify(args) } }
      return {
        content: null,
        toolCalls: [{ id: 'stub-1', name: 'message_user', args }],
        raw: { role: 'assistant', content: null, tool_calls: [toolCall] },
      }
    },
  }
}
