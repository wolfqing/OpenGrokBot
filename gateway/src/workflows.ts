import { randomUUID } from 'node:crypto'
import type { Db } from './db.js'

export type WorkflowLocator =
  | { role: { role: string; name: string } }
  | { label: string }
  | { placeholder: string }
  | { text: string }
  | { testId: string }
  | { css: string }

export type WorkflowTarget = { candidates: WorkflowLocator[] }

export type WorkflowValue =
  | { kind: 'literal'; text: string }
  | { kind: 'placeholder'; key: string }
  | { kind: 'redacted'; reason: 'sensitive-input' }

type WorkflowStepContext = { intent?: string; page?: string; frame?: string }
type WorkflowActionContext = WorkflowStepContext & { expect?: { url: string } }

export type WorkflowStep = WorkflowStepContext & (
  | { type: 'navigate'; url: string }
  | (WorkflowActionContext & { type: 'click'; target: WorkflowTarget })
  | (WorkflowActionContext & { type: 'check' | 'uncheck'; target: WorkflowTarget })
  | (WorkflowActionContext & { type: 'press'; key: 'Enter'; target: WorkflowTarget })
  | (WorkflowActionContext & { type: 'fill'; target: WorkflowTarget; value: WorkflowValue })
  | (WorkflowActionContext & { type: 'select'; target: WorkflowTarget; value: WorkflowValue })
  | { type: 'unrecorded-popup' }
)

export type WorkflowTrace = {
  format: 'opengrokbot.workflow'
  version: 1
  title: string
  intent?: string
  steps: WorkflowStep[]
}

export type WorkflowTraceId = string & { readonly __brand: 'WorkflowTraceId' }
export type SavedWorkflowTrace = { id: WorkflowTraceId; trace: WorkflowTrace }

type WorkflowRow = { id: string; trace_json: string }

const SAFE_ID = /^[a-zA-Z0-9._-]+$/
const TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PLACEHOLDER_KEY = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/
export const MAX_WORKFLOW_STEPS = 1_000
const MAX_TITLE_LENGTH = 120
const MAX_INTENT_LENGTH = 500
const MAX_REFERENCE_LENGTH = 128
const MAX_LOCATOR_LENGTH = 256
const MAX_LOCATOR_CANDIDATES = 8
const MAX_VALUE_LENGTH = 2_000
const MAX_URL_LENGTH = 4_096
const MAX_TRACE_BYTES = 5_000_000
const STRUCTURAL_CSS = /^(?:[a-z][a-z0-9-]*:nth-of-type\(\d+\))(?:\s*>\s*[a-z][a-z0-9-]*:nth-of-type\(\d+\))*$/i

const SENSITIVE_NAME = /(?:^|[^a-z0-9])(?:pass(?:word|code)?|secret|token|credential|api[\s_-]*key|otp|totp|mfa|private[\s_-]*key|credit[\s_-]*card|card[\s_-]*number|cc[\s_-]*(?:number|exp|csc)|(?:one[\s_-]*)?time[\s_-]*(?:password|code|pin|token)|(?:security|verification) code|auth(?:entication|orization)? code)(?=$|[^a-z0-9])/i
const SECRET_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b|\b(?:password|secret|token|api[\s_-]*key)\s*[:=]\s*[^\s,;]{6,}/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWorkflowTraceId(value: string): value is WorkflowTraceId {
  return TRACE_ID.test(value)
}

function readString(value: unknown, name: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && !value.trim())) {
    throw new TypeError(`invalid workflow ${name}`)
  }
  return value
}

function looksLikeHighEntropySecret(value: string): boolean {
  const compact = value.replace(/\s/g, '')
  if (compact.length < 32) return false
  const counts = new Map<string, number>()
  for (const character of compact) counts.set(character, (counts.get(character) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const probability = count / compact.length
    entropy -= probability * Math.log2(probability)
  }
  return entropy >= 3.5
}

function safeLocatorText(value: unknown, name: string, structuralCss = false): string | null {
  const text = readString(value, name, MAX_LOCATOR_LENGTH)
  return SECRET_PATTERN.test(text) || (!structuralCss && looksLikeHighEntropySecret(text)) ? null : text
}

function candidateText(candidate: WorkflowLocator): string {
  if ('role' in candidate) return `${candidate.role.role} ${candidate.role.name}`
  return candidate[Object.keys(candidate)[0] as Exclude<keyof WorkflowLocator, 'role'>] as string
}

function targetText(target: WorkflowTarget): string {
  return target.candidates.map(candidateText).join(' ')
}

function redactLiteral(value: string, target: WorkflowTarget): WorkflowValue {
  const name = targetText(target).replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  return SENSITIVE_NAME.test(name) || SECRET_PATTERN.test(value) || looksLikeHighEntropySecret(value)
    ? { kind: 'redacted', reason: 'sensitive-input' }
    : { kind: 'literal', text: value }
}

/** Remove URL credentials, fragments, and query values while keeping parameter names for a later runner. */
export function sanitizeWorkflowUrl(value: string): string | null {
  if (value.length > MAX_URL_LENGTH) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.username = ''
    url.password = ''
    url.hash = ''
    const queryKeys = [...url.searchParams.keys()]
    url.search = ''
    for (const key of queryKeys) url.searchParams.append(key, '')
    return url.toString()
  } catch {
    return null
  }
}

