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

/** OPENGROKBOT_MODEL=stub：离线 dev/e2e 用的脚本化假模型。 */
function createStubLLM(): LLM {
  return {
    async chat(messages) {
      const last = messages[messages.length - 1]
      if (last?.role === 'tool') {
        return {
          content: 'All filed. Ping me when you want the next pass.',
          toolCalls: [],
          raw: { role: 'assistant', content: 'All filed. Ping me when you want the next pass.' },
        }
      }
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
