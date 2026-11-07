import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createLLM, EARLIER_SCREENSHOT, type ChatMsg, type ToolDef } from '../src/llm.js'
import { toResponses } from '../src/llm-responses.js'

function fakeResponses(replies: unknown[]) {
  const sent: { url: string; auth: string | null; body: Record<string, unknown> }[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    sent.push({ url, auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify(replies.shift() ?? {}), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { sent, fetchImpl }
}

const target = { ...loadConfig({}), api: 'responses' as const, baseURL: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-6' }
const tools: ToolDef[] = [{ type: 'function', function: { name: 'browser_goto', parameters: { type: 'object', properties: { url: { type: 'string' } } } } }]

describe('OpenAI Responses API', () => {
  it('sends instructions, flat function tools and no server-side storage, and maps a call back', async () => {
    const { sent, fetchImpl } = fakeResponses([{
      status: 'completed',
      output: [
        { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'enc-1' },
        { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'browser_goto', arguments: '{"url":"https://example.com"}', status: 'completed' },
      ],
      usage: { input_tokens: 500, output_tokens: 40, input_tokens_details: { cached_tokens: 300 } },
    }])
    const turn = await createLLM(target, fetchImpl).chat([{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }], tools)
    expect(sent[0]!.url).toBe('https://api.openai.com/v1/responses')
    expect(sent[0]!.auth).toBe('Bearer sk-test')
    expect(sent[0]!.body).toMatchObject({
      model: 'gpt-6', instructions: 'sys', store: false, include: ['reasoning.encrypted_content'],
      input: [{ role: 'user', content: 'go' }],
      tools: [{ type: 'function', name: 'browser_goto', parameters: { type: 'object' }, strict: false }],
    })
    expect(turn.toolCalls).toEqual([{ id: 'call_1', name: 'browser_goto', args: { url: 'https://example.com' } }])
    expect(turn.usage).toEqual({ prompt: 500, completion: 40, cached: 300 })
  })

  it('hands the reasoning back on the next step as it came, leaving out reasoning it could not resolve', async () => {
    const { sent, fetchImpl } = fakeResponses([
      { output: [
        { id: 'rs_0', type: 'reasoning', summary: [] },
        { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'enc-1' },
        { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'browser_goto', arguments: '{}' },
      ] },
      { output: [{ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }] },
    ])
    const llm = createLLM(target, fetchImpl)
    const messages: ChatMsg[] = [{ role: 'user', content: 'go' }]
    const first = await llm.chat(messages, tools)
    messages.push(first.raw, { role: 'tool', tool_call_id: 'call_1', content: 'Now on example.com' })
    const second = await llm.chat(messages, tools)
    expect(second.content).toBe('Done.')
    expect(sent[1]!.body.input).toEqual([
      { role: 'user', content: 'go' },
      { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'enc-1' },
      { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'browser_goto', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'Now on example.com' },
    ])
  })

  it('shows only the latest screenshot, as input_image', () => {
    const { input } = toResponses([
      { role: 'user', content: 'one', images: ['data:image/png;base64,ONE'] },
      { role: 'user', content: 'two', images: ['data:image/png;base64,TWO'] },
    ])
    expect(input).toEqual([
      { role: 'user', content: EARLIER_SCREENSHOT },
      { role: 'user', content: [{ type: 'input_text', text: 'two' }, { type: 'input_image', image_url: 'data:image/png;base64,TWO' }] },
    ])
  })

  it('replays turns from another provider as plain items, and asks for text only when told to', async () => {
    const { sent, fetchImpl } = fakeResponses([{ output: [] }])
    await createLLM(target, fetchImpl).chat([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'On it.', tool_calls: [{ id: 'toolu_9', type: 'function', function: { name: 'browser_goto', arguments: '{"url":"x"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_9', content: 'ok' },
    ], tools, { toolChoice: 'none' })
    expect(sent[0]!.body.input).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'On it.' },
      { type: 'function_call', call_id: 'toolu_9', name: 'browser_goto', arguments: '{"url":"x"}' },
      { type: 'function_call_output', call_id: 'toolu_9', output: 'ok' },
    ])
    expect(sent[0]!.body.tool_choice).toBe('none')
  })

  it('does not run a half-written tool call from a reply that was cut off', async () => {
    const { fetchImpl } = fakeResponses([{
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'function_call', call_id: 'call_1', name: 'browser_goto', arguments: '{"url":"https://exa' }],
    }])
    await expect(createLLM(target, fetchImpl).chat([{ role: 'user', content: 'go' }], tools)).rejects.toThrow(/cut off \(max_output_tokens\)/)
  })

  it('surfaces a failed response as an error', async () => {
    const { fetchImpl } = fakeResponses([{ status: 'failed', error: { message: 'server overloaded' } }])
    await expect(createLLM(target, fetchImpl).chat([{ role: 'user', content: 'go' }], [])).rejects.toThrow(/server overloaded/)
  })
})
