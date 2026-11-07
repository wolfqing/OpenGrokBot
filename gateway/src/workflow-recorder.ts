import { randomBytes, randomUUID } from 'node:crypto'
import type { CdpSessionLike, PageLike } from './browser-page.js'
import {
  MAX_WORKFLOW_STEPS, MAX_WORKFLOW_TRACE_BYTES, parseWorkflowStep, parseWorkflowTrace, sanitizeWorkflowUrl,
  type WorkflowTrace,
} from './workflows.js'

export type WorkflowRecording = {
  reattach(page: PageLike): Promise<void>
  detach?(): Promise<void>
  markIncomplete?(): void
  stop(): Promise<WorkflowTrace>
}

type PageListener = (value?: unknown) => void
type CdpListener = (value: unknown) => void

type CdpContext = {
  newCDPSession(page: unknown): Promise<CdpSessionLike>
}

type Attachment = {
  page: RecordablePage
  session: CdpSessionLike
  closed: boolean
  detaching: boolean
  mainFrameId: string | null
  documentKey: string | null
  contextId: number | null
  worldTask: { key: string; promise: Promise<void> } | null
  detachTask: Promise<void> | null
  onFrameNavigated: CdpListener
  onSameDocumentNavigation: CdpListener
  onBindingCalled: CdpListener
  onClose: PageListener
  onPopup: PageListener
}

