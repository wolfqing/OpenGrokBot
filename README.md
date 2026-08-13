# OpenGrokBot 🦞🤖

> Always-on AI teammates, each with **its own computer** — running on your hardware, with your credentials, under your roof.

[English](README.md) · [中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-blue?style=flat-square)](../../pulls)

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

A folder with a `SOUL.md`, a thread in the sidebar, and a container of its own:

![Architecture: your browser talks to one gateway process, which drives one Docker container per teammate — each with a headed Chromium, a noVNC screen you can take over, a shell/file shim, and a persistent workspace](assets/architecture.svg)

The bot's credentials live in **its** browser profile, in **its** container. The gateway never sees a password,
and neither does your config file.

## What it does today

Every line below is implemented and covered by tests — nothing here is a roadmap item.

**The management surface**

- **Sidebar as org chart.** One thread per teammate, plus group threads. Previews are completion states, so a
  glance down the list is a walk past everyone's desk.
- **One report grammar.** Work comes back as `✓ system → result · count` lines with a single closing sentence
  that surfaces only what needs you. Same shape from every teammate.
- **Draft-and-hold approvals.** Anything leaving the workspace stops at the door: the chip shows exactly what
  would go out, with Approve / Discard. A bare 👍 in the thread releases the newest one. Decisions are
  idempotent — a second click gets a 409, not a second send.
- **Visible memory.** "From now on, quiet accounts wait for my read" writes a rule into that bot's `MEMORY.md`
  and posts the diff as a chip. The rule is in its system prompt from the next turn on.
- **Routines from the conversation.** "Post a digest every day" registers a cron job, shows the schedule in
  plain English, survives restarts, and fires on time.

**The computer**

- `shell`, `read_file`, `write_file` inside the container.
- `browser_goto` / `browser_extract` / `browser_click` against a real headed Chromium — so login-walled sites
  work, which pure API/MCP setups cannot do.
- `browser_screenshot` posts what the bot saw into the thread as evidence.
- **Takeover login.** At a login wall the bot calls `ask_for_login` instead of asking for a password. You open
  its screen from the thread, sign in once in *its* browser, and the session persists in its profile — across
  container restarts.
- Containers start lazily, survive restarts, and publish their ports to `127.0.0.1` only.

**The crew**

- **Group threads.** Ask the room a question: each teammate answers for its own patch, then the chief of staff
  closes with a dispatch table — `✓ item → @bot · when` — and one line on what needs you today.
- **Allowlisted handoffs.** `message_bot` drops a scoped task into a teammate's thread and wakes it up. By
  default only the chief can reach everyone; peer-to-peer is off until you name the direction. Relays are
  capped at two hops so two bots cannot echo at each other.
- **Hire from the sidebar.** `+`, a name, one line of job description. No workflow editor, no tool checklist —
  the complexity accumulates in use, not in a setup form.

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

Then open http://localhost:5173.

Point it at a real model (anything OpenAI-compatible — xAI, Kimi, DeepSeek, a local Ollama):

```bash
OPENGROKBOT_API_KEY=sk-… OPENGROKBOT_MODEL=grok-4 pnpm dev
```

| Variable | Default | What it does |
|---|---|---|
| `OPENGROKBOT_API_BASE` | `https://api.x.ai/v1` | Any OpenAI-compatible endpoint |
| `OPENGROKBOT_API_KEY` | — | Your key. Never written to disk by this repo |
| `OPENGROKBOT_MODEL` | `grok-4` | `stub` runs offline with no key |
| `OPENGROKBOT_DATA` | `gateway/data` | SQLite, bot workspaces, screenshots |
| `OPENGROKBOT_A2A_ALLOW` | *(empty)* | Peer handoffs, e.g. `researcher>market-watch` |

In a slow-network region, build with a mirror: `docker build --build-arg APT_MIRROR=mirrors.aliyun.com …`

## Security is the point, not a footnote

The loudest objection to hosted always-on agents: an agent that never sleeps, holding all your credentials, on
someone else's infrastructure, exposed to prompt injection. The self-hosted answers:

- **Credentials never leave your machine.** They live in the bot's browser profile, inside its container.
- **The bot never asks for a password in chat.** It asks you to take over its screen instead.
- **Every bot is in a cage by default** — separate container, its own workspace, no access to your host.
- **Outward actions are held**, not sent, until you approve them.
- **Bot-to-bot messaging is off** until you allowlist a direction.
- **Screens bind to `127.0.0.1`.** The panel is for your machine; do not port-forward it.
- **Inbound messages are untrusted input.** Read [docs/security.md](docs/security.md) before exposing anything.

Give bots their own accounts rather than yours — separate email, separate calendar, invited only into what they
need. That is the right answer for hosted agents too; here it is enforceable.

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

## Roadmap

- [ ] **teach-mode** — record a browser demonstration, compile it into a reusable routine. The one Grok Bot
      feature with no open equivalent; design discussion in [#1](../../issues/1)
- [ ] Telegram as a notification / approval surface for when you are away from the desk
- [ ] One-command VPS image (cloud-init)
- [ ] Native app shell

## FAQ

**Relative to Grok Bot?** Same job — always-on teammates, their own computers, persistent memory, handoffs —
opposite custody model, and **zero shared code** (Grok Bot is closed-source; there is nothing to fork). It can
even run on the same brain: point it at the Grok API.

**Relative to OpenClaw?** v0.1 of this repo was a distribution on top of OpenClaw. v0.2 is its own core, because
a private computer per teammate pulls against OpenClaw's shared-host model. The old recipe is kept at
[docs/openclaw-recipe.md](docs/openclaw-recipe.md). Not an official OpenClaw project.

**Do I have to use Docker?** For the computers, yes. Everything else — threads, approvals, memory, routines,
group dispatch — runs without it; bots simply report that they have no computer attached.

More in [docs/faq.md](docs/faq.md) · [docs/multi-bot.md](docs/multi-bot.md) · [docs/comparison.md](docs/comparison.md)

## Disclaimer

Unofficial. Not affiliated with, endorsed by, or connected to xAI or the OpenClaw Foundation. "Grok" is a
trademark of xAI — the name is used here only to identify the product this stack is an alternative to.

## License

[MIT](LICENSE). Star it if it saved you $300/month. ⭐
