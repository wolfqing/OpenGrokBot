/**
 * 「测试连接」：先 GET /models 看 key 认不认、有哪些模型，再发一个极小的对话看这个模型答不答。
 * 失败归成几类 code，由界面翻成人话和下一步；原始的状态码和一小段回复留着给「详细信息」。
 */
export type CheckCode = 'bad_key' | 'quota' | 'rate_limited' | 'model_not_found' | 'unreachable' | 'timeout' | 'provider_error'
export type CheckFailure = { ok: false; code: CheckCode; status?: number; detail?: string }
export type ModelList = { ok: true; models: string[] } | CheckFailure
export type CheckResult =
  | { ok: true; models: string[]; /** 列表里有没有这个模型；null = 服务商没给列表 */ modelListed: boolean | null }
  | (CheckFailure & { step: 'models' | 'chat'; models: string[] })

type Target = { baseURL: string; apiKey: string }
type Opts = { fetchImpl?: typeof fetch; timeoutMs?: number }

const DEFAULT_TIMEOUT_MS = 15_000
const QUOTA = /quota|balance|insufficient|credit|billing|余额|欠费|额度/i
/** 有的服务商（xAI）拿 400 回 key 不对 */
const BAD_KEY = /api[ _-]?key|unauthori[sz]ed|authenticat|credential/i
const NO_MODEL = /model.{0,40}(not[ _]?(found|exist)|does not exist|unknown|invalid)|(unknown|invalid|no such) model|模型不存在/i

const endpoint = (baseURL: string, path: string) => `${baseURL.replace(/\/+$/, '')}${path}`
const headers = (apiKey: string): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
})

/** 回复原文里不该出现 key；有的服务商会把收到的 key 回显出来 */
const scrub = (text: string, apiKey: string) => (apiKey ? text.split(apiKey).join('[key]') : text).slice(0, 300)

type Sent = { res: Response; text: string } | CheckFailure

async function send(url: string, init: RequestInit, apiKey: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<Sent> {
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const res = await fetchImpl(url, { ...init, signal })
    return { res, text: await res.text().catch(() => '') }
  } catch (err) {
    if (signal.aborted) return { ok: false, code: 'timeout' }
    return { ok: false, code: 'unreachable', detail: scrub(err instanceof Error ? err.message : String(err), apiKey) }
  }
}

export async function listModels(target: Target, opts: Opts = {}): Promise<ModelList> {
  const sent = await send(endpoint(target.baseURL, '/models'), { headers: headers(target.apiKey) }, target.apiKey,
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.fetchImpl ?? fetch)
  if (!('res' in sent)) return sent
  const { res, text } = sent
  if (res.status === 401 || res.status === 403 || (res.status === 400 && BAD_KEY.test(text))) {
    return { ok: false, code: 'bad_key', status: res.status, detail: scrub(text, target.apiKey) }
  }
  if (!res.ok) return { ok: false, code: 'provider_error', status: res.status, detail: scrub(text, target.apiKey) }
  let data: unknown
  try {
    data = (JSON.parse(text) as { data?: unknown }).data
  } catch {
    data = undefined
  }
  const ids = Array.isArray(data) ? data.map((m) => (m as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string') : []
  return { ok: true, models: [...new Set(ids)].sort() }
}

function classify(status: number, text: string): CheckCode {
  if (status === 401 || status === 403) return 'bad_key'
  if (status === 402) return 'quota'
  if (status === 429) return QUOTA.test(text) ? 'quota' : 'rate_limited'
  if (status === 404) return 'model_not_found'
  if (status === 400 || status === 422) {
    if (NO_MODEL.test(text)) return 'model_not_found'
    if (BAD_KEY.test(text)) return 'bad_key'
    if (QUOTA.test(text)) return 'quota'
  }
  return 'provider_error'
}

export async function checkConnection(
  target: Target & { model: string; extraBody?: Record<string, unknown> },
  opts: Opts = {},
): Promise<CheckResult> {
  if (target.model === 'stub') return { ok: true, models: [], modelListed: null }
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const listed = await listModels(target, { fetchImpl, timeoutMs })
  // key 不认、连不上就不用再花一次模型调用；没有 /models 的服务商照样往下试
  if (!listed.ok && listed.code !== 'provider_error') return { ...listed, step: 'models', models: [] }
  const models = listed.ok ? listed.models : []

  const ask = (limit: 'max_tokens' | 'max_completion_tokens') => send(endpoint(target.baseURL, '/chat/completions'), {
    method: 'POST',
    headers: headers(target.apiKey),
    // 和网关真正发的一样带上服务商字段（比如关掉思考），测出来的才算数
    body: JSON.stringify({ ...target.extraBody, model: target.model, messages: [{ role: 'user', content: 'Reply with OK.' }], [limit]: 16 }),
  }, target.apiKey, timeoutMs, fetchImpl)
  let sent = await ask('max_tokens')
  // 推理模型（如 OpenAI 的 o 系列）不收 max_tokens，要 max_completion_tokens
  if ('res' in sent && sent.res.status === 400 && /max_tokens/.test(sent.text)) sent = await ask('max_completion_tokens')
  if (!('res' in sent)) return { ...sent, step: 'chat', models }
  const { res, text } = sent
  if (!res.ok) return { ok: false, code: classify(res.status, text), status: res.status, detail: scrub(text, target.apiKey), step: 'chat', models }
  let choices: unknown
  try {
    choices = (JSON.parse(text) as { choices?: unknown }).choices
  } catch {
    choices = undefined
  }
  if (!Array.isArray(choices)) return { ok: false, code: 'provider_error', status: res.status, detail: scrub(text, target.apiKey), step: 'chat', models }
  return { ok: true, models, modelListed: models.length ? models.includes(target.model) : null }
}
