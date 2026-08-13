# FAQ

**What is OpenGrokBot's relationship to Grok Bot?**
Functional alternative, zero code relationship. Grok Bot is closed-source — there is nothing to fork and nothing here is derived from it. OpenGrokBot replicates the *job*: always-on named teammates with their own computer, persistent memory, and bot-to-bot handoffs — under the opposite custody model (your hardware, your credentials). Optionally the same model too, via the Grok API.

**And to OpenClaw?**
v0.1 of this repo was a **distribution of OpenClaw**. v0.2 is its own core — gateway, web client, one container per bot — because the two things this product is about (the management surface and a private computer per teammate) pull against OpenClaw's model of one assistant on a shared host, inside chat apps you already use. The v0.1 recipe is kept at [openclaw-recipe.md](openclaw-recipe.md). Not affiliated with the OpenClaw Foundation.

**Why write a runtime instead of staying a distribution?**
Because the distribution could not give you a private computer per teammate, approval/memory/routine chips, or takeover login — and those *are* the product. Everything cheap to reuse was still reused: the personas in `teammates/` are plain Markdown and survived the rewrite unchanged.

**Can I use it without an xAI key?**
Yes — anything OpenAI-compatible: Anthropic-compatible gateways, OpenAI, Kimi, DeepSeek, OpenRouter, or a local model via Ollama (`$0/mo`, fully offline). Set `OPENGROKBOT_API_BASE` and `OPENGROKBOT_MODEL`. Using the Grok API is just the poetic default. `OPENGROKBOT_MODEL=stub` runs the whole product offline with no key at all.

**Which Grok model?**
`OPENGROKBOT_MODEL` defaults to `grok-4`. Switching models is one environment variable — no config file to edit.

**Does it really match Grok Bot?**
Read [comparison.md](comparison.md) — including the "what Grok Bot genuinely does better" section. Short version: custody and model freedom, yes; teach-by-demonstration and app polish, no.

**I already run OpenClaw. Does this touch it?**
No. v0.2 runs its own gateway and its own containers, and never reads or writes an OpenClaw config. If you want the old v0.1 distribution path instead, it is at [openclaw-recipe.md](openclaw-recipe.md) — and `setup.sh` still refuses to overwrite an existing config, writing a merge file instead.

**Windows?**
WSL2, with Docker Desktop's WSL2 backend for the bot computers.

**How much RAM does a VPS need?**
2GB minimum. Each bot's container runs a real Chromium, so budget roughly 300–500MB per teammate that is actually awake; containers start lazily, so idle teammates cost nothing.

**Is scraping / automating third-party sites with your bots okay?**
Your bots act under your accounts and your responsibility. Respect the ToS of the services you connect. The templates ship read-only / draft-only for a reason.

**Who's behind this?**
An independent solo builder. Not affiliated with xAI or the OpenClaw Foundation. Issues and PRs are the fastest way to reach me.
