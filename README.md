# open-grok-bot 🦞🤖

> The self-hosted, open-source Grok Bot alternative — assembled in ~10 minutes from [OpenClaw](https://github.com/openclaw/openclaw) + any model you bring. Your bots, your hardware, your credentials.

[English](README.md) · [中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Built on OpenClaw](https://img.shields.io/badge/built%20on-OpenClaw-orange?style=flat-square)](https://github.com/openclaw/openclaw)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-blue?style=flat-square)](../../pulls)

When xAI launched Grok Bot, the top reply on Hacker News was: *"so like OpenClaw ???"*

Correct. This repo is the recipe that proves it.

## What Grok Bot sells vs. what this assembles

xAI's Grok Bot gives you always-on AI teammates, each with its own cloud computer — browser, filesystem, terminal — that message each other and keep memory across sessions. It costs **$120–300/month** (SuperGrok Heavy, Cursor Ultra / Teams Premium), enterprise access is waitlisted, and every bot runs on xAI's cloud **with your logins inside it**.

Everything in the left column below already exists as open source. This repo just wires it together:

| Grok Bot | open-grok-bot stack |
|---|---|
| Always-on teammate with its own cloud computer | OpenClaw Gateway daemon on **your** Mac, home server, or $5 VPS |
| Browser + filesystem + terminal per bot | OpenClaw tools; `latest-browser` Docker image ships Chromium |
| Named bots with persistent memory & files | Per-agent workspace + session store (`agents.entries`) |
| Bots message each other and hand off tasks | `tools.agentToAgent` — explicit allowlist, see [docs/multi-bot.md](docs/multi-bot.md) |
| Chat with your bots in a dedicated app | Chat in apps you already use: Telegram, WhatsApp, Slack, Discord, Signal, iMessage |
| Grok models only | **Any model**: Grok API itself, Claude, GPT, Kimi, DeepSeek, or a local model at $0 |
| Learns workflows by watching you | ❌ Not yet — the one real gap. See [Roadmap](#roadmap) |
| MCP / connectors | MCP + skills + plugins via [ClawHub](https://clawhub.ai) |
| $120–300/mo, waitlist, xAI's cloud | $0 software + your API usage, no waitlist, your hardware |

Honest note: Grok Bot's zero-setup polish, iOS app, and teach-by-demonstration are real advantages. If you're happy putting your accounts on xAI's cloud and paying for the convenience, buy it. This repo is for everyone who answered the HN thread's other top comment — *are you comfortable with that?* — with "no".

## Security is the point, not a footnote

The loudest objection to hosted always-on agents: an agent that never sleeps, holding **all your credentials**, on someone else's infrastructure, exposed to prompt injection.

The self-hosted posture:

- **Credentials never leave your machine.** No third-party cloud holds your sessions.
- **Give bots their own accounts**, not yours — separate email, separate calendar, invited into what they need. (This is also the correct answer for hosted agents; here it's enforceable.)
- **Pairing by default**: unknown senders must be approved (`openclaw pairing approve …`).
- **Sandboxing available**: run agents in containers (`OPENCLAW_SANDBOX=1`), and our bot templates ship with strict no-pay / no-send / draft-only boundaries.
- **Inbound messages are untrusted input.** Read [docs/security.md](docs/security.md) before exposing anything.

## Quickstart (local, ~10 minutes)

```bash
git clone https://github.com/wolfqing/open-grok-bot.git
cd open-grok-bot
./setup.sh
```

The script:

1. Installs OpenClaw via its official installer (skips if present)
2. Asks which model should power your bots — paste an xAI key for the poetic choice (`grok-4.5`), or Anthropic/OpenAI/local
3. Writes a config with **three ready-to-work teammates** (below) and agent-to-agent messaging enabled
4. Never overwrites an existing OpenClaw config — it generates a merge file instead

Then:

```bash
openclaw onboard --install-daemon   # first-time setup: verifies model access, installs the daemon
openclaw dashboard                  # opens the Control UI — say hi to your first teammate
```

Connect Telegram/WhatsApp/Slack in ~2 minutes each: [channel guides](https://docs.openclaw.ai/channels). Prefer a server? See [docker/](docker/).

## Your three starter teammates

Grok Bot's pitch is "teammates, not chatbots." Same here — these ship pre-configured, each with its own workspace, memory, and hard boundaries:

| Bot | Role | Boundaries baked in |
|---|---|---|
| **Scout** (`researcher`) | Turns a one-line question into a decision-ready brief with sources | Cites everything; says "I don't know" over guessing |
| **Sorter** (`inbox-keeper`) | Triages what you forward, drafts replies, daily digest | **Drafts only — never sends** |
| **Ticker** (`market-watch`) | Watches your list, morning/close digests, threshold alerts | Read-only; never trades; not financial advice |

They hand off to each other: ask Scout for research, and it can pass the pricing question to Ticker — over `agentToAgent`, on your machine, with an explicit allowlist. Demo transcript in [docs/multi-bot.md](docs/multi-bot.md).

Rename them, rewrite their souls (`SOUL.md`), add your own — they're just folders in [teammates/](teammates/).

## Cost math

| | Grok Bot | open-grok-bot |
|---|---|---|
| Software | $120–300/mo subscription | $0 (MIT all the way down) |
| Compute | included (xAI's cloud) | your existing Mac/mini PC, or ~$5/mo VPS |
| Model | included (Grok only) | your API key, any provider — or local = $0 |
| Waitlist | enterprise: yes | no |

A moderate-usage bot on `grok-4.5` API typically costs a few dollars a month. Three bots on a $5 VPS with a local fallback model: **~$5/mo total**.

## Architecture

![architecture](assets/architecture.svg)

One Gateway process, N isolated agents, your channels in front, your choice of model behind. Nothing phones home.

## Roadmap

- [ ] **teach-mode** — the one Grok Bot feature with no open equivalent: record a browser demonstration → compile it into a reusable OpenClaw skill. Design discussion in [#1](../../issues/1); contributions very welcome
- [ ] One-command VPS image (cloud-init)
- [ ] WeChat channel recipe for Chinese users
- [ ] Video walkthrough

## FAQ

**Is this a fork of Grok Bot?** No — Grok Bot is closed. This is a recipe that assembles existing open-source software into the same shape.

**Is this an official OpenClaw project?** No. All agent-runtime credit belongs to [OpenClaw](https://github.com/openclaw/openclaw) and its contributors; this repo is packaging, presets, and documentation on top. More in [docs/faq.md](docs/faq.md).

## Disclaimer

Unofficial. Not affiliated with, endorsed by, or connected to xAI or the OpenClaw Foundation. "Grok" is a trademark of xAI — the name is used here only to identify the product this stack is an alternative to.

## License

[MIT](LICENSE). Star it if it saved you $300/month. ⭐
