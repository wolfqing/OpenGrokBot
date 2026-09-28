# Multi-bot: the Grok Bot party trick, self-hosted

Grok Bot's headline demo is bots that message each other and hand off work. OpenClaw has the same primitive — it just ships disabled by default (correctly: agent-to-agent power is something you allowlist, not something you discover).

## How the pieces fit

```
Telegram ──┐                        ┌── researcher  (workspace-researcher)
Slack ─────┼──► Gateway ──bindings──┼── inbox-keeper (workspace-inbox-keeper)
WhatsApp ──┘        │               └── market-watch (workspace-market-watch)
                    └── tools.agentToAgent (explicit allowlist)
```

- **One Gateway process, N agents.** Each agent is a fully isolated persona: own workspace (`AGENTS.md`, `SOUL.md`, files), own session store, own memory. State lives at `~/.openclaw/agents/<agentId>/`.
- **Bindings** decide which channel/account/peer reaches which agent — most-specific match wins.
- **agentToAgent** lets allowlisted agents message each other and hand off tasks.

## The config (what setup.sh writes)

```json5
{
  agents: {
    defaults: {
      model: { primary: "xai/grok-4.5" },   // or anthropic/…, openai/…, local
    },
    entries: {
      researcher:     { default: true, workspace: "~/.openclaw/workspace-researcher" },
      "inbox-keeper": { workspace: "~/.openclaw/workspace-inbox-keeper" },
      "market-watch": { workspace: "~/.openclaw/workspace-market-watch" },
    },
  },
  tools: {
    agentToAgent: {
      enabled: true,
      allow: ["researcher", "inbox-keeper", "market-watch"],
    },
  },
}
```

Route channels to bots once connected:

```json5
{
  bindings: [
    // DM Scout on Telegram, Sorter lives in Slack:
    { agentId: "researcher",   match: { channel: "telegram" } },
    { agentId: "inbox-keeper", match: { channel: "slack" } },
    // most-specific wins; first match breaks ties — order matters.
  ],
}
```

## What a handoff looks like

> **You → Scout (Telegram):** worth switching our stack from Postgres to Turso? need a call by Friday
>
> **Scout:** On it. Restating: decision is migrate-or-stay for a ~40GB single-region app, deadline Friday. I'll brief architecture + ops; pricing deltas I'm handing to Ticker.
>
> *(Scout → Ticker over agentToAgent: "Price comparison needed: Turso scaler tiers vs. our current RDS bill shape, sources + dates. Findings land in workspace-researcher/memory/briefs/2026-08-12-turso.md.")*
>
> **Scout (later):** Brief ready — TL;DR: stay, revisit at multi-region. 5 sources, Ticker's cost table attached. Full brief in my memory, ask me to expand any section.

Every hop happened on your machine, between agents you allowlisted, with the audit trail in each agent's session store.

## Allowlisting agent-to-agent messaging

Agent-to-agent power is something you grant, not something a bot discovers. Two rules hold by default:

- A **chief of staff** agent may message anyone, and anyone may message it. Dispatch flows through one place you can read.
- **Peer-to-peer is off** until you name the direction:

  ```bash
  OPENGROKBOT_A2A_ALLOW='researcher>market-watch,market-watch>researcher'
  ```

  Each entry is one direction. `a>b` does not imply `b>a`.

A relay is capped at two hops, so a handoff can be picked up and answered but cannot echo between two bots. Refused
handoffs are reported back to the bot in plain words — it says it could not reach the teammate rather than pretending
it did.

## Adding a fourth teammate

1. `mkdir -p ~/.openclaw/workspace-editor && cp` your `AGENTS.md` / `SOUL.md` in (start from any folder in [`teammates/`](../teammates/))
2. Add an entry under `agents.entries`
3. Allowlist it **only if** it needs to talk to the others (see below)
4. Restart the gateway

## Merging into an existing config

Already run OpenClaw? `setup.sh` refuses to touch your config and writes `generated/openclaw.grokbot.json5` instead. Merge the three blocks (`models.providers.xai` if using Grok, `agents.entries`, `tools.agentToAgent`) into your `~/.openclaw/openclaw.json`. Two rules from upstream docs worth repeating:

- Never point two agents at the same `agentDir` — state collisions.
- Auth profiles don't auto-share between agents; static API keys are fine to copy.
