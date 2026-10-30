# Changelog

What changed, release by release. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/) while the project is pre-1.0, so a minor version can
still change behaviour.

## [Unreleased]

### Security

- A webhook delivery refused because the last run was still going is no longer remembered as "seen", so
  GitHub's redelivery of it runs instead of being dropped as a duplicate.
- A captured signed webhook request can no longer be replayed under a different (or no) delivery id: the
  signature itself is remembered per routine.
- Oversized webhook bodies are refused as they arrive instead of being buffered first, so a caller with a bad key
  cannot make the gateway allocate the whole request.
- A space-separated list of channels, handles or email addresses ("#ops #dev", "bob@acme.com alice@acme.com")
  is treated as a list and never gets *Always allow*, as the changelog already promised.
- The action log keeps query strings and fragments out of page addresses, and masks tokens, passwords and
  authorization headers in logged commands.

### Changed

- The bot image build gives apt 300 seconds per download and ten retries instead of the defaults, so
  fetching Chromium over a slow mirror no longer fails the build.
- CI runs on actions/checkout v7, actions/setup-node v7 and pnpm/action-setup v6, all on the Node 24 action runtime.

### Fixed

- A standing rule that differed only by case or trailing punctuation could be saved twice and then removed by
  neither route; saving now dedupes the way removal compares, and the panel reports an ambiguous match as such.
- Answering a question card twice at the same moment started two turns; the second now gets `409`.
- Web: a reply that arrived while two thread loads overlapped (switching away and straight back) could vanish
  until the next reconnect; a question card whose answer the gateway refused stayed on "Answered"; two timing-
  dependent tests.
- Web tests that failed now and then on a busy machine. The full-page App tests acted in the gap between the first
  render and the effects that run after it, before the live connection existed or while a "close the panel on a
  thread switch" effect was still queued; they now wait for both. A render test could also run past the 5-second
  limit when the CPU was saturated, and its unfinished typing then leaked into the next test; web tests now get 15
  seconds.

## [0.3.0] - 2026-10-22

Teammates you can leave work with: scoped standing approvals, presence on the roster, question cards, webhook
and watch routines, batch approvals, shared skills and an action log — most of it borrowed from Grok Bot, Meta
Muse and OpenAI dots — plus 40-step turns, Markdown replies and the security review that came with them.

### Security

- **GitHub can call a webhook routine without a key in the address.** Give GitHub the routine's address without
  `?key=` and its key as the webhook *Secret*; the gateway checks the `X-Hub-Signature-256` signature against
  the raw body. GitHub's setup `ping` is answered without waking anyone, a repeated delivery
  (`X-GitHub-Delivery`) runs only once, and form-encoded deliveries are read too. *For GitHub* in the computer
  panel copies the three settings.
- **A webhook payload can no longer step outside its fence.** The lines around it carry the payload's own
  SHA-256 fingerprint and every payload line starts with `│`, so a payload cannot write a closing line or pose
  as your operator.
- **Two long destinations can no longer share a rule.** Destinations used to be cut at 200 characters and
  lower-cased whole, so two webhook URLs with the same first 200 characters, or two URLs whose paths differ
  only in case, matched each other's rules. Now nothing is cut, URL paths keep their case, and a destination over
  200 characters always asks. A rule saved earlier for a URL with capital letters in its path asks once more.
- **Upgrades keep a way back.** Before the gateway upgrades an existing database's schema it writes a full copy
  next to it (`opengrokbot.db.v<old>-before-v<new>.<time>.bak`, the three most recent are kept). If the copy
  cannot be written it does not upgrade.

### Added

- **Watch routines.** "Keep an eye on the status page" creates a routine that only looks: each run gets
  read-only tools (pages, files, skills, a report, a question, a hold), with no shell, typing, clicking,
  handoffs or rule changes. A tool it was not given is refused even if the model asks for it. When nothing changed it
  replies "Nothing new." and the gateway posts nothing. What a watch run holds always waits for you; a
  standing rule never applies to it.
- **Batch holds.** When one action goes to many recipients or records, the teammate holds it once with one
  line per item. The chip lists them with checkboxes; untick any and approve the rest. The teammate is told
  exactly which items were approved and which were left out, never to add one, and to stop at the first
  failure. A batch never becomes a standing rule, and a bare 👍 approves all of it.
- **Shared skills.** Markdown playbooks in `<data>/skills/*.md` are listed, by name and one line, in every
  teammate's instructions; `read_skill` fetches one when the work calls for it. Only you write them — they live
  outside every bot's computer. The computer panel lists them.
- **Action log.** Every tool a teammate calls is recorded with what it acted on, whether it worked, how long it
  took and what started the turn (you, a routine, a watch, a webhook, an approval, a handoff, the group or your
  answer to a question), plus your approval decisions and every webhook call. Text typed into a page is never
  logged, only the field. The computer panel shows the latest 30, `GET /api/bots/:id/actions` serves more, and
  entries older than 90 days are dropped.
