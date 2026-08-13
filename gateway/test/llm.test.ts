import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createLLM, type ChatMsg, type ToolDef } from '../src/llm.js'

const toolDefs: ToolDef[] = [{ type: 'function', function: { name: 'message_user', parameters: {} } }]

describe('createLLM (openai-compatible)', () => {
  it('POSTs to /chat/completions and maps tool calls', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init! }
      return new Response(JSON.stringify({
        choices: [{ message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'message_user', arguments: '{"kind":"report"}' } }],
        } }],
      }))
    }) as typeof fetch
    const llm = createLLM(loadConfig({ OPENGROKBOT_API_KEY: 'sk-x' }), fakeFetch)
    const turn = await llm.chat([{ role: 'user', content: 'hi' }], toolDefs)
    expect(captured!.url).toBe('https://api.x.ai/v1/chat/completions')
    expect((captured!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-x')
    expect(turn.toolCalls).toEqual([{ id: 'c1', name: 'message_user', args: { kind: 'report' } }])
    expect(turn.content).toBeNull()
  })

  it('throws readable error on non-200', async () => {
    const fakeFetch = (async () => new Response('quota exceeded', { status: 429 })) as typeof fetch
    const llm = createLLM(loadConfig({}), fakeFetch)
    await expect(llm.chat([{ role: 'user', content: 'hi' }], [])).rejects.toThrow(/429/)
  })
})

