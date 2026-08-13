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

function lastUserText(messages: ChatMsg[]): string {
  return [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
}

/** 名字或 id 都能指到同一个同事，让 stub 听得懂「ask ticker to …」。 */
const TEAMMATE_IDS: Record<string, string> = {
  chief: 'chief',
  scout: 'researcher',
  researcher: 'researcher',
  ticker: 'market-watch',
  'market-watch': 'market-watch',
  sorter: 'inbox-keeper',
  'inbox-keeper': 'inbox-keeper',
}

/** 「ask ticker to price it」这类说法 → 该转交给谁。 */
function findTeammate(text: string): string | null {
  const match = text.toLowerCase()
    .match(/\b(?:ask|hand|tell|pass|route)\b[^.]*?\b(chief|scout|researcher|ticker|market-watch|sorter|inbox-keeper)\b/)
  return match ? TEAMMATE_IDS[match[1]!] ?? null : null
}

/** 最后一条用户消息里提到的网址，用来触发 stub 的浏览器脚本。 */
function findUrl(messages: ChatMsg[]): string | null {
  const match = lastUserText(messages).match(/\bhttps?:\/\/\S+|\b[a-z0-9-]+\.(?:com|org|net|io|dev|ai)\b/i)
  if (!match) return null
  return match[0].startsWith('http') ? match[0] : `https://${match[0]}`
}

/**
 * OPENGROKBOT_MODEL=stub：离线 dev/e2e 用的脚本化假模型。
 * 按用户说的话挑一条链路走：网址 → 开网页并截图；「每天」→ 建 routine；
 * 「以后/from now on」→ 存规矩；「send/reply」→ 扣住等审批；其余发标准汇报 chip。
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
        if (result.startsWith('Held for')) return stubText('Holding until you say go.')
        if (/^Routine .* scheduled/.test(result)) return stubText('Locked in. I will run it and report.')
        if (result.startsWith('Rule saved')) return stubText('Noted for next time.')
        if (result.startsWith('Handed to')) return stubText('Handed off. I will fold their answer in when it lands.')
        if (/not allowlisted/i.test(result)) return stubText('I cannot reach them directly — routing it through Chief instead.')
        if (/^Asked your operator to sign in/.test(result)) return stubText('Waiting on you. Ping me once you are in.')
        if (result.startsWith('That rule was already')) return stubText('Already had that one on file.')
        return stubText('All filed. Ping me when you want the next pass.')
      }

      const text = lastUserText(messages)
      const lower = text.toLowerCase()
      // 放行/驳回后的续跑 seed 本身含 "send" 之类的字眼，先认出它，否则会再扣一次审批扣到死循环
      if (text.startsWith('Your operator approved:')) {
        return stubText('Sent — all four went out. Nothing else needs you.')
      }
      if (text.startsWith('Your operator discarded:')) {
        return stubText('Dropped it. Nothing went out.')
      }
      // 群里：Chief 收口发分派表，其他人各报各的；被转交的一方直接接活
      if (/post the dispatch table/i.test(text)) {
        return stubText(
          '✓ Pricing → @market-watch · Friday\n✓ Brief → @researcher · Thursday\n'
          + 'One thing needs you today: pick the deadline for the Globex reply.',
        )
      }
      if (/answer for your own patch/i.test(text)) {
        return stubText('Nothing blocking on my side.')
      }
      if (/handed you this:/i.test(text)) {
        return stubText('Got it — picking it up now.')
      }
      // 点名同事的要在「send/reply 扣审批」之前判，否则「tell sorter to reply」会被当成对外动作
      const teammate = findTeammate(text)
      if (teammate) {
        return stubToolTurn('message_bot', { to: teammate, content: `${text.trim()} — needed by Friday.` })
      }
      // 登录墙：要人接管，绝不在聊天里问密码
      const wall = lower.match(/\b(zendesk|linkedin|salesforce|jira|notion)\b/)
      if (wall || /\b(log in|login|sign in|signin)\b/.test(lower)) {
        const site = wall ? wall[1]!.replace(/^\w/, (ch) => ch.toUpperCase()) : 'the site'
        return stubToolTurn('ask_for_login', { site, why: 'so I can work the queue for you' })
      }
      if (/(every day|each day|every morning|daily|每天)/.test(lower)) {
        return stubToolTurn('create_routine', {
          name: 'Morning digest',
          cron: '0 9 * * *',
          instructions: 'Post the morning digest for my list.',
        })
      }
      if (/(from now on|always|never|以后|从现在起)/.test(lower)) {
        return stubToolTurn('save_memory', {
          rule: text.replace(/^\s*(from now on|always)\s*,?\s*/i, '').trim(),
        })
      }
      if (/\b(send|email|reply|replies|post|publish)\b/.test(lower)) {
        return stubToolTurn('hold_for_approval', {
          action: 'send the 4 queued drafts',
          detail: 'Four replies are drafted and ready to go out.',
        })
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
