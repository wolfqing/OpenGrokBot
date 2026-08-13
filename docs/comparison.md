# Grok Bot vs. OpenGrokBot, honestly

Grok Bot column verified on launch day (2026-08-11); this column reflects v0.2 (the self-built core).
Corrections welcome via PR — this table only works if it stays honest.

## Feature by feature

| Capability | Grok Bot | This stack | Notes |
|---|---|---|---|
| Always-on teammates | ✅ xAI cloud VM each | ✅ one Docker container each | Yours runs where you say: Mac mini, NAS, $5 VPS |
| A computer per bot | ✅ | ✅ | Headed Chromium on Xvfb + shell + files, per container |
| Watch its screen / take over | ✅ | ✅ | noVNC panel from the thread; bound to `127.0.0.1` |
| Login-walled sites | ✅ | ✅ | Sign in once in the bot's browser; the session persists in its profile |
| Named bots, persistent memory | ✅ | ✅ | Per-bot workspace; rules land in its `MEMORY.md` and show as a chip |
| Approval gate on outward actions | ✅ Send / Discard | ✅ Approve / Discard, or a bare 👍 | Idempotent: a second decision is refused |
| Routines from the conversation | ✅ | ✅ | Cron registered, described in plain English, reloaded on restart |
| Bots messaging each other | ✅ | ✅ | `message_bot`, allowlisted per direction, capped at two hops |
| Group threads + dispatch | ✅ | ✅ | Members report, chief of staff closes with `✓ item → @bot · when` |
| Chat UX | Dedicated desktop + iOS app | Local web client (iMessage-shaped) | Theirs is prettier and shipped on mobile |
| Model choice | Grok only | Any OpenAI-compatible: Grok, Kimi, DeepSeek, local | BYOK everywhere; `stub` runs with no key |
| Learn-from-demonstration → routine | ✅ | ❌ roadmap | The one real gap; routines can be written by hand today |
| Mobile | iOS app (Android later) | ❌ not yet | Telegram as a notification/approval surface is on the roadmap |
| Setup | Zero (their infra) | `pnpm install` + one `docker build` | This is the price of custody |
| Access | $120–300/mo tiers; enterprise waitlist | Clone and go | — |
| Your credentials live | xAI's cloud | Your disk | The actual point |

## Cost, concretely

| Item | Grok Bot | OpenGrokBot |
|---|---|---|
| Subscription | SuperGrok Heavy $300/mo, or Cursor Ultra / Teams Premium ($120–200/mo) | $0 |
| Compute | included | hardware you own, or ~$5/mo VPS (2GB RAM min for Docker builds) |
| Model usage | included | your API bill; moderate single-bot usage on grok-4.5 ≈ single-digit $/mo; local model = $0 |
| Realistic total | **$120–300/mo** | **$0–15/mo** |

## What Grok Bot genuinely does better

Zero-setup onboarding; managed, patched infrastructure; a polished dedicated app; teach-by-demonstration; first-party Grok 4.6 integration the day it ships; one throat to choke when something breaks. If those are worth $120–300/month to you and you're comfortable with the custody trade, it's a good product. This repo exists for everyone who isn't.
