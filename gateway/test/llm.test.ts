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

  it('keeps full urls as written', async () => {
    const llm = createLLM(loadConfig({ OPENGROKBOT_MODEL: 'stub' }))
    const turn = await llm.chat([{ role: 'user', content: 'check https://news.ycombinator.com/news please' }], toolDefs)
    expect(turn.toolCalls[0]!.args).toEqual({ url: 'https://news.ycombinator.com/news' })
  })
})
