import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaContentBlock, BetaContentBlockParam, BetaMessage, BetaMessageParam, BetaToolUnion, MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { EARLIER_SCREENSHOT, safeParseJson, type AssistantTurn, type ChatMsg, type LLM, type LlmTarget, type ToolCall, type ToolDef } from './llm.js'
import { isSubscriptionToken } from './settings.js'

/**
 * Claude 的原生接口（Messages API），走官方 SDK。网关内部的对话一律是 OpenAI 的消息格式，这里来回翻译：
 * - system 单独放；工具结果是 user 消息里的 tool_result 块，紧跟在发起调用的那条 assistant 后面。
 * - Claude 回的 content 块（含思考块和签名）原样存进 raw.native，同一回合里原样发回去。
 * - 历史尽量只追加不改：改了前面的消息，后面的思考块就不认了。旧截图多到一定数量才成批换成占位
 *   （请求体有 32MB 上限），换的时候在官方 API 上声明 drop_block：让它丢掉对不上的思考块，而不是整个请求 400。
 * - 只用连接自己的 key：SDK 默认会去读这台机器上的 Anthropic 凭据（环境变量、配置文件），连接没 key 时它们就会被发往
 *   连接填的地址。所以没 key 直接报错，环境里的自定义请求头也去掉。
 * Claude 订阅（Pro/Max）的登录令牌不能在这里用：官方只许第三方应用用 API key（见 settings.ts 的 isSubscriptionToken）。
 */

/** 非流式请求的输出上限：够一步工具调用加一段汇报，又不会撞上 SDK 对长请求的超时保护 */
const MAX_TOKENS = 16_000

/** 官方 API 上这些模型支持服务端兜底：被安全分类器拒了，自动换官方推荐的模型重跑同一个请求 */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5'])
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

/** 这些模型默认就是自适应思考，可以声明 drop_block（block_binding 只在自适应思考下有效） */
const ADAPTIVE_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
const BINDING_BETA = 'thinking-binding-controls-2026-08-01'

/**
 * 截图多了要收：最多留最近 10 张，超了一次收掉 5 张，留下 6 张。成批收、不是每步收一张：
 * 每收一次前缀就变一次（缓存失效、对不上的思考块被丢掉），隔 5 步才变一次。返回要换成占位的张数。
 */
export function screenshotsToHide(total: number): number {
  return total <= 10 ? 0 : 5 * Math.floor((total - 6) / 5)
}

const isOfficialApi = (baseURL: string) => {
  try {
    return new URL(baseURL).hostname === 'api.anthropic.com'
  } catch {
    return false
  }
}

/** SDK 自己会拼 /v1；地址里写了 /v1 的（兼容 Claude 接口的第三方常这么写）去掉，免得变成 /v1/v1 */
export const anthropicBase = (baseURL: string) => baseURL.replace(/\/+$/, '').replace(/\/v1$/, '')

/** 这个 key 能不能拿去调 Claude；不能就给一句人话（同事的报错里、测试结果里都用它） */
export function anthropicKeyProblem(apiKey: string): string | null {
  if (!apiKey) return 'This connection has no API key. Add one under AI models (for a local server that needs none, any text will do).'
  if (isSubscriptionToken(apiKey)) {
    return 'That is a Claude subscription sign-in token, which Anthropic does not let other apps use. Create an API key in the Claude Console.'
  }
  return null
}

/**
 * 机器上给别的工具配的 ANTHROPIC_CUSTOM_HEADERS，SDK 会加到每个请求上；连接可能发往第三方地址，一律去掉
 * （SDK 的约定：默认头里的 null 就是删掉这个头）
 */
function envHeadersRemoved(): Record<string, null> {
  const out: Record<string, null> = {}
  for (const line of (process.env.ANTHROPIC_CUSTOM_HEADERS ?? '').split('\n')) {
    const colon = line.indexOf(':')
    const name = colon > 0 ? line.slice(0, colon).trim() : ''
    if (name) out[name] = null
  }
  return out
}

