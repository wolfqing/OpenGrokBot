# FAQ

**Is this a Grok Bot clone?**
No. It's a recipe. The agent runtime is [OpenClaw](https://github.com/openclaw/openclaw) (MIT, OpenClaw Foundation), which predates Grok Bot and does most of this out of the box. This repo contributes the assembly: a setup script, three pre-built teammates with sane security boundaries, multi-bot config, and honest documentation of what maps to what.

**So why does this repo deserve to exist?**
Because "you could assemble this from OpenClaw" and "here is the assembled thing" are different products. The HN thread said "so like OpenClaw ???" — this is the executable version of that comment.

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