function parseLocatorCandidate(value: unknown): WorkflowLocator | null {
  if (!isRecord(value) || Object.keys(value).length !== 1) {
    throw new TypeError('each workflow locator candidate must use one strategy')
  }
  if (value.role !== undefined) {
    if (!isRecord(value.role) || Object.keys(value.role).length !== 2
      || !Object.hasOwn(value.role, 'role') || !Object.hasOwn(value.role, 'name')) {
      throw new TypeError('invalid workflow locator role')
    }
    const role = safeLocatorText(value.role.role, 'locator role')
    const name = safeLocatorText(value.role.name, 'locator name')
    if (role && name) return { role: { role, name } }
    return null
  }
  for (const key of ['label', 'placeholder', 'testId', 'text', 'css'] as const) {
    if (value[key] === undefined) continue
    if (key === 'css' && (typeof value.css !== 'string' || !STRUCTURAL_CSS.test(value.css))) {
      throw new TypeError('workflow CSS locator must be a structural fallback')
    }
    const structuralCss = key === 'css'
    const candidate = safeLocatorText(value[key], `locator ${key}`, structuralCss)
    if (!candidate) return null
    return { [key]: candidate } as WorkflowLocator
  }
  throw new TypeError('unsupported workflow locator strategy')
}

function parseTarget(value: unknown): WorkflowTarget {
  if (!isRecord(value) || !Array.isArray(value.candidates)
    || value.candidates.length < 1 || value.candidates.length > MAX_LOCATOR_CANDIDATES) {
    throw new TypeError('workflow target needs ordered locator candidates')
  }
  const candidates = value.candidates.map(parseLocatorCandidate).filter((candidate): candidate is WorkflowLocator => candidate !== null)
  const unique = candidates.filter((candidate, index) =>
    candidates.findIndex((other) => JSON.stringify(other) === JSON.stringify(candidate)) === index,
  )
  if (!unique.length) throw new TypeError('workflow target needs ordered locator candidates')
  return { candidates: unique }
}

function parseStepContext(value: Record<string, unknown>): WorkflowStepContext {
  const context: WorkflowStepContext = {}
  if (value.intent !== undefined) {
    const intent = readString(value.intent, 'step intent', MAX_INTENT_LENGTH).trim()
    if (SECRET_PATTERN.test(intent) || looksLikeHighEntropySecret(intent)) throw new TypeError('workflow intent may not contain secrets')
    if (intent) context.intent = intent
  }
  for (const field of ['page', 'frame'] as const) {
    if (value[field] !== undefined) {
      const reference = readString(value[field], `${field} reference`, MAX_REFERENCE_LENGTH)
      if (!/^[\w][\w.:-]*(?:\/[\w][\w.:-]*)*$/.test(reference)) throw new TypeError(`invalid workflow ${field} reference`)
      context[field] = reference
    }
  }
  return context
}

function parseWorkflowValue(value: unknown, target: WorkflowTarget): WorkflowValue {
  if (!isRecord(value)) throw new TypeError('invalid workflow value')
  if (value.kind === 'redacted' && value.reason === 'sensitive-input') {
    return { kind: 'redacted', reason: 'sensitive-input' }
  }
  if (value.kind === 'placeholder') {
    const key = readString(value.key, 'placeholder key', 64)
    if (!PLACEHOLDER_KEY.test(key)) throw new TypeError('invalid workflow placeholder key')
    return { kind: 'placeholder', key }
  }
  if (value.kind === 'literal') {
    return redactLiteral(readString(value.text, 'value', MAX_VALUE_LENGTH, true), target)
  }
  throw new TypeError('invalid workflow value')
}