/** 调用前先过 anthropicKeyProblem：这里假定 key 非空，SDK 才不会去翻机器上的凭据 */
export function anthropicClient(target: Pick<LlmTarget, 'baseURL' | 'apiKey' | 'llmTimeoutMs' | 'llmRetries'>, fetchImpl: typeof fetch): Anthropic {
  const problem = anthropicKeyProblem(target.apiKey)
  if (problem) throw new Error(problem)
  return new Anthropic({
    apiKey: target.apiKey,
    authToken: null,
    baseURL: anthropicBase(target.baseURL),
    fetch: fetchImpl,
    maxRetries: target.llmRetries,
    timeout: target.llmTimeoutMs,
    defaultHeaders: {
      ...envHeadersRemoved(),
      // SDK 1.x 用 Bearer 头带 key；兼容 Claude 接口的第三方不少只认 x-api-key，两个都给（官方 API 只给 Bearer）
      ...(isOfficialApi(target.baseURL) ? {} : { 'x-api-key': target.apiKey }),
    },
  })
}

/** tool_use 的 id 只收字母数字、下划线和连字符；别家接口给的 id 先洗一遍（两头用同一个洗法，才配得上） */
const toolId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_') || 'call'

const DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s

function imageBlock(url: string): BetaContentBlockParam {
  const m = DATA_URL.exec(url)
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1] as 'image/png', data: m[2]! } }
  return { type: 'image', source: { type: 'url', url } }
}

type WireToolCall = { id?: string; function?: { name?: string; arguments?: string } }

function assistantBlocks(m: ChatMsg): BetaContentBlockParam[] {
  if (m.native?.api === 'anthropic') return m.native.items as BetaContentBlockParam[]
  const blocks: BetaContentBlockParam[] = []
  if (m.content?.trim()) blocks.push({ type: 'text', text: m.content })
  for (const call of (m.tool_calls ?? []) as WireToolCall[]) {
    const args = safeParseJson(call.function?.arguments)
    blocks.push({
      type: 'tool_use',
      id: toolId(call.id ?? ''),
      name: call.function?.name ?? '',
      input: args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {},
    })
  }
  return blocks
}

/** OpenAI 格式的对话 → system + Claude 的 messages。相邻同角色的并成一条，工具结果排在最前面。hidden = 收掉了几张旧截图 */
export function toAnthropic(messages: ChatMsg[]): { system: string; messages: BetaMessageParam[]; hidden: number } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content ?? '').join('\n\n')
  let toHide = screenshotsToHide(messages.filter((m) => m.images?.length).length)
  const hidden = toHide
  const out: BetaMessageParam[] = []
  const push = (role: 'user' | 'assistant', blocks: BetaContentBlockParam[]) => {
    if (!blocks.length) return
    const last = out[out.length - 1]
    if (last?.role === role) {
      const prev = last.content as BetaContentBlockParam[]
      // 工具结果必须排在这条 user 消息的最前面
      last.content = blocks.some((b) => b.type === 'tool_result')
        ? [...prev.filter((b) => b.type === 'tool_result'), ...blocks.filter((b) => b.type === 'tool_result'),
          ...prev.filter((b) => b.type !== 'tool_result'), ...blocks.filter((b) => b.type !== 'tool_result')]
        : [...prev, ...blocks]
    } else {
      out.push({ role, content: blocks })
    }
  }
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'assistant') {
      push('assistant', assistantBlocks(m))
    } else if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: toolId(m.tool_call_id ?? ''), content: m.content || '(no output)' }])
    } else {
      const blocks: BetaContentBlockParam[] = []
      if (m.images?.length && toHide > 0) {
        toHide--
        push('user', [{ type: 'text', text: EARLIER_SCREENSHOT }])
        continue
      }
      if (m.content?.trim() || !m.images?.length) blocks.push({ type: 'text', text: m.content?.trim() ? m.content : '(empty)' })
      for (const url of m.images ?? []) blocks.push(imageBlock(url))
      push('user', blocks)
    }
  }
  // 第一条必须是 user：历史截断后可能从同事自己的话开头
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: [{ type: 'text', text: '(earlier conversation)' }] })
  return { system, messages: out, hidden }
}

const toTool = (t: ToolDef): BetaToolUnion => ({
  name: t.function.name,
  ...(t.function.description ? { description: t.function.description } : {}),
  input_schema: t.function.parameters as { type: 'object'; [k: string]: unknown },
})

/**
 * 发回去的内容：服务端兜底换过模型时（content 里有 fallback 块），最后一个 fallback 块之前的
 * 思考块和工具调用不能回传；文字和之后的一切照常。
 */
