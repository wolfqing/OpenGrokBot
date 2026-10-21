# Grok Bot vs. OpenGrokBot, honestly

The Grok Bot column was checked on 2026-10-21 against xAI's own pages: the [Grok Bot changelog](https://x.ai/changelog/bot)
up to v0.71.2 (2026-10-14), [Introducing Grok Bot](https://x.ai/news/introducing-grok-bot),
[Designing Grok Bot](https://x.ai/news/designing-grok-bot) and [Team Bots](https://x.ai/news/team-bots). Grok Bot
ships almost daily, so this table ages fast. Corrections welcome via PR — it only works if it stays honest.

## Feature by feature

| Capability | Grok Bot | This stack | Notes |
|---|---|---|---|
| Always-on teammates | ✅ on xAI's cloud | ✅ one Docker container each | Yours runs where you say: Mac mini, NAS, $5 VPS |
| Whose computer | A cloud computer per member; xAI's wording says a member's bots share it | A separate container per teammate | Separate desks mean separate blast radii: one teammate's browser, files and logins are out of another's reach |
| Watch its screen / take over | ✅ status, side preview, full-screen takeover | ✅ noVNC panel from the thread | |
| Signing in | Secure Form fills logins from chat; 1Password on Mac; takeover as fallback | Takeover only: you sign in on its screen | Theirs is smoother; ours never lets a password pass through the gateway |
| Work on your own machine | ✅ "Your computer" in the desktop app; web traffic can leave through your desktop | ❌ | A Docker-free local mode is planned ([local-computers.md](local-computers.md)) |
| Named bots, persistent memory | ✅ | ✅ | Rules live in `MEMORY.md` outside the bot's computer; every change is a diff chip |
| Forget a rule | ✅ | ✅ `forget_memory`, or remove it in the panel | |
| Approval gate on outward actions | ✅ draft cards, Auto-review by a separate model | ✅ Approve / Discard, or a bare 👍 | Ours is held by instruction, not a sandbox — see [security.md](security.md) |
| Standing approvals | ✅ Custom Rules: Always allow / Ask first | ✅ *Always allow…* per teammate, kind and exact destination, for 1 h, 24 h or until revoked | Money and bookings always ask here |
| Question cards | ✅ single and multi-select | ✅ `ask_operator`, single and multi-select | |
| Presence on the roster | ✅ animated avatars: idle, thinking, working, waiting, blocked, done | ✅ status dot and label: working, needs you, stuck, done | |
| Routines on a schedule | ✅ | ✅ | Cron in plain English, survives restarts, never runs twice at once |
| Routines on events | ✅ webhooks, GitHub, Slack, Linear, a bot's own inbox | ✅ webhooks | Point GitHub or anything else at the routine's address |
| Look-only routines | Not a separate mode in the changelog | ✅ watch routines: read-only tools, silent unless something needs you | The shape of dots' "proactive research" |
| Batch approvals | Shown in xAI's IncidentSweep write-up: review the batch, then it sends | ✅ one chip per batch; untick items, the bot does exactly the rest | A batch never becomes a standing rule |
| Shared skills | ✅ account-level skills from plugins | ✅ Markdown playbooks in `<data>/skills/` | Only you write them |
| Action log | Audit logs and action recording for Enterprise teams | ✅ every tool call, decision and webhook call, per teammate, 90 days | Typed text is never logged |
| See and stop the work | ✅ | ✅ | Each computer step shows live; a stop button ends the turn |
| Spend control | Included usage, then an on-demand limit you set | ✅ per-bot daily token budget | Plus whatever cap you set on the API key |
| Bots messaging each other | ✅; Team admins can switch it off | ✅ off by default, allowlisted per direction, two hops max | |
| Group threads + dispatch | ✅ up to six bots per group | ✅ members report, the chief of staff closes with `✓ item → @bot · when` | |
| A bot that offers work unasked | ✅ the primary Bot | Partly: a watch routine speaks up when it finds something | Nothing here goes looking for work on its own |
| Its own email address | ✅ with `name+tag@` routing to routines | ❌ | |
| Learn a routine by watching you | ✅ "follow along" | ❌ roadmap | The one big gap; routines are written in words today |
| Shared team bots, Slack | ✅ Team Bots, Slack threads, per-person memory | ❌ | This stack is built for one operator |
| Connectors | Marketplace of plugins (GitHub, Gmail, Outlook, Notion, Figma, QuickBooks, Stripe…) | The browser and the shell | Anything with a website works here, but nothing is pre-wired |
| Voice | ✅ voice chat and calls | ❌ | |
| Apps | macOS, Windows and Linux desktop; iOS | A web client in your browser, reachable from other machines through a tunnel | Not tuned for phones yet |
| Model choice | Grok only | Any OpenAI-compatible: Grok, Kimi, DeepSeek, local | `stub` runs with no key |
| Setup | Zero (their infra) | `pnpm install` + one `docker build` | This is the price of custody |
| Your credentials live | xAI's cloud | Your disk | The actual point |

## The other two: Meta Muse and OpenAI dots

Two more always-on agents launched in September 2026. Both are personal assistants first, not crews.

| | Meta Muse (Sep 8) | OpenAI dots (Sep 29) |
|---|---|---|
| Shape | One agent per person; subagents inside | One primary dot per person; teams of dots promised |
| Computer | A dedicated VM per person, agent and data inside | A cloud computer and browser per dot; your own laptop optional, off by default |
| Guardrails | *Sentinel*, a separate agent, is the only authority over connector actions and network egress; the agent sees only surrogate tokens | *Auto-review* outside the dot's environment checks risky steps; Custom Rules: act, act if pre-approved, ask, or hand off |
| While you are away | Proactive suggestions | Read-only "proactive research" that writes private notes, enforced in code |
| Where you talk to it | Muse app, web, WhatsApp | ChatGPT, Slack, Teams, voice |
| Model | Meta's own only | OpenAI's own only |
| Price | Free tier, then paid tiers | First dot included in Pro and Business Premium |

What we took from them: standing approvals with a fixed scope and an expiry (all three have a form of it),
presence on the roster (Grok Bot), question cards (Grok Bot), forgetting a single rule (Muse has it; dots can only
reset everything), webhook routines (Grok Bot); then look-only watch routines (dots' proactive research), batch
approvals with per-item control (xAI's IncidentSweep), shared skills (Grok Bot) and a per-teammate action log
(Grok Bot's enterprise audit trail, brought down to one operator). What we did not take: card wallets and
shopping, team-shared bots, voice. They fit a hosted product for many people; this one is for a single operator
who wants custody.

What they do better and we should learn from next: Muse's egress control — every network request from the agent
passes one gate that the agent cannot switch off — is a real wall where ours is a rule in the prompt. A per-teammate
egress allowlist is the closest thing a self-hosted stack can build, and it would make watch routines safer still:
today they cannot act, but they can still load any page.

## Cost, concretely

| Item | Grok Bot | OpenGrokBot |
|---|---|---|
| Subscription | Comes with SuperGrok and Cursor plans from Pro up, with its own usage meter; past the included usage you upgrade or set an on-demand limit | $0 |
| Compute | included | hardware you own, or a ~$5/mo VPS (2GB RAM min for Docker builds) |
| Model usage | included up to the plan's allowance | your API bill; moderate single-bot usage on grok-4.5 ≈ single-digit $/mo; local model = $0 |

## What Grok Bot genuinely does better

Zero-setup onboarding; managed, patched infrastructure; polished desktop and phone apps with voice; sign-in
from a form instead of a takeover; a marketplace of connectors; a primary bot that finds work for you;
teach-by-demonstration; Team Bots in Slack; first-party Grok models the day they ship; one throat to choke when
something breaks. If those are worth it to you and you're comfortable with the custody trade, it's a good
product. This repo exists for everyone who isn't.
