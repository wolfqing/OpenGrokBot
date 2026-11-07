import {
  latestImageOnly, postJson, safeParseJson, type AssistantTurn, type ChatMsg, type LLM, type LlmTarget, type Sleep, type ToolCall, type ToolDef,
} from './llm.js'

/**
 * OpenAI 的 Responses 接口（xAI 也有同样的一套）。GPT-6 系列只有在这里才能边推理边调工具。
 * 服务端不存对话（store: false）：推理项带着加密内容回来，同一回合里原样发回去，推理才接得上。
 */

type WireItem = Record<string, unknown> & { type?: string }

type WireResponse = {
  status?: string
  incomplete_details?: { reason?: string } | null
  error?: { message?: string } | null
  output?: WireItem[]
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } }
}

type WireToolCall = { id?: string; function?: { name?: string; arguments?: string } }

/**
 * 原样回传（id 也留着，官方 SDK 和 Codex 都这么做）。只有一种要剔掉：没带加密内容的推理项——
 * 服务端没存（store: false），它会拿 id 去找，找不到就整个请求报错
 */
const echoable = (item: WireItem) => item.type !== 'reasoning' || typeof item.encrypted_content === 'string'

function userContent(m: ChatMsg): string | WireItem[] {
  if (!m.images?.length) return m.content ?? ''
  return [
    { type: 'input_text', text: m.content ?? '' },
    ...m.images.map((url) => ({ type: 'input_image', image_url: url })),
  ]
}

/** OpenAI 格式的对话 → instructions + Responses 的 input 项 */
export function toResponses(messages: ChatMsg[]): { instructions: string; input: WireItem[] } {
  const instructions = messages.filter((m) => m.role === 'system').map((m) => m.content ?? '').join('\n\n')
  const input: WireItem[] = []
  for (const m of latestImageOnly(messages)) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id ?? '', output: m.content ?? '' })
    } else if (m.role === 'user') {
      input.push({ role: 'user', content: userContent(m) })
    } else if (m.native?.api === 'responses') {
      input.push(...(m.native.items as WireItem[]).filter(echoable))
    } else {
      if (m.content?.trim()) input.push({ role: 'assistant', content: m.content })
      for (const call of (m.tool_calls ?? []) as WireToolCall[]) {
        input.push({ type: 'function_call', call_id: call.id ?? '', name: call.function?.name ?? '', arguments: call.function?.arguments ?? '{}' })
      }
    }
  }
  return { instructions, input }
}

const toTool = (t: ToolDef): WireItem => ({
  type: 'function',
  name: t.function.name,
  ...(t.function.description ? { description: t.function.description } : {}),
  parameters: t.function.parameters,
  // 严格模式要求每个参数都必填，我们的工具有选填参数
  strict: false,
})

export function fromResponses(data: WireResponse): AssistantTurn {
  if (data.status === 'failed') throw new Error(`LLM API: ${data.error?.message ?? 'the response failed'}`)
  const output = data.output ?? []
  const text = output
    .filter((item) => item.type === 'message')
    .flatMap((item) => (item.content as { type?: string; text?: string }[] | undefined) ?? [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text ?? '')
    .join('')
  const toolCalls: ToolCall[] = output
    .filter((item) => item.type === 'function_call')
    .map((item) => ({ id: String(item.call_id ?? ''), name: String(item.name ?? ''), args: safeParseJson(item.arguments) }))
  // 没答完（撞上输出上限之类）：工具参数可能是半截的，没有文字的回复等于没回——都别当正常结束
  if (data.status === 'incomplete' && (!text.trim() || toolCalls.length)) {
    throw new Error(`LLM API: the reply was cut off (${data.incomplete_details?.reason ?? 'incomplete'}) before finishing this step`)
  }
  const raw: ChatMsg = {
    role: 'assistant',
    content: text || null,
    ...(toolCalls.length ? {
      tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
    } : {}),
    native: { api: 'responses', items: output },
  }
  const u = data.usage
  return {
    content: text || null,
    toolCalls,
    raw,
    ...(u ? { usage: { prompt: u.input_tokens ?? 0, completion: u.output_tokens ?? 0, cached: u.input_tokens_details?.cached_tokens ?? 0 } } : {}),
  }
}

export function createResponsesLLM(target: LlmTarget, fetchImpl: typeof fetch, sleep: Sleep): LLM {
  const url = `${target.baseURL.replace(/\/$/, '')}/responses`
  return {
    async chat(messages, tools, opts = {}) {
      const { instructions, input } = toResponses(messages)
      const body = JSON.stringify({
        store: false,
        include: ['reasoning.encrypted_content'],
        ...target.extraBody,
        model: target.model,
        ...(instructions ? { instructions } : {}),
        input,
        ...(tools.length ? { tools: tools.map(toTool) } : {}),
        ...(tools.length && opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
      })
      return fromResponses(await postJson<WireResponse>(url, body, target, opts, fetchImpl, sleep))
    },
  }
}
