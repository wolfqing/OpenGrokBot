# The OpenClaw recipe (v0.1, kept for reference)

OpenGrokBot v0.1 was a **distribution**: a config, three personas, and a setup script on top of
[OpenClaw](https://github.com/openclaw/openclaw). v0.2 replaced that with its own core — a gateway, a web
client, and one container per bot — because the two things this product is actually about (the management
surface and a private computer per teammate) are not things OpenClaw models: it runs a single assistant on a
shared host, inside chat apps you already use.

This folder keeps the old recipe for anyone who wants the distribution shape instead. **It is no longer the main
path**, and it is not what the rest of this repo builds. Everything v0.1 shipped lives here now:

| File | What it was |
|---|---|
| [`setup.sh`](setup.sh) | Installs OpenClaw and writes the three-teammate config |
| [`openclaw.example.json5`](openclaw.example.json5) | The annotated config `setup.sh` generates |
| [`multi-bot.md`](multi-bot.md) | Bindings and agent-to-agent on OpenClaw |
| [`docker-compose.yml`](docker-compose.yml) · [`vps.md`](vps.md) | The OpenClaw gateway on a VPS |

For the v0.2 equivalents see [../multi-bot.md](../multi-bot.md) and [../always-on.md](../always-on.md).

## What it did

`setup.sh` installed OpenClaw (skipping if present), asked which model should power your bots, and wrote a
config with three ready-to-work teammates plus agent-to-agent messaging enabled. It never overwrote an existing
OpenClaw config — it generated a merge file instead.

```bash
git clone https://github.com/wolfqing/OpenGrokBot.git
cd OpenGrokBot
docs/openclaw-recipe/setup.sh

openclaw onboard --install-daemon   # first-time setup
openclaw dashboard                  # Control UI
```

## The config it wrote

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

Channels were routed to bots with bindings:

```json5
{
  bindings: [
    { agentId: "researcher",   match: { channel: "telegram" } },
    { agentId: "inbox-keeper", match: { channel: "slack" } },
    // most-specific wins; first match breaks ties — order matters.
  ],
}
```

Two rules from upstream docs worth repeating:

- Never point two agents at the same `agentDir` — state collisions.
- Auth profiles don't auto-share between agents; static API keys are fine to copy.

## Why v0.2 stopped here

Three things the distribution could not give you, and v0.2 does:

- **A private computer per teammate.** OpenClaw's model is one assistant on a shared host. "Every bot gets its
  own computer" is pulling against that grain, not extending it.
- **The management surface.** Approval chips, visible memory events, routine chips, a screen panel — none of
  that exists in a chat app you already use, and Telegram's Bot API cannot express it (bots there cannot even
  see each other's messages).
- **Takeover login.** Signing in once, on the bot's own browser, so the session persists — that needs a browser
  the bot owns.

The personas in [`teammates/`](../../teammates/) survived the rewrite: they are just Markdown, and v0.2 reads
the same folders — `SOUL.md` as the persona, `AGENTS.md` as the operating manual with its hard boundaries.
