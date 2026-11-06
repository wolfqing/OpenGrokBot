/**
 * 界面要翻成操作者语言的报错：message 是给日志和 API 调用方看的英文，code + params 给界面翻译。
 * 不认识的报错照旧只有 message，界面原样显示。
 */
export type ErrorParams = Record<string, string | number>

export class CodedError extends Error {
  readonly code: string
  readonly params: ErrorParams | undefined
  constructor(code: string, message: string, params?: ErrorParams) {
    super(message)
    this.name = 'CodedError'
    this.code = code
    this.params = params
  }
}

/** 报错的 JSON 形状：{ error, code?, params? } */
export function errorBody(err: unknown): { error: string; code?: string; params?: ErrorParams } {
  const error = err instanceof Error ? err.message : String(err)
  if (!(err instanceof CodedError)) return { error }
  return { error, code: err.code, ...(err.params ? { params: err.params } : {}) }
}
