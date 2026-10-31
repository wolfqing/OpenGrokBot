import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { botDataDir } from './screenshots.js'

export type WorkflowLocator = {
  role?: { role: string; name: string }
  label?: string
  placeholder?: string
  text?: string
  testId?: string
  css?: string
}

export type WorkflowValue =
  | { kind: 'literal'; text: string }
  | { kind: 'redacted'; reason: 'sensitive-input' }

export type WorkflowStep =
  | { type: 'navigate'; url: string }
  | { type: 'click'; target: WorkflowLocator }
  | { type: 'fill'; target: WorkflowLocator; value: WorkflowValue }
  | { type: 'select'; target: WorkflowLocator; value: WorkflowValue }

export type WorkflowTrace = {
  format: 'opengrokbot.workflow'
  version: 1
  title: string
  steps: WorkflowStep[]
}

export type WorkflowTraceId = string & { readonly __brand: 'WorkflowTraceId' }
export type SavedWorkflowTrace = { id: WorkflowTraceId; trace: WorkflowTrace }

const SAFE_ID = /^[a-zA-Z0-9._-]+$/
const TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const MAX_WORKFLOW_STEPS = 1_000
const MAX_TITLE_LENGTH = 120
const MAX_LOCATOR_LENGTH = 256
const MAX_VALUE_LENGTH = 2_000
const MAX_URL_LENGTH = 4_096
const MAX_TRACE_BYTES = 5_000_000
const STRUCTURAL_CSS = /^(?:[a-z][a-z0-9-]*:nth-of-type\(\d+\))(?:\s*>\s*[a-z][a-z0-9-]*:nth-of-type\(\d+\))*$/i

const SENSITIVE_NAME = /(?:^|[^a-z0-9])(?:pass(?:word|code)?|secret|token|credential|api[\s_-]*key|otp|totp|mfa|private[\s_-]*key|credit[\s_-]*card|card[\s_-]*number|cc[\s_-]*(?:number|exp|csc)|(?:one[\s_-]*)?time[\s_-]*(?:password|code|pin|token)|(?:security|verification) code|auth(?:entication|orization)? code)(?=$|[^a-z0-9])/i
const SECRET_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b|\b(?:password|secret|token|api[\s_-]*key)\s*[:=]\s*[^\s,;]{6,}/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
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

function safeLocatorText(value: unknown, name: string, structuralCss = false): string | null {
  const text = readString(value, name, MAX_LOCATOR_LENGTH)
  return SECRET_PATTERN.test(text) || (!structuralCss && looksLikeHighEntropySecret(text)) ? null : text
}