- **Standing approvals.** An approval chip for an email, message or post to one destination now has
  *Always allow…*: approve it and let that teammate send the same kind of thing to the same destination without
  asking, for 1 hour, 24 hours or until you revoke it. The next matching hold goes straight through, marked
  *Allowed by your rule*. Purchases, bookings and anything the bot does not classify always ask. The rules are
  listed, with a revoke button, under *Allowed without asking* in the computer panel. Only your own signed-in
  browser can create one; a bot cannot.
  - The destination has to be one place: one email address, one channel or handle, one account, page or thread.
    Wildcards, lists, "everyone" and a whole service such as "twitter" never get *Always allow*, and the chip
    says why.
  - A rule only lets a hold through in a turn you started: your message, your decision, your answer or your
    question to the group, with no webhook payload in view. Work started by a routine, a webhook or a teammate's
    handoff always asks, and the chip says which rule would have covered it.
  - The teammate is never told which destinations a rule covers, so something it reads cannot steer it to one.
- **Presence in the sidebar.** Each teammate's avatar shows whether it is working, waiting on you (an approval,
  a question or a sign-in), stuck (its last turn errored, ran out of budget or hit a turn limit) or done — it
  finished something while you were in another thread. A group row only shows that someone is working.
- **Question cards.** A teammate can ask you to choose between two to six options (`ask_operator`); you tap one,
  or tick several and submit, and it carries on. Open questions count in the sidebar badge and the tab title.
  Typing a reply instead closes the card.
- **Forgetting a rule.** Tell a teammate to drop a standing rule and it removes that line from `MEMORY.md`
  (`forget_memory`), with a red diff chip. The computer panel lists every standing rule with a remove button,
  which posts the same chip, so every change to a rule is still visible in the thread.
- **Webhook routines.** A routine can start when another system calls it, instead of — or as well as — on a
  schedule. Each one gets its own secret address (copy it from the computer panel); a `POST` with a body wakes
  the teammate with that body attached as outside data. The body is posted into the thread as an *outside data*
  card when the teammate picks it up, so you can see what set it off. The address works without the gateway
  token, and the key never enters the thread or the model's context.

- **Per-turn limits that fit real work.** A teammate can now take 40 model steps in one turn instead of 12
  (`OPENGROKBOT_MAX_STEPS`), and a turn is paused after 20 minutes (`OPENGROKBOT_TURN_MINUTES`, `0` turns it
  off; checked between steps). At either limit the teammate gets one last text-only call to say what it
  finished, what is left and what it needs — instead of a bare "stopped" line. Say "continue" to pick it up.
- **The computer panel opens at once.** While a sleeping computer wakes up (10–20 seconds) the panel shows what
  it is waiting for and for how long. If you move to another teammate meanwhile, the late answer no longer
  reopens the old panel.
- **Teammate replies render as Markdown**: tables, lists, code, quotes and links (which open in a new tab).
  Images are shown as a placeholder and never loaded, and raw HTML from the model is dropped. A single newline
  stays a line break, so a dispatch table keeps one item per line. What you type is still shown as typed.
- **Day dividers and time stamps** in every thread: a time on the first message of the day and after any pause
  longer than five minutes.
- **Versioned database schema.** The schema version lives in SQLite's `user_version` and migrations run on
  start, one step per transaction. A v0.2 database is adopted in place; one written by a newer gateway is
  refused with a clear message instead of being half-upgraded.
- **Dependency audit in CI** (`pnpm audit --audit-level high`) and Dependabot for npm, GitHub Actions and the
  bot image's base.

### Changed

- `hold_for_approval` takes a `kind` (email, message, post, purchase, booking, other) and an exact `target`.
  Holds from older prompts without them count as "other", so they always ask.
- The database schema moves to v2 and then v3 on start (approval kinds and targets, a rules table, routine webhook
  keys; routine modes, batch items, the action log).
- A teammate is marked *done* in the sidebar only when it said something while you were elsewhere, so a quiet
  watch run does not flag it.
- The live stream's `status` events carry `waiting` and `blocked` as well as `thinking` and `idle`.
- Node 22 is pinned: `engines` in the manifests and `.nvmrc`, which CI reads.
- Dependencies bumped within their existing ranges (hono 4.13.13, vite 8.3.5, vitest 4.1.12, playwright-core
  1.64.1, react 19.3.1 and their transitives). The audit against the public registry went from 24 advisories
  (6 high) to none.
- `pnpm test` runs the gateway and web suites one after the other instead of side by side.

### Fixed

