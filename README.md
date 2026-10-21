# OpenGrokBot 🦞🤖

> Always-on AI teammates, each with **its own computer** — running on your hardware, with your credentials, under your roof.

[English](README.md) · [中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-blue?style=flat-square)](../../pulls)

> 🖥️ **Also from this author: [Grok Desktop](https://github.com/wolfqing/GrokDesktop)** — a native macOS window
> for Grok Chat and the official `grok` CLI. Chat embeds grok.com; Build picks up your `~/.grok` sessions over ACP.

xAI's Grok Bot sells always-on teammates that each get a cloud computer — browser, filesystem, terminal — with
persistent memory, bot-to-bot handoffs, and an iMessage-shaped app to manage them. It costs **$120–300/month**,
and every bot runs on xAI's cloud **with your logins inside it**.

This is the same shape, self-hosted. One gateway process on your machine, one Docker container per bot, a dense
web client that reads like a workbench, and any OpenAI-compatible model behind it.

![A teammate's thread: it reports what it did, holds what would go out, and shows you what it saw](assets/screenshot-thread.png)

<table>
<tr>
<td width="50%"><img src="assets/screenshot-group.png" alt="A group thread: every teammate reports, the chief of staff closes with a dispatch table"></td>
<td width="50%"><img src="assets/screenshot-panel.png" alt="The computer panel: a teammate's live screen and the routines it runs"></td>
</tr>
<tr>
<td>Ask the room — everyone answers for their own patch, the chief of staff closes with <code>✓ item → @bot · when</code>.</td>
<td>Its computer: the live screen you can take over to sign in, and what it has scheduled.</td>
</tr>
</table>

## What a teammate actually is here

A folder with a `SOUL.md` (who it is) and an `AGENTS.md` (how it works, with its hard boundaries), a thread in
the sidebar, and a container of its own:

![Architecture: your browser talks to one gateway process, which drives one Docker container per teammate — each with a headed Chromium, a noVNC screen you can take over, a shell/file shim, and a persistent workspace](assets/architecture.svg)

The bot's credentials live in **its** browser profile, in **its** container. The gateway never sees a password,
and neither does your config file.

## What it does today

Every line below is implemented and covered by tests — nothing here is a roadmap item.

**The management surface**

- **Sidebar as org chart.** One thread per teammate, plus group threads. Previews are completion states, so a
  glance down the list is a walk past everyone's desk. An amber badge counts the approvals waiting on you, and
  the tab title carries the total.
- **One report grammar.** Work comes back as `✓ system → result · count` lines with a single closing sentence
  that surfaces only what needs you. Same shape from every teammate.
- **Draft-and-hold approvals.** Anything leaving the workspace stops at the door: the chip shows exactly what
  would go out, with Approve / Discard. A bare 👍 in the thread releases the newest one. Decisions are
  idempotent — a second click gets a 409, not a second send.
- **Visible memory.** "From now on, quiet accounts wait for my read" writes a rule into that bot's `MEMORY.md`
  and posts the diff as a chip. The file lives outside the bot's computer, so the chip is the only way a rule
  ever changes.
- **Routines from the conversation.** "Post a digest every day" registers a cron job, shows the schedule in
  plain English, survives restarts, and never runs twice at once. Pause it, run it now or delete it from the
  computer panel — or tell the bot to stop it.
- **See the work, stop the work.** Every step on its computer — the command, the page, the click — shows live
  in one card that folds away when the turn ends. A stop button ends the turn.
- **A budget, if you want one.** `OPENGROKBOT_DAILY_TOKENS` caps each teammate's model use per day; the panel
  shows today's count.

**The computer**

- `shell`, `read_file`, `write_file` inside the container; long files and pages come back in slices instead of
  being cut off.
- `browser_goto` / `browser_extract` (with the page's links) / `browser_click` / `browser_type` /
  `browser_press` / `browser_scroll` / `browser_back` against a real headed Chromium — so login-walled sites and
  forms work, which pure API/MCP setups cannot do. CJK and emoji fonts included.
- `browser_screenshot` posts what the bot saw into the thread as evidence — and, with `OPENGROKBOT_VISION=1`,
  shows it to a vision model too.
- **Takeover login.** At a login wall the bot calls `ask_for_login` instead of asking for a password. You open
  its screen from the thread, sign in once in *its* browser, and the session persists in its profile — across
  container restarts.
- Computers start on demand, stop after an hour without use, and come back with their logins. Each one is
  capped (memory, CPU, processes) and cannot reach any other bot's computer.

**The crew**

- **Group threads.** Ask the room a question: each teammate answers for its own patch — in parallel — then the
  chief of staff closes with a dispatch table — `✓ item → @bot · when` — and one line on what needs you today.
- **Allowlisted handoffs.** `message_bot` drops a scoped task into a teammate's thread and wakes it up. By
  default only the chief can reach everyone; peer-to-peer is off until you name the direction. Relays are
  capped at two hops so two bots cannot echo at each other.
- **Hire from the sidebar.** `+`, a name in any language, one line of job description. No workflow editor, no
  tool checklist — the complexity accumulates in use, not in a setup form.

## Quickstart

Needs Node 22+, pnpm, and Docker (for the bot computers).

```bash
git clone https://github.com/wolfqing/OpenGrokBot.git
cd OpenGrokBot
pnpm install
docker build -t opengrokbot/bot:dev docker/bot
```

Try it with no API key at all — a scripted stub model drives every path end to end:

```bash
OPENGROKBOT_MODEL=stub pnpm dev
```

The gateway prints a sign-in link — `http://localhost:5173/auth?token=…`. Open it once per browser; nothing
reaches the gateway without that token.

Point it at a real model (anything OpenAI-compatible — xAI, Kimi, DeepSeek, a local Ollama):

```bash
OPENGROKBOT_API_KEY=sk-… OPENGROKBOT_MODEL=grok-4 pnpm dev
```

To keep it running — one process, one port, started at boot, reachable through a tunnel — `pnpm build &&
pnpm start` and the launchd / systemd templates in [docs/always-on.md](docs/always-on.md).

| Variable | Default | What it does |
|---|---|---|
| `OPENGROKBOT_API_BASE` | `https://api.x.ai/v1` | Any OpenAI-compatible endpoint |
| `OPENGROKBOT_API_KEY` | — | Your key. Never written to disk by this repo |
| `OPENGROKBOT_MODEL` | `grok-4` | `stub` runs offline with no key |
| `OPENGROKBOT_DATA` | `gateway/data` | SQLite, bot data, workspaces, the gateway token |
| `OPENGROKBOT_A2A_ALLOW` | *(empty)* | Peer handoffs, e.g. `researcher>market-watch` |
| `OPENGROKBOT_DAILY_TOKENS` | `0` (off) | Per-teammate daily token budget |
| `OPENGROKBOT_VISION` | *(off)* | Show the model its own screenshots |

Every other setting — listen address, idle stop, per-computer limits, timeouts — is in
[docs/always-on.md](docs/always-on.md#configuration).

In a slow-network region, build with a mirror: `docker build --build-arg APT_MIRROR=mirrors.aliyun.com …`

## Security is the point, not a footnote

The loudest objection to hosted always-on agents: an agent that never sleeps, holding all your credentials, on
someone else's infrastructure, exposed to prompt injection. The self-hosted answers:

- **Credentials never leave your machine.** They live in the bot's browser profile, inside its workspace.
- **The bot never asks for a password in chat.** It asks you to take over its screen instead.
- **Nothing reaches the gateway without its token.** It listens on `127.0.0.1`, each browser signs in once, and
  only its own pages may change state. A website you visit cannot approve a hold — and neither can the bot.
- **Every bot is in its own cage** — a separate container with its own workspace and resource limits, and no
  route to any other bot's computer.
- **Rules change only through the memory chip.** A bot cannot quietly rewrite what you told it.
- **Outward actions are held for your approval.** That is an instruction every teammate follows, not a sandbox
  rule — so give bots their own accounts rather than yours.
- **Bot-to-bot messaging is off** until you allowlist a direction.

[docs/security.md](docs/security.md) lists exactly what is enforced, what is a convention, and what is still
on you.

## Cost

| | Grok Bot | OpenGrokBot |
|---|---|---|
| Software | $120–300/mo per seat | $0 (MIT all the way down) |
| Compute | included (xAI's cloud) | your Mac / mini PC / ~$5 VPS |
| Model | included (Grok only) | your key, any provider — or local at $0 |
| Your logins | on xAI's cloud | in a container on your machine |

Honest note: Grok Bot's zero-setup polish, iOS app, and teach-by-demonstration are real advantages. If you are
happy putting your accounts on xAI's cloud and paying for the convenience, buy it. This repo is for everyone who
answered *"are you comfortable with that?"* with **no**.

## Sister project: Grok Desktop

OpenGrokBot is for the work that happens while you are away. For the hours you spend in Grok yourself there is
**[Grok Desktop](https://github.com/wolfqing/GrokDesktop)**: a native SwiftUI window for macOS 14+ that embeds
grok.com for Chat and drives your local `grok` CLI for Build — sessions grouped by project, Markdown, plans,
diffs and live terminals in an inspector, Imagine without leaving the window. Free, community-built, not an
official xAI product. [Download the latest release](https://github.com/wolfqing/GrokDesktop/releases/latest).

## Roadmap

- [ ] **teach-mode** — record a browser demonstration, compile it into a reusable routine. The one Grok Bot
      feature with no open equivalent; design discussion in [#1](../../issues/1)
- [ ] Telegram as a notification / approval surface for when you are away from the desk
- [ ] **Computers without Docker** — a local mode (separate browser profile per teammate, sandboxed commands)
      plus a desktop app with a first-run wizard, so trying it needs no Docker, Node or terminal. Plan in
      [docs/local-computers.md](docs/local-computers.md)
- [ ] One-command VPS image (cloud-init)

## FAQ

**Relative to Grok Bot?** Same job — always-on teammates, their own computers, persistent memory, handoffs —
opposite custody model, and **zero shared code** (Grok Bot is closed-source; there is nothing to fork). It can
even run on the same brain: point it at the Grok API.

**Relative to OpenClaw?** v0.1 of this repo was a distribution on top of OpenClaw. v0.2 is its own core, because
a private computer per teammate pulls against OpenClaw's shared-host model. The old recipe is kept in
[docs/openclaw-recipe/](docs/openclaw-recipe/README.md). Not an official OpenClaw project.

**Do I have to use Docker?** For the computers, today yes — a Docker-free local mode is planned
([docs/local-computers.md](docs/local-computers.md)). Everything else — threads, approvals, memory, routines,
group dispatch — runs without it; bots simply report that they have no computer attached.

More in [docs/faq.md](docs/faq.md) · [docs/multi-bot.md](docs/multi-bot.md) · [docs/always-on.md](docs/always-on.md) ·
[docs/security.md](docs/security.md) · [docs/comparison.md](docs/comparison.md) · [CHANGELOG.md](CHANGELOG.md)

## Disclaimer

Unofficial. Not affiliated with, endorsed by, or connected to xAI or the OpenClaw Foundation. "Grok" is a
trademark of xAI — the name is used here only to identify the product this stack is an alternative to.

## License

[MIT](LICENSE). Star it if it saved you $300/month. ⭐