function parseActionContext(context: WorkflowStepContext, value: unknown): WorkflowActionContext {
  if (value === undefined) return context
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'url')) {
    throw new TypeError('invalid workflow expectation')
  }
  const url = sanitizeWorkflowUrl(readString(value.url, 'URL', MAX_URL_LENGTH))
  if (!url) throw new TypeError('invalid workflow URL')
  return { ...context, expect: { url } }
}

export function parseWorkflowStep(value: unknown): WorkflowStep {
  if (!isRecord(value)) throw new TypeError('invalid workflow step')
  if (value.type === 'unrecorded-popup') return { type: 'unrecorded-popup' }
  const context = parseStepContext(value)
  switch (value.type) {
    case 'navigate': {
      const url = sanitizeWorkflowUrl(readString(value.url, 'URL', MAX_URL_LENGTH))
      if (!url) throw new TypeError('invalid workflow URL')
      return { ...context, type: 'navigate', url }
    }
    case 'click':
      return { ...parseActionContext(context, value.expect), type: 'click', target: parseTarget(value.target) }
    case 'check':
    case 'uncheck':
      return { ...parseActionContext(context, value.expect), type: value.type, target: parseTarget(value.target) }
    case 'press': {
      if (value.key !== 'Enter') throw new TypeError('unsupported workflow key')
      return { ...parseActionContext(context, value.expect), type: 'press', key: 'Enter', target: parseTarget(value.target) }
    }
    case 'fill':
    case 'select': {
      const target = parseTarget(value.target)
      return { ...parseActionContext(context, value.expect), type: value.type, target, value: parseWorkflowValue(value.value, target) }
    }
    default:
      throw new TypeError('unsupported workflow step')
  }
}

export function parseWorkflowTrace(value: unknown): WorkflowTrace {
  if (!isRecord(value) || value.format !== 'opengrokbot.workflow' || value.version !== 1) {
    throw new TypeError('unsupported workflow trace format')
  }
  if (!Array.isArray(value.steps) || value.steps.length > MAX_WORKFLOW_STEPS) throw new TypeError('invalid workflow steps')
  const trace: WorkflowTrace = {
    format: 'opengrokbot.workflow',
    version: 1,
    title: readString(value.title, 'title', MAX_TITLE_LENGTH).trim(),
    steps: value.steps.map(parseWorkflowStep),
  }
  if (value.intent !== undefined) {
    const intent = readString(value.intent, 'intent', MAX_INTENT_LENGTH).trim()
    if (SECRET_PATTERN.test(intent) || looksLikeHighEntropySecret(intent)) throw new TypeError('workflow intent may not contain secrets')
    if (intent) trace.intent = intent
  }
  if (Buffer.byteLength(JSON.stringify(trace), 'utf8') > MAX_TRACE_BYTES) throw new TypeError('workflow trace is too large')
  return trace
}

function validateBotId(botId: string): void {
  if (!SAFE_ID.test(botId) || botId === '.' || botId === '..') throw new TypeError('invalid bot id')
}

export function saveWorkflowTrace(db: Db, botId: string, value: unknown, requestedId?: string): SavedWorkflowTrace {
  validateBotId(botId)
  const trace = parseWorkflowTrace(value)
  const id = requestedId ?? randomUUID()
  if (!isWorkflowTraceId(id)) throw new TypeError('invalid workflow id')
  db.prepare('INSERT INTO workflows (id, bot_id, title, trace_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
    .run(id, botId, trace.title, JSON.stringify(trace), Date.now())
  const row = db.prepare('SELECT id, trace_json FROM workflows WHERE bot_id = ? AND id = ?').get(botId, id) as WorkflowRow | undefined
  if (!row) throw new Error('workflow id is already in use')
  return { id: row.id as WorkflowTraceId, trace: parseWorkflowTrace(JSON.parse(row.trace_json)) }
}

export function listWorkflowTraces(db: Db, botId: string): SavedWorkflowTrace[] {
  validateBotId(botId)
  const rows = db.prepare('SELECT id, trace_json FROM workflows WHERE bot_id = ? ORDER BY created_at DESC, id DESC')
    .all(botId) as WorkflowRow[]
  return rows.map(({ id, trace_json }) => ({ id: id as WorkflowTraceId, trace: parseWorkflowTrace(JSON.parse(trace_json)) }))
}

export function readWorkflowTrace(db: Db, botId: string, id: string): WorkflowTrace | null {
  validateBotId(botId)
  if (!isWorkflowTraceId(id)) throw new TypeError('invalid workflow id')
  const row = db.prepare('SELECT trace_json FROM workflows WHERE bot_id = ? AND id = ?').get(botId, id) as { trace_json: string } | undefined
  return row ? parseWorkflowTrace(JSON.parse(row.trace_json)) : null
}
