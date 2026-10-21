# Changelog

What changed, release by release. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/) while the project is pre-1.0, so a minor version can
still change behaviour.

## [Unreleased]

### Added

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

[Unreleased]: https://github.com/wolfqing/OpenGrokBot/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/wolfqing/OpenGrokBot/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/wolfqing/OpenGrokBot/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/wolfqing/OpenGrokBot/releases/tag/v0.1.0