- Three timing-dependent tests that failed intermittently on CI: the order of parallel group replies, queued
  messages being answered in one turn, and the panel closing on a thread switch.

## [0.2.1] - 2026-09-28

Lock down, cage and harden the self-built core.

### Security

- **Token sign-in.** The gateway listens on `127.0.0.1` by default and needs a token kept in the data dir
  (`0600`, never in a bot's workspace). The startup link sets an `HttpOnly`, `SameSite=Strict` cookie; scripts
  send a bearer token. State changes and the WebSocket must come from the gateway's own origin, and requests
  with a body must be JSON.
- **Caged computers.** All bot containers share one network with container-to-container traffic off, and get
  memory, CPU and process limits, `no-new-privileges` and an init process. Each container has its own secrets
  for the shell/file shim, the browser control port (CDP) and the VNC screen, because on Docker Desktop a
  container can still reach ports published on the host.
- **Screens are served by the gateway** from its own copy of noVNC; only the raw VNC stream comes from the
  bot's computer, so nothing a bot changes inside its container reaches your browser as a page.
- **Rules and evidence left the workspace.** `MEMORY.md` and screenshots moved out of the bind-mounted
  workspace (migrated once at startup), so a bot cannot rewrite its standing rules or its evidence.

### Added

- One turn at a time per teammate. Messages you send while it is busy show at once and are answered together
  next; a follow-up is the last thing the model reads.
- A stop button that ends the turn, including a shell command in flight (its whole process group is killed);
  no command runs longer than ten minutes.
- Routines run with the same tools as chat, never overlap, and can be paused, resumed, deleted or run now from
  the computer panel; teammates can `stop_routine`.
- LLM timeouts, retries with backoff and `Retry-After`, usage accounting and an optional per-teammate daily
  token budget (`OPENGROKBOT_DAILY_TOKENS`); optional vision (`OPENGROKBOT_VISION`).
- `AGENTS.md`, the operating manual with the hard boundaries, is part of the prompt. Role and emoji live in
  `SOUL.md` frontmatter; teammates with non-Latin names can be hired.
- Richer browser tools: press, scroll, back, the page's links, the newest tab, paged reading of long pages and
  files, head-and-tail shell output.
- A live activity card for each turn's computer steps, needs-you badges and a count in the tab title, a
  sign-in screen, an IME-safe composer, and catch-up after a reconnect.
- `pnpm build && pnpm start` serves the built UI, API, stream and screens on one port; launchd and systemd
  templates; security, always-on and multi-bot guides; CI.

### Fixed

- A failed first CDP connection no longer breaks a computer's browser for good; a restarted Chromium is
  reconnected and the container supervises its processes.
- Changing memory, CPU or timezone settings rebuilds the computers; containers are owned by label, so Docker
  Desktop's mount paths no longer trigger rebuilds, and a relative data dir works.
- The idle sweep and a new turn no longer race, and an open screen counts as use.
- Operator decisions no longer reach the model as empty user messages, which strict providers reject.

## [0.2.0] - 2026-08-13

The self-built core: OpenGrokBot stops being an OpenClaw distribution and gets its own gateway, web client and
one computer per teammate.

### Added

- A gateway (Hono, SQLite, WebSocket) and a web client: the sidebar as org chart, threads, the report chip.
- A Docker computer per teammate: Xvfb, headed Chromium driven over CDP, a VNC screen, a shell/file shim and a
  persistent workspace whose browser logins survive restarts.
- Computer tools — shell, files, browser — and screenshots posted into the thread as evidence.
- Draft-and-hold approvals with idempotent decisions and a bare 👍 to release; standing rules in `MEMORY.md`
  with a diff chip; routines from the conversation with cron in plain English.
- Group threads where members answer in parallel and the chief of staff closes with a dispatch table;
  allowlisted `message_bot` handoffs capped at two hops.
- Takeover login (`ask_for_login` and the computer panel) and hiring from the sidebar with a name and one line.
- Any OpenAI-compatible model, plus a scripted `stub` model that runs everything offline.
- The dark workbench skin.

### Changed

- The v0.1 OpenClaw setup moved to [docs/openclaw-recipe](docs/openclaw-recipe/README.md) as a reference.

## [0.1.0] - 2026-08-12

A self-hosted Grok Bot alternative assembled from OpenClaw: three preconfigured teammates (Scout, Sorter,
Ticker) with strict boundaries, agent-to-agent handoffs, any model provider, a one-command setup that never
overwrites an existing OpenClaw config, a Docker/VPS path and an honest comparison with Grok Bot.

[Unreleased]: https://github.com/wolfqing/OpenGrokBot/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/wolfqing/OpenGrokBot/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/wolfqing/OpenGrokBot/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/wolfqing/OpenGrokBot/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/wolfqing/OpenGrokBot/releases/tag/v0.1.0
