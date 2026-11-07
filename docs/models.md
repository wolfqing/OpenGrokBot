# AI models

Every teammate can run on its own model. Open **AI** in the sidebar to manage *connections* — a service, its key
and a default model — then click the model label at the top of a teammate's thread to pick one for it. A change
takes effect from that teammate's next turn.

The connection you set up first (with env vars or the settings API) is the **default**. Every teammate that has
not picked a connection uses it, and env vars still pin its fields (`OPENSUPERBOT_API_BASE`, `_MODEL`, `_VISION`,
`_API_KEY`). A key pinned by `OPENSUPERBOT_API_KEY` also pins the service and address, since that key belongs to
one service. When a connection moves to another service or address, its stored key is dropped unless a new one
comes with it, and the models teammates picked on it go back to the connection's default.

Extra connections live in the database. Each key lives in `<data>/llm-keys/<id>`, readable only by your account
(mode `0600`; on Windows, an ACL for your account alone), and is only ever shown masked. Deleting a connection
moves its teammates back to the default.

## Services

Each preset was checked against the service's own docs on the date in `gateway/src/providers.ts`.

| Service | Talks over | Default model | Notes |
|---|---|---|---|
| Claude | Anthropic Messages API (official SDK) | `claude-opus-5-5` | Effort `medium`. Cheaper: `claude-sonnet-5-5`, `claude-haiku-5-5`. |
| OpenAI | Responses API | `gpt-6-luna` | Reasoning effort `low`. Every GPT-6 model can call tools here; on Chat Completions most cannot. |
| xAI Grok | Responses API | `grok-4.7` | xAI marks Chat Completions deprecated. |
| Gemini | OpenAI-compatible | `gemini-3.5-flash-lite` | AI Studio key; there is a free tier. |
| MiniMax (global / China) | OpenAI-compatible | `MiniMax-M3.1-Flash` | Reasoning effort `low` (its default is `max`). |
| DeepSeek, Kimi, Qwen, GLM | OpenAI-compatible | see the presets | |
| OpenRouter | OpenAI-compatible | `anthropic/claude-haiku-5.5` | One key for many vendors. |
| Ollama | OpenAI-compatible | `qwen3-vl:8b` | Runs on this machine, no key. |
| Custom | your choice of the three | — | For any endpoint that speaks one of them (several services offer an Anthropic-compatible one). |

**Test** on a connection lists the service's models and sends a tiny request, then says in plain words what went
wrong: a key that is not accepted, an empty balance, rate limiting, a model name the service does not have, an
address that does not answer.

## Subscriptions: which ones other apps may use

A teammate runs routines while nobody watches. That is exactly the use subscription terms are written about, and
a suspended account would be your main account. So the gateway only offers what the terms allow (checked
2026-11-07; they have changed several times this year, so check again before relying on one):

| Subscription | Here? | Why |
|---|---|---|
| Claude Pro / Max sign-in | **No** | Anthropic does not allow other apps to use subscription sign-ins and has blocked tools that did. The gateway refuses a pasted sign-in token (`sk-ant-oat…`). Max, Ultra and Team plans come with monthly API credits: link a Console organization in claude.ai billing settings and create an API key there. |
| Gemini via your Google account (the Gemini CLI sign-in) | **No** | Not allowed for other apps; accounts have been suspended for it. Use an AI Studio key; Google AI Pro and Ultra include Cloud credits. |
| ChatGPT Plus / Pro | Coming | OpenAI offers an official "Sign in with ChatGPT" for open-source and local apps. It is the next stage of this work. |
| SuperGrok | Not yet | xAI has opened subscription sign-in to one tool so far. |
| MiniMax M Plan | Yes, with a warning | Its terms let any compatible tool connect, but call it a plan for one person developing interactively and point production use to pay-as-you-go. The form shows that before it lets you save. |
| GLM Coding Plan (Zhipu / Z.ai) | **No** | Its subscription terms forbid calling the models from your own apps or bots; more than three violations can close the account. |
| Kimi Code | **No** | Its guidelines allow personal, interactive use only, not unattended automation. |
| Alibaba Cloud Model Studio Coding Plan | **No** | Interactive use in coding tools only; no scripts or app backends. |

For the three plans marked **No**, use the same company's pay-as-you-go API key with its regular preset (GLM,
Kimi, Qwen).

## How the three APIs are handled

Inside the gateway every conversation is kept in one format; each connection translates it on the way out.

- **Claude**: system prompt and tools the Anthropic way; Claude's own content blocks, thinking included, go back
  unchanged for the rest of the turn. Claude refuses later thinking blocks once anything before them changes, so
  the gateway keeps earlier screenshots in place (prompt caching makes the repeats cheap) and only folds them
  away in batches: past ten, the oldest five become a placeholder, and on Anthropic's own API the request asks
  it to drop the thinking blocks that no longer match instead of rejecting it. On Anthropic's own API, the
  models that support it also get the server-side refusal fallback; a refusal that remains shows up as an error
  in the thread. A Claude connection only ever sends its own key: with none it refuses to run rather than let
  the SDK pick up Anthropic credentials or headers configured elsewhere on the machine.
- **Responses** (OpenAI, xAI): nothing is stored on the service (`store: false`); the encrypted reasoning comes
  back with each step and goes back with the next one.
- **OpenAI-compatible**: as before. Fields a service attaches to a reply (Gemini's thought signatures, MiniMax's
  `reasoning_content`) go back unchanged within the turn, which those services require for tool calls.

Older screenshots are replaced with a short placeholder on the second and third kinds, the same as before.
