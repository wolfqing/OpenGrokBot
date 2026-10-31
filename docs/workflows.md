# Recorded workflow traces

The first teach-mode slice records a browser trace for a later deterministic workflow runner. It does not replay,
schedule, or hand steps to the agent when a page changes.

Recordings attach to the page already owned by the teammate's shared `BrowserSession`. They do not launch a second
browser or replace its logged-in context. The recorder captures navigation, clicks, text entry, and selection as
typed steps with semantic locator candidates. It does not store screenshots, cookies, arbitrary page dumps, or
generated JavaScript.

## Start, stop, and inspect a recording

All endpoints require the gateway's normal authentication token. Drive the teammate's current page through its
computer screen while the recording is active.

```http
POST /api/bots/{botId}/workflows/recording
Content-Type: application/json

{"title":"Open the project dashboard"}
```

The gateway responds with `202` and starts recording. Only one recording can run per teammate at a time. Stop and
save it with:

```http
POST /api/bots/{botId}/workflows/recording/stop
```

The response contains a UUID `id` and the saved trace. List and read traces with:

```http
GET /api/bots/{botId}/workflows
GET /api/bots/{botId}/workflows/{workflowId}
```

Traces live in the gateway-owned data directory at `bots/{botId}/workflows/{workflowId}.json`, outside the
teammate's writable workspace. The computer status response includes `workflowRecording` while capture is active.
An active recording prevents idle computer cleanup until it is stopped.

## Trace format v1

The trace is JSON and uses a discriminated union for each action:

```ts
type WorkflowTrace = {
  format: 'opengrokbot.workflow'
  version: 1
  title: string
  steps: WorkflowStep[]
}

type WorkflowStep =
  | { type: 'navigate'; url: string }
  | { type: 'click'; target: Locator }
  | { type: 'fill'; target: Locator; value: WorkflowValue }
  | { type: 'select'; target: Locator; value: WorkflowValue }

type Locator = {
  role?: { role: string; name: string }
  label?: string
  placeholder?: string
  text?: string
  testId?: string
  css?: string
}

type WorkflowValue =
  | { kind: 'literal'; text: string }
  | { kind: 'redacted'; reason: 'sensitive-input' }
```

Locator fields are candidate strategies, ordered for future replay as role/name, label, placeholder, test ID, text,
then CSS. CSS uses a positional fallback and does not copy element IDs or class names.

## Redaction and limits

The browser checks input type, autocomplete, labels, accessible names, placeholders, and field names before sending
values to the gateway. Password and one-time-code fields, credit-card autocomplete fields, fields marked with
sensitive terms such as `secret`, `token`, or `api key`, known credential formats, and high-entropy strings are
stored as a redacted value without the text. The gateway validates every event again and re-applies field-name
and credential-pattern checks before persistence. URL user info and fragments are removed; query keys are retained
with empty values. Only HTTP and HTTPS navigation is recorded.

V1 is bounded to 1,000 steps, 120 title characters, 2,000 input characters per step, and 5 MB per saved trace.
Secret detection relies on field metadata and credential-pattern checks; avoid entering secrets into fields that
are not marked or named as sensitive.
