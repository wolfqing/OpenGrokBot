# Running it always-on

The point of a teammate is that it keeps working when you close the laptop. This page turns the dev setup into
a service: one process, one port, started at boot, reachable from your other machines through a tunnel.

## One process, one port

```bash
pnpm install
pnpm build                                   # web UI → web/dist, gateway → gateway/dist
docker build -t opengrokbot/bot:dev docker/bot
OPENGROKBOT_API_KEY=sk-… pnpm start
```

`pnpm start` serves the built UI, the API, the live stream and every bot's screen on
**http://localhost:4747**. It prints a sign-in link once; open it in each browser you use.

## Start at boot

**macOS (a Mac mini is the sweet spot).** Edit the paths and key in
[`deploy/launchd/ai.opengrokbot.gateway.plist`](../deploy/launchd/ai.opengrokbot.gateway.plist), then:

```bash
cp deploy/launchd/ai.opengrokbot.gateway.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/ai.opengrokbot.gateway.plist
```

Docker Desktop has to come up with you: *Settings → General → Start Docker Desktop when you sign in*.

**Linux.** Use [`deploy/systemd/opengrokbot.service`](../deploy/systemd/opengrokbot.service): run it as a user
in the `docker` group and keep the key in `/etc/opengrokbot.env` (mode `600`).

```bash
sudo cp deploy/systemd/opengrokbot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now opengrokbot
```

Both templates set `OPENGROKBOT_QUIET_TOKEN=1`, so the token never lands in a log file. Sign in with the token
in `gateway/data/auth-token`: `http://localhost:4747/auth?token=<that token>`.

## Reaching it from another machine

The gateway listens on `127.0.0.1` only. Tunnel to it instead of opening a port:

```bash
ssh -N -L 4747:127.0.0.1:4747 you@your-mini
# then, on your laptop: http://localhost:4747/auth?token=<token>
```

Everything travels through that one port — including each bot's screen, so taking over a login works from the
laptop too. With Tailscale, `tailscale serve --bg 4747` gives you HTTPS on your tailnet; if the gateway refuses
the requests as cross-origin, add the tailnet address to `OPENGROKBOT_ALLOWED_ORIGINS`.

## How much machine

- Each **awake** bot runs a real Chromium: budget 300–500 MB of RAM. Containers are capped at
  `OPENGROKBOT_BOT_MEMORY_MB` (2048) and `OPENGROKBOT_BOT_CPUS` (2).
- A computer nobody used for `OPENGROKBOT_IDLE_STOP_MINUTES` (60) is stopped and started again on demand, logins
  intact. Set it to `0` to keep every computer up.
- 8 GB comfortably runs four or five busy teammates.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `OPENGROKBOT_API_BASE` | `https://api.x.ai/v1` | Any OpenAI-compatible endpoint |
| `OPENGROKBOT_API_KEY` | — | Your key; never written to disk |
| `OPENGROKBOT_MODEL` | `grok-4` | `stub` runs offline with no key |
| `OPENGROKBOT_HOST` / `OPENGROKBOT_PORT` | `127.0.0.1` / `4747` | Where the gateway listens |
| `OPENGROKBOT_DATA` | `gateway/data` | SQLite, bot data, workspaces, the token |
| `OPENGROKBOT_TOKEN` | *(generated)* | Pin the gateway token instead of generating one |
| `OPENGROKBOT_QUIET_TOKEN` | *(off)* | Keep the token out of the startup log |
| `OPENGROKBOT_ALLOWED_ORIGINS` | *(empty)* | Extra origins allowed to change state, comma-separated |
| `OPENGROKBOT_WEB_URL` | *(the gateway)* | Where the UI lives, for the sign-in link (dev sets Vite's) |
| `OPENGROKBOT_A2A_ALLOW` | *(empty)* | Peer handoffs, e.g. `researcher>market-watch` |
| `OPENGROKBOT_DAILY_TOKENS` | `0` (off) | Per-bot daily token budget |
| `OPENGROKBOT_LLM_TIMEOUT_MS` / `OPENGROKBOT_LLM_RETRIES` | `120000` / `2` | Give up on a hung call; retry 429/5xx |
| `OPENGROKBOT_MAX_STEPS` | `40` | Model steps one turn may take before the teammate pauses and says where it got to |
| `OPENGROKBOT_TURN_MINUTES` | `20` | Pause a turn that has run this long (checked between steps); `0` never |
| `OPENGROKBOT_VISION` | *(off)* | Show the model its own screenshots (vision models only) |
| `OPENGROKBOT_IDLE_STOP_MINUTES` | `60` | Stop idle computers; `0` never |
| `OPENGROKBOT_BOT_MEMORY_MB` / `OPENGROKBOT_BOT_CPUS` | `2048` / `2` | Per-computer limits |

## Upgrading

```bash
git pull && pnpm install && pnpm build
docker build -t opengrokbot/bot:dev docker/bot
# restart the service (launchctl kickstart -k gui/$(id -u)/ai.opengrokbot.gateway, or systemctl restart opengrokbot)
```

Computers built from an older image or container spec are rebuilt the next time they are used. Files and
browser logins live in the mounted workspace and survive; anything installed inside the container does not.

## Backups

Everything worth keeping is under `gateway/data/`: the SQLite database, each bot's `MEMORY.md` and screenshots
(`bots/`), workspaces and browser profiles (`workspaces/`), hired teammates (`teammates/`) and the token.
