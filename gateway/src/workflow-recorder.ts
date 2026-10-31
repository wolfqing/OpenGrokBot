import { randomUUID } from 'node:crypto'
import type { PageLike } from './browser-page.js'
import {
  MAX_WORKFLOW_STEPS, parseWorkflowStep, parseWorkflowTrace, sanitizeWorkflowUrl,
  type WorkflowTrace,
} from './workflows.js'

export type WorkflowRecording = { stop(): Promise<WorkflowTrace> }

type RecordablePage = PageLike & Required<Pick<
  PageLike,
  'evaluate' | 'exposeBinding' | 'on' | 'off'
>>

function canRecord(page: PageLike): page is RecordablePage {
  return typeof page.evaluate === 'function'
    && typeof page.exposeBinding === 'function'
    && typeof page.on === 'function'
    && typeof page.off === 'function'
}

function captureScript(bindingName: string, marker: string): string {
  return `(() => {
    const marker = ${JSON.stringify(marker)};
    const previous = window[marker];
    if (previous && typeof previous.cleanup === 'function') previous.cleanup();
    const bindingName = ${JSON.stringify(bindingName)};
    const emit = (event) => {
      const binding = window[bindingName];
      if (typeof binding === 'function') void binding(event).catch(() => {});
    };
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 256);
    const textOf = (element) => clean(element.innerText || element.textContent || '');
    const labelsOf = (element) => element.labels ? Array.from(element.labels, (label) => textOf(label)).filter(Boolean) : [];
    const accessibleName = (element) => {
      const labelledBy = clean(element.getAttribute('aria-labelledby')).split(' ').filter(Boolean)
        .map((id) => document.getElementById(id)).filter(Boolean).map(textOf).filter(Boolean).join(' ');
      return clean(element.getAttribute('aria-label') || labelledBy || labelsOf(element).join(' ')
        || element.getAttribute('placeholder') || element.getAttribute('title') || textOf(element));
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
      const locator = {};
      const role = roleOf(element);
      const name = accessibleName(element);
      if (role && name) locator.role = { role, name };
      const labels = labelsOf(element);
      if (labels.length) locator.label = labels[0];
      const placeholder = clean(element.getAttribute('placeholder'));
      if (placeholder) locator.placeholder = placeholder;
      const testId = clean(element.getAttribute('data-testid'));
      if (testId) locator.testId = testId;
      if (['a', 'button', 'summary'].includes(element.tagName.toLowerCase()) || role === 'button' || role === 'link') {
        const text = textOf(element);
        if (text) locator.text = text;
      }
      const css = cssPath(element);
      if (css) locator.css = css;
      return locator;
    };
    const sensitiveName = /(?:^|[^a-z0-9])(?:pass(?:word|code)?|secret|token|credential|api[\\s_-]*key|otp|totp|mfa|private[\\s_-]*key|credit[\\s_-]*card|card[\\s_-]*number|cc[\\s_-]*(?:number|exp|csc)|(?:one[\\s_-]*)?time[\\s_-]*(?:password|code|pin|token)|(?:security|verification) code|auth(?:entication|orization)? code)(?=$|[^a-z0-9])/i;
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
    const editable = (element) => {
      if (element instanceof HTMLTextAreaElement) return true;
      if (element instanceof HTMLInputElement) return !['hidden', 'button', 'submit', 'reset', 'image', 'file', 'checkbox', 'radio'].includes(element.type.toLowerCase());
      return element.isContentEditable || element.getAttribute('role') === 'textbox';
    };
    const flush = (element, type = 'fill', force = false) => {
      const timer = timers.get(element);
      if (timer === undefined && !force) return;
      if (timer !== undefined) { clearTimeout(timer); timers.delete(element); }
      emit({ type, target: locatorFor(element), value: valueFor(element) });
    };
    const onInput = (event) => {
      const element = event.target;
      if (!(element instanceof Element) || !editable(element)) return;
      const timer = timers.get(element);
      if (timer !== undefined) clearTimeout(timer);
      timers.set(element, setTimeout(() => flush(element), 400));
    };
    const onChange = (event) => {
      const element = event.target;
      if (!(element instanceof Element)) return;
      if (element instanceof HTMLSelectElement) flush(element, 'select', true);
      else if (editable(element)) flush(element);
    };
    const onBlur = (event) => {
      const element = event.target;
      if (element instanceof Element && editable(element)) flush(element);
    };
    const onClick = (event) => {
      const element = event.target instanceof Element ? event.target.closest(actionable) : null;
      if (element) emit({ type: 'click', target: locatorFor(element) });
    };
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('blur', onBlur, true);
    document.addEventListener('click', onClick, true);
    window[marker] = { cleanup() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('change', onChange, true);
      document.removeEventListener('blur', onBlur, true);
      document.removeEventListener('click', onClick, true);
      delete window[marker];
    } };
  })()`
}

function removeCaptureScript(marker: string): string {
  return `(() => { const state = window[${JSON.stringify(marker)}]; if (state && typeof state.cleanup === 'function') state.cleanup(); })()`
}

/** Attach to the already-open shared Page; this never creates or replaces a browser context. */
export async function createWorkflowRecorder(page: PageLike, title: string): Promise<WorkflowRecording> {
  if (!canRecord(page)) throw new Error('the bot browser cannot record workflow events')
  const trace: WorkflowTrace = parseWorkflowTrace({ format: 'opengrokbot.workflow', version: 1, title, steps: [] })
  const recordingId = randomUUID()
  const bindingName = `__opengrokbot_workflow_${recordingId.replace(/-/g, '')}`
  const marker = `__opengrokbot_workflow_state_${recordingId.replace(/-/g, '')}`
  let active = true
  let closed = false
  let stopped: WorkflowTrace | null = null
  let stopPromise: Promise<WorkflowTrace> | null = null

  const append = (value: unknown) => {
    if (!active || trace.steps.length >= MAX_WORKFLOW_STEPS) return
    try {
      const step = parseWorkflowStep(value)
      if (step.type === 'navigate') {
        const last = trace.steps.at(-1)
        if (last?.type === 'navigate' && last.url === step.url) return
      }
      trace.steps.push(step)
    } catch {
      // Browser events are untrusted input; an incomplete or unknown event is skipped.
    }
  }

  const onNavigate = () => {
    if (!active) return
    const url = sanitizeWorkflowUrl(page.url())
    if (url) append({ type: 'navigate', url })
    void page.evaluate(captureScript(bindingName, marker))
      .then(async () => { if (!active) await page.evaluate(removeCaptureScript(marker)).catch(() => {}) })
      .catch(() => {})
  }
  const onClose = () => { closed = true }

  const binding = await page.exposeBinding(bindingName, async (_source, event) => { append(event) })
  page.on('framenavigated', onNavigate)
  page.on('close', onClose)
  try {
    const initialUrl = sanitizeWorkflowUrl(page.url())
    if (initialUrl) append({ type: 'navigate', url: initialUrl })
    await page.evaluate(captureScript(bindingName, marker))
  } catch (error) {
    active = false
    page.off('framenavigated', onNavigate)
    page.off('close', onClose)
    await binding.dispose().catch(() => {})
    throw error
  }

  return {
    stop() {
      if (stopped) return Promise.resolve(stopped)
      stopPromise ??= (async () => {
        active = false
        page.off('framenavigated', onNavigate)
        page.off('close', onClose)
        if (!closed) await page.evaluate(removeCaptureScript(marker)).catch(() => {})
        await binding.dispose().catch(() => {})
        stopped = parseWorkflowTrace(trace)
        return stopped
      })()
      return stopPromise
    },
  }
}