function locatorName(locator: WorkflowLocator): string {
  return [locator.role?.name, locator.label, locator.placeholder, locator.text, locator.testId, locator.css]
    .filter((value): value is string => value !== undefined)
    .join(' ')
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

function redactLiteral(value: string, locator: WorkflowLocator): WorkflowValue {
  const name = locatorName(locator).replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  return SENSITIVE_NAME.test(name) || SECRET_PATTERN.test(value) || looksLikeHighEntropySecret(value)
    ? { kind: 'redacted', reason: 'sensitive-input' }
    : { kind: 'literal', text: value }
}

/** Remove URL material that can carry credentials or session state before it enters a trace. */
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

function parseLocator(value: unknown): WorkflowLocator {
  if (!isRecord(value)) throw new TypeError('invalid workflow locator')
  const locator: WorkflowLocator = {}
  if (value.role !== undefined) {
    if (!isRecord(value.role)) throw new TypeError('invalid workflow locator role')
    const role = safeLocatorText(value.role.role, 'locator role')
    const name = safeLocatorText(value.role.name, 'locator name')
    if (role && name) locator.role = { role, name }
  }
  for (const key of ['label', 'placeholder', 'text', 'testId', 'css'] as const) {
    if (value[key] !== undefined) {
      const structuralCss = key === 'css' && typeof value[key] === 'string' && STRUCTURAL_CSS.test(value[key])
      const candidate = safeLocatorText(value[key], `locator ${key}`, structuralCss)
      if (candidate) locator[key] = candidate
    }
  }
  if (!Object.keys(locator).length) throw new TypeError('workflow locator needs at least one strategy')
  return locator
}

function parseWorkflowValue(value: unknown, locator: WorkflowLocator): WorkflowValue {
  if (!isRecord(value)) throw new TypeError('invalid workflow value')
  if (value.kind === 'redacted' && value.reason === 'sensitive-input') {
    return { kind: 'redacted', reason: 'sensitive-input' }
  }
  if (value.kind === 'literal') {
    return redactLiteral(readString(value.text, 'value', MAX_VALUE_LENGTH, true), locator)
  }
  throw new TypeError('invalid workflow value')
}

export function parseWorkflowStep(value: unknown): WorkflowStep {
  if (!isRecord(value)) throw new TypeError('invalid workflow step')
  switch (value.type) {
    case 'navigate': {
      const url = sanitizeWorkflowUrl(readString(value.url, 'URL', MAX_URL_LENGTH))
      if (!url) throw new TypeError('invalid workflow URL')
      return { type: 'navigate', url }
    }
    case 'click':
      return { type: 'click', target: parseLocator(value.target) }
    case 'fill':
    case 'select': {
      const target = parseLocator(value.target)
      return { type: value.type, target, value: parseWorkflowValue(value.value, target) }
    }
    default:
      throw new TypeError('unsupported workflow step')
  }
}

export function parseWorkflowTrace(value: unknown): WorkflowTrace {
  if (!isRecord(value) || value.format !== 'opengrokbot.workflow' || value.version !== 1) {
    throw new TypeError('unsupported workflow trace format')
  }
  const title = readString(value.title, 'title', MAX_TITLE_LENGTH).trim()
  if (!Array.isArray(value.steps) || value.steps.length > MAX_WORKFLOW_STEPS) {
    throw new TypeError('invalid workflow steps')
  }
  return {
    format: 'opengrokbot.workflow',
    version: 1,
    title,
    steps: value.steps.map(parseWorkflowStep),
  }
}

function workflowDirectory(dataDir: string, botId: string): string {
  if (!SAFE_ID.test(botId) || botId === '.' || botId === '..') throw new TypeError('invalid bot id')
  return join(botDataDir(dataDir, botId), 'workflows')
}

function workflowPath(dataDir: string, botId: string, id: WorkflowTraceId): string {
  return join(workflowDirectory(dataDir, botId), `${id}.json`)
}

export async function saveWorkflowTrace(
  dataDir: string,
  botId: string,
  value: WorkflowTrace,
): Promise<SavedWorkflowTrace> {
  const trace = parseWorkflowTrace(value)
  const id = randomUUID()
  if (!isWorkflowTraceId(id)) throw new Error('UUID generator returned an invalid workflow id')
  const directory = workflowDirectory(dataDir, botId)
  const path = workflowPath(dataDir, botId, id)
  const temporaryPath = join(directory, `.${id}.tmp`)
  const contents = `${JSON.stringify(trace, null, 2)}\n`
  if (Buffer.byteLength(contents, 'utf8') > MAX_TRACE_BYTES) throw new TypeError('workflow trace is too large')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
  return { id, trace }
}

export async function listWorkflowTraces(dataDir: string, botId: string): Promise<SavedWorkflowTrace[]> {
  const directory = workflowDirectory(dataDir, botId)
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if (isMissingFile(error)) return []
    throw error
  }
  const traces: SavedWorkflowTrace[] = []
  for (const name of names.filter((file) => file.endsWith('.json')).sort()) {
    const id = name.slice(0, -'.json'.length)
    if (!isWorkflowTraceId(id)) continue
    const trace = await readWorkflowTrace(dataDir, botId, id)
    if (trace) traces.push({ id, trace })
  }
  return traces
}

export async function readWorkflowTrace(dataDir: string, botId: string, id: string): Promise<WorkflowTrace | null> {
  if (!isWorkflowTraceId(id)) throw new TypeError('invalid workflow id')
  const path = workflowPath(dataDir, botId, id)
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  }
  if (Buffer.byteLength(contents, 'utf8') > MAX_TRACE_BYTES) throw new TypeError('workflow trace is too large')
  const value: unknown = JSON.parse(contents)
  return parseWorkflowTrace(value)
}
