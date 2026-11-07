/**
 * 向导里的服务商预设。每一项都按官方文档核对过（checked 是核对日期，docsUrl 是依据），不凭记忆写。
 * 模型列表以服务商 /models 的实时返回为准，这里只给一个默认值；默认模型都要支持工具调用（同事靠它干活）。
 * request 是这家要额外带上的请求字段，每次调用都带；它不能覆盖网关自己发的 model、messages、tools。
 */
export type Provider = {
  id: string
  /** 品牌名不翻译；界面上的说明文字由前端按 id 翻 */
  name: string
  region: 'cn' | 'global' | 'local' | 'custom'
  baseURL: string
  needsKey: boolean
  /** 去哪拿 key；不需要 key 的为空 */
  keyUrl: string
  defaultModel: string
  /** 默认模型收不收图片（「看图」开关的默认值） */
  vision: boolean
  request: Record<string, unknown>
  docsUrl: string
  checked: string
}

export const PROVIDERS: Provider[] = [
  {
    // 思考模式默认开；官方工具调用示例里关掉（同事的每一步都要等它）。deepseek-v4-flash 已下线，改名 deepseek-flash
    id: 'deepseek', name: 'DeepSeek', region: 'cn',
    baseURL: 'https://api.deepseek.com', needsKey: true, keyUrl: 'https://platform.deepseek.com/api_keys',
    defaultModel: 'deepseek-flash', vision: true, request: { thinking: { type: 'disabled' } },
    docsUrl: 'https://api-docs.deepseek.com/quick_start/pricing', checked: '2026-11-03',
  },
  {
    // K3 系列推理关不掉；K2 系列 10-31 起不对新用户开放、计划 12 月底下线，别用
    id: 'kimi', name: 'Kimi', region: 'cn',
    baseURL: 'https://api.moonshot.cn/v1', needsKey: true, keyUrl: 'https://platform.kimi.com/console/api-keys',
    defaultModel: 'kimi-k3.1-pro', vision: true, request: {},
    docsUrl: 'https://platform.kimi.com/docs/models.md', checked: '2026-11-03',
  },
  {
    // 北京地域，key 按地域绑定；qwen3.7-plus 是官方写的「默认选择」，思考默认开，关掉省时间
    id: 'qwen', name: 'Qwen', region: 'cn',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', needsKey: true,
    keyUrl: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key',
    defaultModel: 'qwen3.7-plus', vision: true, request: { enable_thinking: false },
    docsUrl: 'https://help.aliyun.com/zh/model-studio/text-generation-model', checked: '2026-11-03',
  },
  {
    // glm-5.3 只收文字；glm-5.3-flash 原生多模态、支持工具、价格是它的 1/10。两者思考都关不掉
    id: 'glm', name: 'GLM', region: 'cn',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4', needsKey: true, keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    defaultModel: 'glm-5.3-flash', vision: true, request: {},
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash.md', checked: '2026-11-03',
  },
  {
    // grok-4.7：收图片、支持工具调用，官方「其余一切用 4.7」；推理默认 high、关不掉。更省的是 grok-4.3（推理可关、价格约一半）
    id: 'xai', name: 'xAI Grok', region: 'global',
    baseURL: 'https://api.x.ai/v1', needsKey: true, keyUrl: 'https://console.x.ai/team/default/api-keys',
    defaultModel: 'grok-4.7', vision: true, request: {},
    docsUrl: 'https://docs.x.ai/developers/models/grok-4.7', checked: '2026-11-03',
  },
  {
    // GPT-6 系列在 Chat Completions 上调工具：gpt-6-luna 要 reasoning_effort=none，其余要 Responses API
    id: 'openai', name: 'OpenAI', region: 'global',
    baseURL: 'https://api.openai.com/v1', needsKey: true, keyUrl: 'https://platform.openai.com/settings/organization/api-keys',
    defaultModel: 'gpt-6-luna', vision: true, request: { reasoning_effort: 'none' },
    docsUrl: 'https://developers.openai.com/api/docs/models/gpt-6-luna', checked: '2026-11-03',
  },
  {
    // 模型 id 是「厂商/模型」；默认值从它公开的 /models（supported_parameters=tools、input_modalities=image）里挑
    id: 'openrouter', name: 'OpenRouter', region: 'global',
    baseURL: 'https://openrouter.ai/api/v1', needsKey: true, keyUrl: 'https://openrouter.ai/settings/keys',
    defaultModel: 'anthropic/claude-haiku-5.5', vision: true, request: {},
    docsUrl: 'https://openrouter.ai/docs/quickstart', checked: '2026-11-03',
  },
  {
    // 本机跑，不要 key；qwen3-vl 带 vision + tools 标签，要 Ollama 0.12.7 以上。图片只收 base64（网关本来就是）
    id: 'ollama', name: 'Ollama', region: 'local',
    baseURL: 'http://localhost:11434/v1', needsKey: false, keyUrl: '',
    defaultModel: 'qwen3-vl:8b', vision: true, request: {},
    docsUrl: 'https://docs.ollama.com/api/openai-compatibility', checked: '2026-11-03',
  },
  {
    id: 'custom', name: 'OpenAI-compatible', region: 'custom',
    baseURL: '', needsKey: true, keyUrl: '', defaultModel: '', vision: false, request: {},
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat', checked: '2026-11-03',
  },
]

export function providerById(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id)
}