export function echoBlocks(content: BetaContentBlock[]): BetaContentBlock[] {
  let boundary = -1
  content.forEach((b, i) => { if (b.type === 'fallback') boundary = i })
  if (boundary < 0) return content
  const dropBefore = new Set(['thinking', 'redacted_thinking', 'tool_use'])
  return content.filter((b, i) => i >= boundary || !dropBefore.has(b.type))
}

export function fromAnthropic(res: BetaMessage): AssistantTurn {
  if (res.stop_reason === 'refusal') {
    const category = res.stop_details?.category
    throw new Error(`Claude declined this request${category ? ` (${category})` : ''}. Rephrase it, or give this teammate another model.`)
  }
  const blocks = echoBlocks(res.content)
  const text = blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
  // 撞上输出上限：工具参数可能是半截的，没有文字的回复等于没回——都别当正常结束
  if (res.stop_reason === 'max_tokens' && (!text.trim() || blocks.some((b) => b.type === 'tool_use'))) {
    throw new Error('Claude was cut off at its output limit before finishing this step.')
  }
  const toolCalls: ToolCall[] = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => {
      const use = b as { id: string; name: string; input: unknown }
      return { id: use.id, name: use.name, args: use.input ?? {} }
    })
  const raw: ChatMsg = {
    role: 'assistant',
    content: text || null,
    ...(toolCalls.length ? {
      tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
    } : {}),
    native: { api: 'anthropic', items: blocks },
  }
  const u = res.usage
  return {
    content: text || null,
    toolCalls,
    raw,
    usage: {
      // 和 OpenAI 的口径一致：prompt 含缓存命中和缓存写入，cached 只算命中
      prompt: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      completion: u.output_tokens ?? 0,
      cached: u.cache_read_input_tokens ?? 0,
    },
  }
}

/** SDK 的报错翻成网关一贯的说法（界面和日志都认这个） */
export function anthropicError(err: unknown, timeoutMs: number): Error {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new Error(`LLM API timed out after ${timeoutMs / 1000}s`)
  if (err instanceof Anthropic.APIConnectionError) return new Error(`LLM API unreachable: ${err.message}`)
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    return new Error(`LLM API ${err.status}: ${err.message.slice(0, 300)}`)
  }
  return err instanceof Error ? err : new Error(String(err))
}

export function createAnthropicLLM(target: LlmTarget, fetchImpl: typeof fetch): LLM {
  const official = isOfficialApi(target.baseURL)
  const fallback = official && FALLBACK_MODELS.has(target.model)
  let client: Anthropic | undefined
  return {
    async chat(messages, tools, opts = {}) {
      // key 有问题就在回合里报出来（同事的对话里看得见），不在造客户端时炸
      client ??= anthropicClient(target, fetchImpl)
      const { system, messages: wire, hidden } = toAnthropic(messages)
      // 收过旧截图：在官方 API 上声明丢掉对不上的思考块，免得整个请求 400（第三方兼容口不认这个字段）
      const dropBlocks = hidden > 0 && official && ADAPTIVE_MODELS.has(target.model)
      const betas = [...(fallback ? [FALLBACK_BETA] : []), ...(dropBlocks ? [BINDING_BETA] : [])]
      const params: MessageCreateParamsNonStreaming = {
        ...(target.extraBody as Partial<MessageCreateParamsNonStreaming>),
        model: target.model,
        max_tokens: MAX_TOKENS,
        // 自动缓存：一回合里每一步都重读同一段前缀（系统提示词、工具、之前的步骤），命中按约 5% 的价格计
        cache_control: { type: 'ephemeral' },
        ...(system ? { system } : {}),
        messages: wire,
        ...(tools.length ? { tools: tools.map(toTool) } : {}),
        ...(tools.length && opts.toolChoice ? { tool_choice: { type: 'none' as const } } : {}),
        ...(fallback ? { fallbacks: 'default' as const } : {}),
        ...(dropBlocks ? { thinking: { type: 'adaptive' as const, block_binding: { prefix_mismatch_behavior: 'drop_block' as const } } } : {}),
        ...(betas.length ? { betas } : {}),
      }
      try {
        const res = await client.beta.messages.create(params, opts.signal ? { signal: opts.signal } : undefined)
        return fromAnthropic(res)
      } catch (err) {
        if (opts.signal?.aborted) throw err // 操作者按了停止
        throw anthropicError(err, target.llmTimeoutMs)
      }
    },
  }
}
