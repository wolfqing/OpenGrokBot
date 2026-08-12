# Grok Bot vs. open-grok-bot, honestly

Both columns verified on launch day (2026-08-11). Corrections welcome via PR — this table only works if it stays honest.

## Feature by feature

| Capability | Grok Bot | This stack | Notes |
|---|---|---|---|
| Always-on agents | ✅ xAI cloud VM each | ✅ OpenClaw Gateway daemon | Yours runs where you say: Mac mini, NAS, $5 VPS |
| Browser / filesystem / terminal | ✅ | ✅ | `latest-browser` image ships Chromium; tools run host-side or sandboxed |
| Named bots, persistent memory | ✅ | ✅ | Per-agent workspace + session store |
| Bots messaging each other | ✅ | ✅ | `tools.agentToAgent`, explicit allowlist |
| Shared computer between your bots | ✅ one user-scoped VM | ✅ one Gateway host | Same shape |
| Chat UX | Dedicated desktop + iOS app | Telegram/WhatsApp/Slack/Discord/Signal/iMessage/Google Chat + Control UI | Theirs is prettier; yours is already installed |
| Model choice | Grok only | Any: Grok API, Claude, GPT, Kimi, DeepSeek, Ollama local | BYOK everywhere |
| Learn-from-demonstration → routine | ✅ | ❌ roadmap | The one real gap. Skills can be written by hand today; recorder is our #1 issue |
| MCP / connectors | ✅ "where available" | ✅ MCP + skills + plugins (ClawHub) | Open ecosystem is deeper |
| Mobile | iOS app (Android later) | Any chat app you already carry | Different philosophy, same reach |
| Setup | Zero (their infra) | ~10 min local, ~20 min VPS | This is the price of custody |
| Access | $120–300/mo tiers; enterprise waitlist | Clone and go | — |
| Your credentials live | xAI's cloud | Your disk | The actual point |

## Cost, concretely

| Item | Grok Bot | open-grok-bot |
|---|---|---|
| Subscription | SuperGrok Heavy $300/mo, or Cursor Ultra / Teams Premium ($120–200/mo) | $0 |
| Compute | included | hardware you own, or ~$5/mo VPS (2GB RAM min for Docker builds) |
| Model usage | included | your API bill; moderate single-bot usage on grok-4.5 ≈ single-digit $/mo; local model = $0 |
| Realistic total | **$120–300/mo** | **$0–15/mo** |

## What Grok Bot genuinely does better

Zero-setup onboarding; managed, patched infrastructure; a polished dedicated app; teach-by-demonstration; first-party Grok 4.6 integration the day it ships; one throat to choke when something breaks. If those are worth $120–300/month to you and you're comfortable with the custody trade, it's a good product. This repo exists for everyone who isn't.
