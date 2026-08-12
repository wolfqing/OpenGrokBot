# FAQ

**What is OpenGrokBot's relationship to Grok Bot?**
Functional alternative, zero code relationship. Grok Bot is closed-source — there is nothing to fork and nothing here is derived from it. OpenGrokBot replicates the *job*: always-on named teammates with their own computer, persistent memory, and bot-to-bot handoffs — under the opposite custody model (your hardware, your credentials). Optionally the same model too, via the Grok API.

**And to OpenClaw?**
OpenGrokBot is a **distribution of OpenClaw**, the way Ubuntu is a distribution of the Linux kernel. The engine — gateway, channels, sessions, sandboxing — is OpenClaw (MIT, OpenClaw Foundation), which predates Grok Bot and is maintained by hundreds of contributors. OpenGrokBot contributes the product layer on top: the setup path, three pre-built teammates with strict security boundaries, multi-bot wiring, and honest Grok Bot feature/cost mapping. Not affiliated with the OpenClaw Foundation.

**Why build on an engine instead of writing a standalone runtime?**
Because the open incumbent already exists — the top HN reply to Grok Bot's launch was "so like OpenClaw ???". A from-scratch runtime would spend months re-implementing channels, session stores, and sandboxing that OpenClaw already hardened, and every thread would ask "why not just use OpenClaw?" As a distribution, OpenGrokBot *is* the answer to that question. Original code goes where the gap actually is: [teach-mode](../../issues/1).

**Can I use it without an xAI key?**
Yes — any provider OpenClaw supports: Anthropic, OpenAI, Kimi, DeepSeek, OpenRouter, or local models via Ollama (`$0/mo`, fully offline). Using the Grok API is just the poetic default.

**grok-4.5 or grok-4.6?**
The config defaults to `grok-4.5`. When 4.6 is generally available on the API, change one line in `~/.openclaw/openclaw.json` (`agents.defaults.model.primary`).

**Does it really match Grok Bot?**
Read [comparison.md](comparison.md) — including the "what Grok Bot genuinely does better" section. Short version: custody and model freedom, yes; teach-by-demonstration and app polish, no.

**I already run OpenClaw. Will setup.sh wreck my config?**
No — if `~/.openclaw/openclaw.json` exists, the script writes `generated/openclaw.grokbot.json5` and tells you how to merge. Your existing agents are untouched.

**Windows?**
WSL2. Native Windows works via OpenClaw's PowerShell installer, but this repo's script targets macOS/Linux/WSL2.

**How much RAM does a VPS need?**
2GB minimum if you build the Docker image (pnpm may be OOM-killed on 1GB). Prebuilt images run lighter.

**Is scraping / automating third-party sites with your bots okay?**
Your bots act under your accounts and your responsibility. Respect the ToS of the services you connect. The templates ship read-only / draft-only for a reason.

**Who's behind this?**
An independent solo builder. Not affiliated with xAI or the OpenClaw Foundation. Issues and PRs are the fastest way to reach me.
