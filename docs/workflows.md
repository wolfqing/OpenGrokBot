# Recorded workflow traces

This first teach-mode slice records a browser trace for a later deterministic workflow runner. It does not replay,
schedule, or hand steps to the agent when a page changes. The slice exposes API controls only; it adds no start/stop
buttons or workflow editor to the product UI.

Recordings attach to the page already owned by the teammate's shared `BrowserSession`. They do not launch a second
browser or replace its logged-in context. In v0.4.0 local-computer mode, `showWindow()` and `hideWindow()` relaunch
Chromium; the recorder reattaches to the replacement page and continues recording. Show the local browser window
before recording: its panel screencast is view-only, so the operator drives the real window. Docker recording also
attaches to the current page. The recorder captures navigation, clicks, text entry, selection, checkbox state, and
Enter presses as typed steps. A navigation caused by an action is recorded as that action's expected URL, and a
popup is marked as unrecorded. It does not store screenshots, cookies, arbitrary page dumps, or generated JavaScript.

## Start, stop, review, and save

All endpoints require the gateway's normal authentication token. Drive the teammate's current page through its
computer screen while recording is active.

```http
POST /api/bots/{botId}/workflows/recording
Content-Type: application/json

{"title":"Open the project dashboard","intent":"Find the current project status"}
```

`intent` is optional. The gateway responds with `202` and starts recording. Only one recording or unsaved draft can
exist per teammate. Stop capture to receive a review draft:

```http
POST /api/bots/{botId}/workflows/recording/stop
```

Stopping does not save anything to SQLite. Review the returned trace, remove steps that should not be retained,
replace literal values with `{ "kind": "placeholder", "key": "customerEmail" }`, and then save the edited trace:

```http
POST /api/bots/{botId}/workflows
Content-Type: application/json

{"draftId":"<id returned by stop>","trace":{"format":"opensuperbot.workflow","version":1,"title":"...","steps":[]}}
```

The submitted trace is validated and sensitive fields are redacted again before persistence. To discard a draft:

```http
DELETE /api/bots/{botId}/workflows/drafts/{draftId}
```

Drafts are held in gateway memory until saved or discarded. Restarting the gateway discards pending drafts. Saved
traces are stored as rows in the gateway SQLite database, alongside routines. List and read saved traces with:

```http
GET /api/bots/{botId}/workflows
GET /api/bots/{botId}/workflows/{workflowId}
```

The computer status response includes `workflowRecording` during capture and `workflowDraft` while review is
pending. An active recording prevents idle computer cleanup until it is stopped.

## Trace format v1

The trace is JSON. Each locator candidate uses exactly one strategy; the ordered array preserves preference from
stable semantic locator to structural CSS fallback.

```ts
type WorkflowTrace = {
  format: 'opensuperbot.workflow'
  version: 1
  title: string
  intent?: string
  steps: WorkflowStep[]
}

type WorkflowStepContext = {
  intent?: string
  page?: string
  frame?: string
}

type WorkflowActionContext = WorkflowStepContext & { expect?: { url: string } }

type WorkflowStep = WorkflowStepContext & (
  | { type: 'navigate'; url: string }
  | (WorkflowActionContext & { type: 'click'; target: { candidates: Locator[] } })
  | (WorkflowActionContext & { type: 'fill'; target: { candidates: Locator[] }; value: WorkflowValue })
  | (WorkflowActionContext & { type: 'select'; target: { candidates: Locator[] }; value: WorkflowValue })
  | (WorkflowActionContext & { type: 'check' | 'uncheck'; target: { candidates: Locator[] } })
  | (WorkflowActionContext & { type: 'press'; key: 'Enter'; target: { candidates: Locator[] } })
  | { type: 'unrecorded-popup' }
)

type Locator =
  | { role: { role: string; name: string } }
  | { label: string }
  | { placeholder: string }
  | { testId: string }
  | { text: string }
  | { css: string }

type WorkflowValue =
  | { kind: 'literal'; text: string }
  | { kind: 'placeholder'; key: string }
  | { kind: 'redacted'; reason: 'sensitive-input' }
```

`page`, `frame`, and `intent` are optional on every step so recorder metadata can grow while the trace remains v1.
The current recorder emits one locator candidate for each recognized strategy, ordered as role/name, label,
placeholder, test ID, text, then CSS. CSS fallbacks are positional paths and do not copy element IDs or classes.

## Redaction and limits

The browser checks input type, autocomplete, labels, accessible names, placeholders, and field names before sending
values to the gateway. Password and one-time-code fields, credit-card autocomplete fields, fields marked with
sensitive terms such as `secret`, `token`, or `api key`, known credential formats, and high-entropy strings are
stored as redacted values without their text. The gateway validates every event again and re-applies field-name and
credential-pattern checks before a draft is returned or a saved trace is written. URL user info and fragments are
removed; query keys are retained with empty values. High-entropy path segments, including UUIDs, are replaced with
`:redacted`; those navigation steps cannot be replayed as the original record-specific URL. Only HTTP and HTTPS
navigation is recorded.

V1 is bounded to 1,000 steps, 120 title characters, 500 intent characters, 2,000 input characters per step, and
5 MB per trace. Secret detection relies on field metadata and credential-pattern checks; avoid entering secrets
into fields that are not marked or named as sensitive. The operator review before saving lets the operator remove
personal values that do not match these automatic checks.
