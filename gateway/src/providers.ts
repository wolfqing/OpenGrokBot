import type { LlmApi } from './config.js'

/**
 * 向导里的服务商预设。每一项都按官方文档核对过（checked 是核对日期，docsUrl 是依据），不凭记忆写。
 * 模型列表以服务商 /models 的实时返回为准，这里只给一个默认值；默认模型都要支持工具调用（同事靠它干活）。
 * request 是这家要额外带上的请求字段，每次调用都带；它不能覆盖网关自己发的 model、messages、tools。
 *
 * 订阅套餐只收条款允许第三方工具接入的（plan: true，界面上先讲清楚风险）。2026-11-07 核对时，这几家明令不许，所以不做预设：
 * - 智谱 GLM Coding Plan（bigmodel.cn 和 z.ai）：订阅协议禁止在自建应用、机器人里直接调模型接口，违规 3 次以上可能封号。
 * - Kimi Code：社区规范只许个人交互式使用，不许非交互的自动化，改 User-Agent 冒充客户端算违规。
 * - 阿里云百炼 Coding Plan：只许在编程工具里交互着用，禁止自动化脚本和自定义应用后端。
 * Claude 和 Gemini 的订阅登录同样不许第三方应用用（见 anthropic、gemini 两项）。
 */
export type Provider = {
  id: string
  /** 品牌名不翻译；界面上的说明文字由前端按 id 翻 */
  name: string
  region: 'cn' | 'global' | 'local' | 'custom'
  /** 走哪种接口；自定义连接可以自己选 */
  api: LlmApi
  /**
   * 这是一份订阅套餐的 key（编程套餐之类），不是按量付费的 API key。界面上要先讲清楚条款：
   * 套餐多半写明给个人在编程工具里交互着用，同事在后台跑定时任务正是服务商最在意的用法。
   */
  plan?: true
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
    id: 'deepseek', name: 'DeepSeek', region: 'cn', api: 'chat',
    baseURL: 'https://api.deepseek.com', needsKey: true, keyUrl: 'https://platform.deepseek.com/api_keys',
    defaultModel: 'deepseek-flash', vision: true, request: { thinking: { type: 'disabled' } },
    docsUrl: 'https://api-docs.deepseek.com/quick_start/pricing', checked: '2026-11-03',
  },
  {
    // K3 系列推理关不掉；K2 系列 10-31 起不对新用户开放、计划 12 月底下线，别用
    id: 'kimi', name: 'Kimi', region: 'cn', api: 'chat',
    baseURL: 'https://api.moonshot.cn/v1', needsKey: true, keyUrl: 'https://platform.kimi.com/console/api-keys',
    defaultModel: 'kimi-k3.1-pro', vision: true, request: {},
    docsUrl: 'https://platform.kimi.com/docs/models.md', checked: '2026-11-03',
  },
  {
    // 北京地域，key 按地域绑定；qwen3.7-plus 是官方写的「默认选择」，思考默认开，关掉省时间
    id: 'qwen', name: 'Qwen', region: 'cn', api: 'chat',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', needsKey: true,
    keyUrl: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key',
    defaultModel: 'qwen3.7-plus', vision: true, request: { enable_thinking: false },
    docsUrl: 'https://help.aliyun.com/zh/model-studio/text-generation-model', checked: '2026-11-03',
  },
  {
    // glm-5.3 只收文字；glm-5.3-flash 原生多模态、支持工具、价格是它的 1/10。两者思考都关不掉
    id: 'glm', name: 'GLM', region: 'cn', api: 'chat',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4', needsKey: true, keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    defaultModel: 'glm-5.3-flash', vision: true, request: {},
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash.md', checked: '2026-11-03',
  },
  {
    // 国内站，文档里的地址已经是 api.minimax.cn（不再是 minimaxi.com）；其余同国际站
    id: 'minimax-cn', name: 'MiniMax', region: 'cn', api: 'chat',
    baseURL: 'https://api.minimax.cn/v1', needsKey: true, keyUrl: 'https://platform.minimax.cn/user-center/basic-information/interface-key',
    defaultModel: 'MiniMax-M3.1-Flash', vision: true, request: { reasoning_effort: 'low', reasoning_split: true },
    docsUrl: 'https://platform.minimaxi.com/docs/api-reference/text-openai-api', checked: '2026-11-07',
  },
  {
    id: 'minimax-plan-cn', name: 'MiniMax M Plan', region: 'cn', api: 'chat', plan: true,
    baseURL: 'https://api.minimax.cn/v1', needsKey: true, keyUrl: 'https://platform.minimax.cn/user-center/payment/token-plan',
    defaultModel: 'MiniMax-M3.1-Flash', vision: true, request: { reasoning_effort: 'low', reasoning_split: true },
    docsUrl: 'https://platform.minimaxi.com/docs/m-plan/faq', checked: '2026-11-07',
  },
  {
    // grok-4.7：收图片、支持工具调用，官方「代码和聊天都用 4.7」；推理默认 high、关不掉。更省的是 grok-4.3（推理可关、价格约一半）。
    // 走 Responses：Chat Completions 在 xAI 文档里已标「Deprecated」（还没给关停日期）。它默认在服务端存 30 天，
    // 适配器发 store: false 加 include 加密推理，才不留存
    id: 'xai', name: 'xAI Grok', region: 'global', api: 'responses',
    baseURL: 'https://api.x.ai/v1', needsKey: true, keyUrl: 'https://console.x.ai/team/default/api-keys',
    defaultModel: 'grok-4.7', vision: true, request: {},
    docsUrl: 'https://docs.x.ai/developers/model-capabilities/text/generate-text', checked: '2026-11-07',
  },
  {
    // 走 Responses：GPT-6 系列只有在这里才能边推理边调工具（Chat Completions 上 luna/sol 要关掉推理，astra、6.1 sol、6.1 terra 根本不调工具）。
    // gpt-6-luna 最快最省（$0.10/$0.50），推理默认 medium，这里给 low；所有 GPT-6 都收 low。截图和电脑操作多的换 gpt-6.1-terra
    id: 'openai', name: 'OpenAI', region: 'global', api: 'responses',
    baseURL: 'https://api.openai.com/v1', needsKey: true, keyUrl: 'https://platform.openai.com/settings/organization/api-keys',
    defaultModel: 'gpt-6-luna', vision: true, request: { reasoning: { effort: 'low' } },
    docsUrl: 'https://developers.openai.com/api/docs/models/gpt-6-luna', checked: '2026-11-07',
  },
  {
    // 原生 Messages 接口（官方 SDK），不走它的 OpenAI 兼容口（官方说那个不适合正式用）。
    // Opus 5.5 的思考关不掉，用 effort 调深浅，默认 medium，这里写明；要省钱在模型里换 claude-sonnet-5-5 / claude-haiku-5-5。
    // 只收 API key：Pro/Max 订阅的登录令牌（sk-ant-oat…）官方不许第三方应用用，网关直接拒收。
    // Max / Ultra / Team 自 2026-10-07 起每月附带 API 额度：在 claude.ai 计费设置里绑一个控制台组织，在那里生成的 key 就花这笔额度
    id: 'anthropic', name: 'Claude', region: 'global', api: 'anthropic',
    baseURL: 'https://api.anthropic.com', needsKey: true, keyUrl: 'https://platform.claude.com/settings/keys',
    defaultModel: 'claude-opus-5-5', vision: true, request: { output_config: { effort: 'medium' } },
    docsUrl: 'https://platform.claude.com/docs/en/about-claude/models/overview', checked: '2026-11-07',
  },
  {
    // AI Studio 的 key，走它的 OpenAI 兼容口。gemini-3.5-flash-lite 是官方给新项目推荐的、专做高并发 agent 任务的那档，
    // 思考默认最低，有免费层（免费层的内容会被拿去改进 Google 的产品）。旗舰是 gemini-4-argon（无免费层）。
    // 调工具时 Gemini 要求把 thought signature 原样传回：它挂在 tool_calls 上，网关同一回合里原样带回去
    id: 'gemini', name: 'Gemini', region: 'global', api: 'chat',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true, keyUrl: 'https://aistudio.google.com/apikey',
    defaultModel: 'gemini-3.5-flash-lite', vision: true, request: {},
    docsUrl: 'https://aistudio.google.com/docs/openai', checked: '2026-11-07',
  },
  {
    // 国际站。M3.1-Flash 的思考关不掉、默认 max（又慢又费），这里给 low；reasoning_split 让 M3 也把思考放进 reasoning_content，
    // 不然 <think> 会混进同事说的话里。多轮调工具要把 reasoning_content 原样带回——网关同一回合里本来就原样带回
    id: 'minimax', name: 'MiniMax', region: 'global', api: 'chat',
    baseURL: 'https://api.minimax.io/v1', needsKey: true, keyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    defaultModel: 'MiniMax-M3.1-Flash', vision: true, request: { reasoning_effort: 'low', reasoning_split: true },
    docsUrl: 'https://platform.minimax.io/docs/api-reference/text-openai-api', checked: '2026-11-07',
  },
  {
    // M Plan（原 Coding/Token Plan）：专用 key，地址同按量。官方说任何兼容工具都能接（还点名了通用 agent），
    // 但定位是个人交互式开发，生产用按量——所以标成套餐，界面上先讲清楚
    id: 'minimax-plan', name: 'MiniMax M Plan', region: 'global', api: 'chat', plan: true,
    baseURL: 'https://api.minimax.io/v1', needsKey: true, keyUrl: 'https://platform.minimax.io/console/plan',
    defaultModel: 'MiniMax-M3.1-Flash', vision: true, request: { reasoning_effort: 'low', reasoning_split: true },
    docsUrl: 'https://platform.minimax.io/docs/m-plan/faq', checked: '2026-11-07',
  },
  {
    // 模型 id 是「厂商/模型」；默认值从它公开的 /models（supported_parameters=tools、input_modalities=image）里挑
    id: 'openrouter', name: 'OpenRouter', region: 'global', api: 'chat',
    baseURL: 'https://openrouter.ai/api/v1', needsKey: true, keyUrl: 'https://openrouter.ai/settings/keys',
    defaultModel: 'anthropic/claude-haiku-5.5', vision: true, request: {},
    docsUrl: 'https://openrouter.ai/docs/quickstart', checked: '2026-11-03',
  },
  {
    // 本机跑，不要 key；qwen3-vl 带 vision + tools 标签，要 Ollama 0.12.7 以上。图片只收 base64（网关本来就是）
    id: 'ollama', name: 'Ollama', region: 'local', api: 'chat',
    baseURL: 'http://localhost:11434/v1', needsKey: false, keyUrl: '',
    defaultModel: 'qwen3-vl:8b', vision: true, request: {},
    docsUrl: 'https://docs.ollama.com/api/openai-compatibility', checked: '2026-11-03',
  },
  {
    id: 'custom', name: 'OpenAI-compatible', region: 'custom', api: 'chat',
    baseURL: '', needsKey: true, keyUrl: '', defaultModel: '', vision: false, request: {},
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat', checked: '2026-11-03',
  },
]

export function providerById(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id)
}