describe('stub model', () => {
  it('first replies with a report tool call, then closes with text', async () => {
    const llm = createLLM(loadConfig({ OPENGROKBOT_MODEL: 'stub' }))
    const messages: ChatMsg[] = [{ role: 'user', content: 'do the thing' }]
    const first = await llm.chat(messages, toolDefs)
    expect(first.toolCalls).toHaveLength(1)
    expect(first.toolCalls[0]!.name).toBe('message_user')
    expect((first.toolCalls[0]!.args as { kind: string }).kind).toBe('report')
    messages.push(first.raw, { role: 'tool', tool_call_id: first.toolCalls[0]!.id, content: 'Report delivered.' })
    const second = await llm.chat(messages, toolDefs)
    expect(second.toolCalls).toHaveLength(0)
    expect(second.content).toBeTruthy()
  })

  it('drives goto → screenshot → closing text when the user names a site', async () => {
    const llm = createLLM(loadConfig({ OPENGROKBOT_MODEL: 'stub' }))
    const messages: ChatMsg[] = [{ role: 'user', content: 'open example.com and show me' }]

    const goto = await llm.chat(messages, toolDefs)
    expect(goto.toolCalls[0]!.name).toBe('browser_goto')
    expect(goto.toolCalls[0]!.args).toEqual({ url: 'https://example.com' })

    messages.push(goto.raw, { role: 'tool', tool_call_id: goto.toolCalls[0]!.id, content: 'Now on "Example Domain" (https://example.com/)' })
    const shot = await llm.chat(messages, toolDefs)
    expect(shot.toolCalls[0]!.name).toBe('browser_screenshot')
    expect((shot.toolCalls[0]!.args as { caption: string }).caption).toContain('Example Domain')

    messages.push(shot.raw, { role: 'tool', tool_call_id: shot.toolCalls[0]!.id, content: 'Screenshot posted to the thread.' })
    const closing = await llm.chat(messages, toolDefs)
    expect(closing.toolCalls).toHaveLength(0)
    expect(closing.content).toBeTruthy()
  })

  it('holds outward actions, saves rules and schedules routines on cue', async () => {
    const llm = createLLM(loadConfig({ OPENGROKBOT_MODEL: 'stub' }))

    const hold = await llm.chat([{ role: 'user', content: 'send the replies for me' }], toolDefs)
    expect(hold.toolCalls[0]!.name).toBe('hold_for_approval')

    const memory = await llm.chat([{ role: 'user', content: 'from now on quiet accounts wait for my read' }], toolDefs)
    expect(memory.toolCalls[0]!.name).toBe('save_memory')
    expect((memory.toolCalls[0]!.args as { rule: string }).rule).toBe('quiet accounts wait for my read')

    const routine = await llm.chat([{ role: 'user', content: 'post a digest every day' }], toolDefs)
    expect(routine.toolCalls[0]!.name).toBe('create_routine')
    expect((routine.toolCalls[0]!.args as { cron: string }).cron).toBe('0 9 * * *')
  })

  it('carries out an approved action instead of holding it again', async () => {
    const llm = createLLM(loadConfig({ OPENGROKBOT_MODEL: 'stub' }))
    const approved = await llm.chat(
      [{ role: 'user', content: 'Your operator approved: send the 4 queued drafts. Carry it out now and report what actually happened.' }],
      toolDefs,
    )
    expect(approved.toolCalls).toHaveLength(0)
    expect(approved.content).toMatch(/sent/i)

    const discarded = await llm.chat(
      [{ role: 'user', content: 'Your operator discarded: send the 4 queued drafts. Do not do it. Acknowledge in one line and move on.' }],
      toolDefs,
    )
    expect(discarded.toolCalls).toHaveLength(0)
    expect(discarded.content).toMatch(/nothing went out/i)
  })

  it('closes each workflow path with a short line instead of looping', async () => {
    const llm = createLLM(loadConfig({ OPENGROKBOT_MODEL: 'stub' }))
    const closings = await Promise.all([
      "Held for your operator's approval. Stop here — do not perform it.",
      'Routine "Morning digest" scheduled (every day at 09:00).',
      'Rule saved to MEMORY.md.',
    ].map((result) => llm.chat([{ role: 'user', content: 'x' }, { role: 'tool', tool_call_id: 't', content: result }], toolDefs)))
    for (const turn of closings) {
      expect(turn.toolCalls).toHaveLength(0)
      expect(turn.content).toBeTruthy()
    }
  })

  it('plays its part in a group round and picks up handoffs', async () => {
    const llm = createLLM(loadConfig({ OPENGROKBOT_MODEL: 'stub' }))

    const member = await llm.chat(
      [{ role: 'user', content: 'Your operator asked the group: "where are we?". Answer for your own patch only, in two lines or less.' }],
      toolDefs,
    )
    expect(member.toolCalls).toHaveLength(0)
    expect(member.content).toBeTruthy()

    const chief = await llm.chat(
      [{ role: 'user', content: 'Everyone else has reported above. Post the dispatch table now — one line each.' }],
      toolDefs,
    )
    expect(chief.content).toMatch(/→ @/)

    const picked = await llm.chat(
      [{ role: 'user', content: '@Chief (chief) handed you this: price the tiers by Friday' }],
      toolDefs,
    )
    expect(picked.content).toMatch(/picking it up/i)
  })

  it('hands off when the operator names a teammate, before treating it as an outward action', async () => {
    const llm = createLLM(loadConfig({ OPENGROKBOT_MODEL: 'stub' }))

    const byName = await llm.chat([{ role: 'user', content: 'ask ticker to price the tiers' }], toolDefs)
    expect(byName.toolCalls[0]!.name).toBe('message_bot')
    expect((byName.toolCalls[0]!.args as { to: string }).to).toBe('market-watch')

    // "reply" 会撞上扣审批的关键词，点名转交必须优先
    const withReply = await llm.chat([{ role: 'user', content: 'tell sorter to reply to those two' }], toolDefs)
    expect(withReply.toolCalls[0]!.name).toBe('message_bot')
    expect((withReply.toolCalls[0]!.args as { to: string }).to).toBe('inbox-keeper')

    const closing = await llm.chat(
      [{ role: 'user', content: 'x' }, { role: 'tool', tool_call_id: 't', content: 'Handed to Ticker.' }],
      toolDefs,
    )
    expect(closing.toolCalls).toHaveLength(0)
    expect(closing.content).toMatch(/handed off/i)
  })

  it('asks for a takeover at a login wall instead of guessing credentials', async () => {
    const llm = createLLM(loadConfig({ OPENGROKBOT_MODEL: 'stub' }))
    const asked = await llm.chat([{ role: 'user', content: 'work my zendesk queue' }], toolDefs)
    expect(asked.toolCalls[0]!.name).toBe('ask_for_login')
    expect((asked.toolCalls[0]!.args as { site: string }).site).toBe('Zendesk')

    const waiting = await llm.chat(
      [
        { role: 'user', content: 'x' },
        { role: 'tool', tool_call_id: 't', content: 'Asked your operator to sign in to Zendesk. Stop here until they say it is done.' },
      ],
      toolDefs,
    )
    expect(waiting.toolCalls).toHaveLength(0)
    expect(waiting.content).toMatch(/waiting on you/i)
  })

  it('keeps full urls as written', async () => {
    const llm = createLLM(loadConfig({ OPENGROKBOT_MODEL: 'stub' }))
    const turn = await llm.chat([{ role: 'user', content: 'check https://news.ycombinator.com/news please' }], toolDefs)
    expect(turn.toolCalls[0]!.args).toEqual({ url: 'https://news.ycombinator.com/news' })
  })
})