type RecordablePage = Omit<PageLike, 'context' | 'on' | 'off'> & {
  context(): CdpContext
  on(event: 'close' | 'popup', listener: PageListener): void
  off(event: 'close' | 'popup', listener: PageListener): void
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function canRecord(page: PageLike): page is RecordablePage {
  return typeof page.context === 'function'
    && typeof page.context().newCDPSession === 'function'
    && typeof page.on === 'function'
    && typeof page.off === 'function'
}

function captureScript(bindingName: string, marker: string, capability: string): string {
  return `(async () => {
    const marker = ${JSON.stringify(marker)};
    const previous = window[marker];
    const capability = ${JSON.stringify(capability)};
    if (previous && typeof previous.cleanup === 'function') await previous.cleanup(capability);
    const bindingName = ${JSON.stringify(bindingName)};
    const binding = window[bindingName];
    const pending = new Set();
    const emit = (event) => {
      if (typeof binding !== 'function') return Promise.resolve();
      const operation = Promise.resolve(binding(JSON.stringify({ ...event, isTrusted: true, __proof: capability }))).catch(() => {});
      pending.add(operation);
      void operation.finally(() => pending.delete(operation));
      return operation;
    };
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 256);
    const textOf = (element) => clean(element.innerText || element.textContent || '');
    const labelsOf = (element) => element.labels ? Array.from(element.labels, (label) => textOf(label)).filter(Boolean) : [];
    const editable = (element) => {
      if (element instanceof HTMLTextAreaElement) return true;
      if (element instanceof HTMLInputElement) return !['hidden', 'button', 'submit', 'reset', 'image', 'file', 'checkbox', 'radio'].includes(element.type.toLowerCase());
      return element.isContentEditable || element.getAttribute('role') === 'textbox';
    };
    const accessibleName = (element) => {
      const labelledBy = clean(element.getAttribute('aria-labelledby')).split(' ').filter(Boolean)
        .map((id) => document.getElementById(id)).filter(Boolean).map(textOf).filter(Boolean).join(' ');
      const semanticName = element.getAttribute('aria-label') || labelledBy || labelsOf(element).join(' ')
        || element.getAttribute('placeholder') || element.getAttribute('title');
      return clean(semanticName || (editable(element) ? '' : textOf(element)));
    };
    const roleOf = (element) => {
      const explicit = clean(element.getAttribute('role'));
      if (explicit) return explicit;
      const tag = element.tagName.toLowerCase();
      if (tag === 'a' && element.hasAttribute('href')) return 'link';
      if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset'].includes(element.type))) return 'button';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return element.multiple ? 'listbox' : 'combobox';
      if (tag === 'input') {
        if (element.type === 'checkbox') return 'checkbox';
        if (element.type === 'radio') return 'radio';
        if (element.type === 'range') return 'slider';
        return 'textbox';
      }
      return '';
    };
    const cssPath = (element) => {
      const parts = [];
      let current = element;
      while (current && current.nodeType === 1 && parts.length < 6) {
        const tag = current.tagName.toLowerCase();
        const siblings = current.parentElement ? Array.from(current.parentElement.children).filter((sibling) => sibling.tagName === current.tagName) : [current];
        const index = siblings.indexOf(current) + 1;
        parts.unshift(tag + ':nth-of-type(' + index + ')');
        current = current.parentElement;
      }
      return parts.join(' > ').slice(0, 256);
    };
    const locatorFor = (element) => {
      const candidates = [];
      const role = roleOf(element);
      const name = accessibleName(element);
      if (role && name) candidates.push({ role: { role, name } });
      const labels = labelsOf(element);
      if (labels.length) candidates.push({ label: labels[0] });
      const placeholder = clean(element.getAttribute('placeholder'));
      if (placeholder) candidates.push({ placeholder });
      const testId = clean(element.getAttribute('data-testid'));
      if (testId) candidates.push({ testId });
      if (['a', 'button', 'summary'].includes(element.tagName.toLowerCase()) || role === 'button' || role === 'link') {
        const text = textOf(element);
        if (text) candidates.push({ text });
      }
      const css = cssPath(element);
      if (css) candidates.push({ css });
      return { candidates };
    };
    const sensitiveName = /(?:^|[^a-z0-9])(?:pass(?:word|code)?|secret|token|credential|api[\\s_-]*key|otp|totp|mfa|private[\\s_-]*key|credit[\\s_-]*card|card[\\s_-]*number|cc[\\s_-]*(?:number|exp|csc)|(?:one[\\s_-]*)?time[\\s_-]*(?:password|code|pin|token)|(?:security|verification) code|\\d{1,2}[\\s-]*digit(?:al)?[\\s-]+code|auth(?:entication|orization)? code)(?=$|[^a-z0-9])/i;
    const sensitiveAutocomplete = /\\b(?:current-password|new-password|one-time-code|cc-(?:number|exp|exp-month|exp-year|csc|name|type))\\b/i;
    const secretPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\\bBearer\\s+\\S+|\\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,})\\b|\\b(?:password|secret|token|api[\\s_-]*key)\\s*[:=]\\s*[^\\s,;]{6,}/i;
    const entropySecret = (value) => {
      const compact = value.replace(/\\s/g, '');
      if (compact.length < 32) return false;
      const counts = new Map();
      for (const character of compact) counts.set(character, (counts.get(character) || 0) + 1);
      let entropy = 0;
      for (const count of counts.values()) { const probability = count / compact.length; entropy -= probability * Math.log2(probability); }
      return entropy >= 3.5;
    };
    const sensitive = (element) => {
      const metadata = [element.type, element.name, element.id, element.getAttribute('autocomplete'),
        element.getAttribute('aria-label'), element.getAttribute('aria-labelledby'), element.getAttribute('placeholder'),
        ...labelsOf(element), accessibleName(element)].join(' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
      return (element.tagName.toLowerCase() === 'input' && element.type.toLowerCase() === 'password')
        || sensitiveAutocomplete.test(element.getAttribute('autocomplete') || '')
        || sensitiveName.test(metadata);
    };
    const valueFor = (element) => {
      if (sensitive(element)) return { kind: 'redacted', reason: 'sensitive-input' };
      let value = '';
      if (element instanceof HTMLSelectElement) value = Array.from(element.selectedOptions, (option) => clean(option.textContent)).join(', ');
      else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) value = element.value;
      else value = element.textContent || '';
      return secretPattern.test(value) || entropySecret(value)
        ? { kind: 'redacted', reason: 'sensitive-input' }
        : { kind: 'literal', text: value.slice(0, 2000) };
    };
    const actionable = 'a[href],button,input[type=button],input[type=submit],input[type=reset],input[type=checkbox],input[type=radio],[role=button],[role=link],summary,label,[onclick]';
    const timers = new Map();
    let enterSubmitForm = null;
    let enterSubmitAt = 0;
    const flush = (element, type = 'fill', force = false) => {
      const timer = timers.get(element);
      if (timer === undefined && !force) return;
      if (timer !== undefined) { clearTimeout(timer); timers.delete(element); }
      return emit({ type, target: locatorFor(element), value: valueFor(element) });
    };
    const onInput = (event) => {
      if (!event.isTrusted) return;
      const element = event.target;
      if (!(element instanceof Element) || !editable(element)) return;
      const timer = timers.get(element);
      if (timer !== undefined) clearTimeout(timer);
      timers.set(element, setTimeout(() => flush(element), 400));
    };
    const onChange = (event) => {
      if (!event.isTrusted) return;
      const element = event.target;
      if (!(element instanceof Element)) return;
      if (element instanceof HTMLSelectElement) flush(element, 'select', true);
      else if (editable(element)) flush(element);
    };
    const onBlur = (event) => {
      if (!event.isTrusted) return;
      const element = event.target;
      if (element instanceof Element && editable(element)) flush(element);
    };
    const onClick = (event) => {
      if (!event.isTrusted) return;
      const element = event.target instanceof Element ? event.target.closest(actionable) : null;
      if (!element) return;
      if (element instanceof HTMLLabelElement && element.control) return;
      const submitForm = element instanceof HTMLButtonElement && element.type === 'submit'
        ? element.form
        : element instanceof HTMLInputElement && element.type === 'submit' ? element.form : null;
      if (submitForm && event.detail === 0 && submitForm === enterSubmitForm && Date.now() - enterSubmitAt < 1_000) {
        enterSubmitForm = null;
        return;
      }
      if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
        emit({ type: element.checked ? 'check' : 'uncheck', target: locatorFor(element) });
        return;
      }
      emit({ type: 'click', target: locatorFor(element) });
    };
    const onKeyDown = (event) => {
      if (!event.isTrusted) return;
      const element = event.target;
      if (event.key === 'Enter' && element instanceof Element && editable(element)) {
        if (element instanceof HTMLInputElement && element.form) {
          enterSubmitForm = element.form;
          enterSubmitAt = Date.now();
        }
        flush(element);
        emit({ type: 'press', key: 'Enter', target: locatorFor(element) });
      }
    };
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('blur', onBlur, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    window[marker] = { async cleanup(providedCapability) {
      if (providedCapability !== capability) return;
      for (const element of [...timers.keys()]) flush(element);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('change', onChange, true);
      document.removeEventListener('blur', onBlur, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
      delete window[marker];
      await Promise.all([...pending]);
    } };
  })()`
}

function removeCaptureScript(marker: string, capability: string): string {
  return `(() => { const state = window[${JSON.stringify(marker)}]; if (state && typeof state.cleanup === 'function') return state.cleanup(${JSON.stringify(capability)}); })()`
}

/** Attach to the teammate's existing page; reattach is used when local show/hide relaunches Chromium. */
export async function createWorkflowRecorder(page: PageLike, title: string, intent?: string): Promise<WorkflowRecording> {
  const trace: WorkflowTrace = parseWorkflowTrace({ format: 'opensuperbot.workflow', version: 1, title, ...(intent ? { intent } : {}), steps: [] })
  const recordingId = randomUUID().replace(/-/g, '')
  const capability = randomBytes(32).toString('hex')
  const bindingName = `__opensuperbot_workflow_${recordingId}`
  const marker = `__opensuperbot_workflow_state_${recordingId}`
  const worldName = `opensuperbot-workflow-world-${recordingId}`
  let active = true
  let current: Attachment | null = null
  let stopped: WorkflowTrace | null = null
  let stopPromise: Promise<WorkflowTrace> | null = null
  let lastAction: { index: number; at: number } | null = null
  let traceBytes = Buffer.byteLength(JSON.stringify(trace), 'utf8')
  const NAVIGATION_EXPECTATION_WINDOW_MS = 5_000

  const append = (step: unknown) => {
    if (!active || trace.truncated) return
    if (trace.steps.length >= MAX_WORKFLOW_STEPS) {
      trace.truncated = true
      return
    }
    try {
      const parsed = parseWorkflowStep(step)
      if (parsed.type === 'navigate') {
        const action = lastAction
        if (action && Date.now() - action.at <= NAVIGATION_EXPECTATION_WINDOW_MS) {
          const previous = trace.steps[action.index]
          if (previous && previous.type !== 'navigate' && previous.type !== 'unrecorded-popup') {
            const updated = parseWorkflowStep({ ...previous, expect: { url: parsed.url } })
            const addedBytes = Buffer.byteLength(JSON.stringify(updated), 'utf8')
              - Buffer.byteLength(JSON.stringify(previous), 'utf8')
            if (traceBytes + addedBytes > MAX_WORKFLOW_TRACE_BYTES - 32) {
              trace.truncated = true
              return
            }
            trace.steps[action.index] = updated
            traceBytes += addedBytes
            lastAction = null
            return
          }
        }
        lastAction = null
        const last = trace.steps.at(-1)
        if (last?.type === 'navigate' && last.url === parsed.url) return
      } else if (parsed.type === 'unrecorded-popup') {
        lastAction = null
      } else {
        lastAction = { index: trace.steps.length, at: Date.now() }
      }
      const stepBytes = Buffer.byteLength(JSON.stringify(parsed), 'utf8')
      const addedBytes = stepBytes + (trace.steps.length ? 1 : -1)
      if (traceBytes + addedBytes > MAX_WORKFLOW_TRACE_BYTES - 32) {
        trace.truncated = true
        return
      }
      trace.steps.push(parsed)
      traceBytes += addedBytes
    } catch {
      // Browser events are untrusted input; incomplete or unknown events are skipped.
    }
  }

  const evaluateInWorld = async (session: CdpSessionLike, contextId: number, expression: string) => {
    const response = objectValue(await session.send('Runtime.evaluate', {
      expression, contextId, awaitPromise: true, returnByValue: true,
    }))
    const exception = objectValue(response?.exceptionDetails)
    if (exception) {
      const message = typeof exception.text === 'string' ? exception.text : 'isolated workflow script failed'
      throw new Error(message)
    }
  }

  const detach = (attachment: Attachment): Promise<void> => {
    if (attachment.detachTask) return attachment.detachTask
    attachment.detaching = true
    const task = (async () => {
      if (attachment.worldTask) await attachment.worldTask.promise.catch(() => {})
      if (!attachment.closed && attachment.contextId !== null) {
        try {
          await evaluateInWorld(attachment.session, attachment.contextId, removeCaptureScript(marker, capability))
        } catch {
          trace.truncated = true
        }
      }
      try {
        await attachment.session.send('Runtime.removeBinding', { name: bindingName })
      } catch {
        trace.truncated = true
      }
      try { attachment.page.off('close', attachment.onClose) } catch { trace.truncated = true }
      try { attachment.page.off('popup', attachment.onPopup) } catch { trace.truncated = true }
      try { attachment.session.off?.('Page.frameNavigated', attachment.onFrameNavigated) } catch { trace.truncated = true }
      try { attachment.session.off?.('Page.navigatedWithinDocument', attachment.onSameDocumentNavigation) } catch { trace.truncated = true }
      try { attachment.session.off?.('Runtime.bindingCalled', attachment.onBindingCalled) } catch { trace.truncated = true }
      if (current === attachment) current = null
      attachment.contextId = null
      try {
        await attachment.session.detach()
      } catch {
        trace.truncated = true
      }
    })()
    attachment.detachTask = task
    return task
  }

  const attach = async (candidate: PageLike) => {
    if (!active) return
    if (!canRecord(candidate)) {
      trace.truncated = true
      throw new Error('the bot browser cannot record workflow events')
    }
    if (current?.page === candidate) return
    lastAction = null
    if (current) await detach(current)

    const session = await candidate.context().newCDPSession(candidate)
    let attachment: Attachment | null = null

    const ensureWorld = async (frameId: string, loaderId: string, url: string) => {
      const target = attachment
      if (!target || !active || target.closed || target.detaching || current !== target) return
      const key = `${frameId}:${loaderId || url}`
      target.mainFrameId = frameId
      if (target.documentKey === key && target.contextId !== null) return
      if (target.worldTask?.key === key) return target.worldTask.promise
      target.documentKey = key
      target.contextId = null
      const promise = (async () => {
        try {
          const response = objectValue(await target.session.send('Page.createIsolatedWorld', {
            frameId, worldName, grantUniversalAccess: false,
          }))
          const contextId = response?.executionContextId
          if (typeof contextId !== 'number' || !Number.isSafeInteger(contextId)) {
            throw new Error('Chromium did not create the isolated workflow world')
          }
          if (current !== target || target.documentKey !== key) return
          target.contextId = contextId
          await evaluateInWorld(target.session, contextId, captureScript(bindingName, marker, capability))
        } catch (error) {
          if (current !== target || target.documentKey !== key) return
          target.contextId = null
          trace.truncated = true
          throw error
        }
      })()
      const worldTask = { key, promise }
      target.worldTask = worldTask
      try {
        await promise
      } finally {
        if (target.worldTask === worldTask) target.worldTask = null
      }
    }

    const onFrameNavigated: CdpListener = (value) => {
      const target = attachment
      const frame = objectValue(objectValue(value)?.frame)
      if (!active || !target || current !== target || target.detaching || !frame
        || typeof frame.id !== 'string' || frame.parentId !== undefined) return
      const url = typeof frame.url === 'string' ? frame.url : ''
      const cleanUrl = sanitizeWorkflowUrl(url)
      if (cleanUrl) append({ type: 'navigate', url: cleanUrl })
      void ensureWorld(frame.id, typeof frame.loaderId === 'string' ? frame.loaderId : '', url).catch(() => {})
    }

    const onSameDocumentNavigation: CdpListener = (value) => {
      const target = attachment
      const event = objectValue(value)
      if (!active || !target || current !== target || target.detaching || !event
        || event.frameId !== target.mainFrameId || typeof event.url !== 'string') return
      const url = sanitizeWorkflowUrl(event.url)
      if (url) append({ type: 'navigate', url })
    }

    const onBindingCalled: CdpListener = (value) => {
      const target = attachment
      const event = objectValue(value)
      if (!active || !target || target.closed || current !== target || !event
        || event.name !== bindingName || event.executionContextId !== target.contextId
        || typeof event.payload !== 'string') return
      let submitted: Record<string, unknown> | null = null
      try { submitted = objectValue(JSON.parse(event.payload)) } catch { return }
      if (!submitted || submitted.__proof !== capability || submitted.isTrusted !== true
        || !['click', 'check', 'uncheck', 'press', 'fill', 'select'].includes(String(submitted.type))) return
      append({
        type: submitted.type,
        ...(submitted.target !== undefined ? { target: submitted.target } : {}),
        ...(submitted.value !== undefined ? { value: submitted.value } : {}),
        ...(submitted.key !== undefined ? { key: submitted.key } : {}),
      })
    }

    const onClose: PageListener = () => {
      const target = attachment
      if (!target) return
      target.closed = true
      trace.truncated = true
      lastAction = null
      void detach(target)
    }
    const onPopup: PageListener = () => {
      if (!active || !attachment || current !== attachment) return
      append({ type: 'unrecorded-popup' })
    }

    attachment = {
      page: candidate,
      session,
      closed: false,
      detaching: false,
      mainFrameId: null,
      documentKey: null,
      contextId: null,
      worldTask: null,
      detachTask: null,
      onFrameNavigated,
      onSameDocumentNavigation,
      onBindingCalled,
      onClose,
      onPopup,
    }
    current = attachment
    candidate.on('close', onClose)
    candidate.on('popup', onPopup)
    session.on('Page.frameNavigated', onFrameNavigated)
    session.on('Page.navigatedWithinDocument', onSameDocumentNavigation)
    session.on('Runtime.bindingCalled', onBindingCalled)
    try {
      await session.send('Runtime.enable')
      await session.send('Runtime.addBinding', { name: bindingName, executionContextName: worldName })
      await session.send('Page.enable')
      const frameTree = objectValue(objectValue(await session.send('Page.getFrameTree'))?.frameTree)
      const frame = objectValue(frameTree?.frame)
      if (!frame || typeof frame.id !== 'string' || typeof frame.url !== 'string') {
        throw new Error('Chromium did not return a main frame for workflow recording')
      }
      const initialUrl = sanitizeWorkflowUrl(frame.url)
      if (initialUrl) append({ type: 'navigate', url: initialUrl })
      await ensureWorld(frame.id, typeof frame.loaderId === 'string' ? frame.loaderId : '', frame.url)
    } catch (error) {
      trace.truncated = true
      await detach(attachment)
      throw error
    }
  }

  await attach(page)

  return {
    reattach: attach,
    async detach() {
      if (current) await detach(current)
    },
    markIncomplete() {
      trace.truncated = true
    },
    stop() {
      if (stopped) return Promise.resolve(stopped)
      stopPromise ??= (async () => {
        try {
          if (current) await detach(current)
        } finally {
          active = false
        }
        stopped = parseWorkflowTrace(trace)
        return stopped
      })()
      stopPromise = stopPromise.catch((error: unknown) => {
        stopPromise = null
        throw error
      })
      return stopPromise
    },
  }
}
