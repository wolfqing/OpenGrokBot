# Running it always-on

The point of a teammate is that it keeps working when you close the laptop. This page turns the dev setup into
a service: one process, one port, started at boot, reachable from your other machines through a tunnel.

## One process, one port

```bash
pnpm install
pnpm build                                   # web UI → web/dist, gateway → gateway/dist
docker build -t opensuperbot/bot:dev docker/bot   # only if the teammates use Docker computers
OPENSUPERBOT_API_KEY=sk-… pnpm start
```

`pnpm start` serves the built UI, the API, the live stream and every bot's screen on
**http://localhost:4747**. It prints a sign-in link once; open it in each browser you use.

## Start at boot

**macOS (a Mac mini is the sweet spot).** Edit the paths and key in
[`deploy/launchd/ai.opensuperbot.gateway.plist`](../deploy/launchd/ai.opensuperbot.gateway.plist), then:

```bash
cp deploy/launchd/ai.opensuperbot.gateway.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/ai.opensuperbot.gateway.plist
```

If the teammates use Docker computers, Docker Desktop has to come up with you: *Settings → General → Start Docker
Desktop when you sign in*. Local computers need no service — but a sign-in window can only appear in a desktop
session, so keep the gateway a LaunchAgent of the user you sign in as, not a LaunchDaemon.

**Linux.** Use [`deploy/systemd/opensuperbot.service`](../deploy/systemd/opensuperbot.service): run it as a user
in the `docker` group (for Docker computers; for local computers that user needs `bubblewrap` installed if commands
are to be allowed) and keep the key in `/etc/opensuperbot.env` (mode `600`).

```bash
sudo cp deploy/systemd/opensuperbot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now opensuperbot
```

On Ubuntu 23.10 and later, bubblewrap also needs the AppArmor profile in
[`deploy/linux/bwrap.apparmor`](../deploy/linux/bwrap.apparmor): those releases stop unprivileged programs from
creating the user namespace it sandboxes commands in, and the switch for commands refuses to turn on until the
sandbox passes its self-check. The profile allows that for `/usr/bin/bwrap` alone:

```bash
sudo cp deploy/linux/bwrap.apparmor /etc/apparmor.d/bwrap
sudo apparmor_parser -r /etc/apparmor.d/bwrap
```

A local teammate's sign-in window needs a desktop session. On a server with no display, give teammates Docker
computers, or run the gateway in a desktop session (a VNC or remote-desktop login) if you want local ones.

**Windows.** Build once (`pnpm install; pnpm build`), keep the key in a user environment variable, and register a
Task Scheduler task that starts the gateway when you sign in:

```powershell
setx OPENSUPERBOT_API_KEY "sk-…"
powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1
Start-ScheduledTask -TaskName 'OpenSuperBot gateway'
```

The task runs [`deploy/windows/start-gateway.ps1`](../deploy/windows/start-gateway.ps1) as you, in your session —
which is what lets a local teammate's sign-in window appear on your desktop — and restarts it if it stops. The log
is `%LOCALAPPDATA%\OpenSuperBot\gateway.log`. Remove it with `install-task.ps1 -Uninstall`. For Docker computers,
let Docker Desktop start when you sign in.

All the templates set `OPENSUPERBOT_QUIET_TOKEN=1`, so the token never lands in a log file. Sign in with the token
in `gateway/data/auth-token`: `http://localhost:4747/auth?token=<that token>`.

## Reaching it from another machine

The gateway listens on `127.0.0.1` only. Tunnel to it instead of opening a port:

```bash
ssh -N -L 4747:127.0.0.1:4747 you@your-mini
# then, on your laptop: http://localhost:4747/auth?token=<token>
```

Everything travels through that one port — including each bot's screen, so taking over a login works from the
laptop too. With Tailscale, `tailscale serve --bg 4747` gives you HTTPS on your tailnet; if the gateway refuses
the requests as cross-origin, add the tailnet address to `OPENSUPERBOT_ALLOWED_ORIGINS`.

## Webhooks from other systems

Ask a teammate for a routine that runs "whenever X happens" and it sets up a webhook routine. Copy its address
from the computer panel; it looks like `http://localhost:4747/hooks/routines/3?key=…`. Any `POST` to it wakes the
teammate with the request body attached as outside data:

```bash
curl -X POST -H 'Content-Type: application/json' -H 'X-OpenSuperBot-Key: <key>' \
  -d '{"issue": "Checkout returns 500 for EU cards"}' http://localhost:4747/hooks/routines/3
```

- The key can travel in the `X-OpenSuperBot-Key` header or as `?key=`. Prefer the header where the sender allows
  it: query strings tend to end up in proxy logs.
- **GitHub** cannot add headers, so it signs instead. In the repository's *Settings → Webhooks → Add webhook*,
  paste what *For GitHub* in the computer panel copies: the address **without** `?key=` as the payload URL,
  `application/json` as the content type, and the key as the secret. GitHub's first `ping` gets `200` and wakes
  no one; a redelivery of the same event runs only once.
- A call gets `202` once the routine is started, `404` for a wrong key, signature or id, `409` while the routine
  is paused or still busy with the last call (retry later), and `413` for a body over 1 MB.
- The gateway still listens on loopback only. For a service on the internet (GitHub, a form provider) to reach
  it, put a tunnel in front — Tailscale Funnel, Cloudflare Tunnel, ngrok — and, where the tunnel can, forward
  only paths under `/hooks/`. The rest of the gateway stays behind its token either way.

## How much machine

- Each **awake** bot runs a real Chromium: budget 300–500 MB of RAM. Containers are capped at
  `OPENSUPERBOT_BOT_MEMORY_MB` (2048) and `OPENSUPERBOT_BOT_CPUS` (2).
- A computer nobody used for `OPENSUPERBOT_IDLE_STOP_MINUTES` (60) is stopped and started again on demand, logins
  intact. Set it to `0` to keep every computer up.
- 8 GB comfortably runs four or five busy teammates.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `OPENSUPERBOT_API_BASE` | `https://api.x.ai/v1` | Any OpenAI-compatible endpoint |
| `OPENSUPERBOT_API_KEY` | — | Your key; never written to disk |
| `OPENSUPERBOT_MODEL` | `grok-4.7` | `stub` runs offline with no key |
| `OPENSUPERBOT_HOST` / `OPENSUPERBOT_PORT` | `127.0.0.1` / `4747` | Where the gateway listens |
| `OPENSUPERBOT_DATA` | `gateway/data` | SQLite, bot data, workspaces, the token |
| `OPENSUPERBOT_TOKEN` | *(generated)* | Pin the gateway token instead of generating one |
| `OPENSUPERBOT_QUIET_TOKEN` | *(off)* | Keep the token out of the startup log |
| `OPENSUPERBOT_ALLOWED_ORIGINS` | *(empty)* | Extra origins allowed to change state, comma-separated |
| `OPENSUPERBOT_WEB_URL` | *(the gateway)* | Where the UI lives, for the sign-in link (dev sets Vite's) |
| `OPENSUPERBOT_A2A_ALLOW` | *(empty)* | Peer handoffs, e.g. `researcher>market-watch` |
| `OPENSUPERBOT_DAILY_TOKENS` | `0` (off) | Per-bot daily token budget |
| `OPENSUPERBOT_LLM_TIMEOUT_MS` / `OPENSUPERBOT_LLM_RETRIES` | `120000` / `2` | Give up on a hung call; retry 429/5xx |
| `OPENSUPERBOT_MAX_STEPS` | `40` | Model steps one turn may take before the teammate pauses and says where it got to |
| `OPENSUPERBOT_TURN_MINUTES` | `20` | Pause a turn that has run this long (checked between steps); `0` never |
| `OPENSUPERBOT_VISION` | *(off)* | Show the model its own screenshots (vision models only) |
| `OPENSUPERBOT_IDLE_STOP_MINUTES` | `60` | Stop idle computers; `0` never |
| `OPENSUPERBOT_COMPUTERS` | `auto` | `docker`, `local`, or `auto`: Docker when the daemon answers and the bot image is built, else a local computer (see [local-computers.md](local-computers.md)) |
| `OPENSUPERBOT_BROWSER` | *(auto-detected)* | Browser executable for local computers; else Chrome, Edge, Chromium or Brave are looked for, then a Chrome for Testing is downloaded into `<data>/browsers` |
| `OPENSUPERBOT_BROWSER_MIRROR` | *(official)* | Download host for that browser; `https://cdn.npmmirror.com/binaries/playwright` works from China |
| `OPENSUPERBOT_BOT_MEMORY_MB` / `OPENSUPERBOT_BOT_CPUS` | `2048` / `2` | Per-computer limits (Docker computers only) |

## Upgrading

```bash
git pull && pnpm install && pnpm build
docker build -t opensuperbot/bot:dev docker/bot   # only if your teammates use Docker computers
# restart the service (launchctl kickstart -k gui/$(id -u)/ai.opensuperbot.gateway, or systemctl restart opensuperbot)
```

Computers built from an older image or container spec are rebuilt the next time they are used. Files and
browser logins live in the mounted workspace and survive; anything installed inside the container does not.

An upgrade that changes the database schema is one-way: an older gateway refuses the upgraded file. So before
it upgrades, the gateway writes a full copy next to the database, for example
`gateway/data/opensuperbot.db.v2-before-v3.20261022T083000Z.bak`, and logs where. To go back, stop the gateway,
check out the older release, and copy the `.bak` over `opensuperbot.db` (delete `opensuperbot.db-wal` and
`opensuperbot.db-shm` next to it first). The three most recent copies are kept.

### Coming from OpenGrokBot

The project was called OpenGrokBot until November 2026. Upgrading in place keeps everything working, and nothing
has to change on the day you upgrade:

- **Environment variables.** The `OPENGROKBOT_*` names still work. The gateway uses one whenever the matching
  `OPENSUPERBOT_*` name is not set (if both are, the new one wins), and at start-up it lists the old names it saw.
  Rename them when convenient.
- **Data.** The data directory does not move. An existing `opengrokbot.db` keeps its name and stays in use, so its
  backups are named `opengrokbot.db.….bak`.
- **Sign-in, webhooks, workflows.** Browsers stay signed in to the gateway. Webhooks that send `X-OpenGrokBot-Key`
  keep working, and workflows saved in the `opengrokbot.workflow` format load as before.
- **Docker computers.** The first time the gateway needs them, it removes the `opengrokbot-<id>` containers that
  belong to its data directory and creates `opensuperbot-<id>` ones in their place. Sign-ins and files live in the
  mounted workspace and carry over. An image you built as `opengrokbot/bot:dev` is tagged `opensuperbot/bot:dev`
  instead of asking you to rebuild. Containers from very old versions carry no owner label and are left alone; if
  `docker ps -a` still lists some, remove them with `docker rm -f $(docker ps -aq --filter label=ai.opengrokbot.bot)`.
- **Your clone.** GitHub forwards the old repository address, so `git pull` keeps working. To point it at the new
  one: `git remote set-url origin https://github.com/wolfqing/OpenSuperBot.git`.

Start-up services keep their old names until you swap them. Run either the old one or the new one, never both: they
would fight over port 4747.

- **macOS.** The old LaunchAgent keeps working. To switch, unload and delete it, then install
  `ai.opensuperbot.gateway.plist` as above:

  ```bash
  launchctl unload ~/Library/LaunchAgents/ai.opengrokbot.gateway.plist
  rm ~/Library/LaunchAgents/ai.opengrokbot.gateway.plist
  ```

- **Linux.** The old unit keeps working. To switch, run `sudo systemctl disable --now opengrokbot`, then install
  `opensuperbot.service` as above. Keep your own `User=` and `WorkingDirectory=`. The new unit reads
  `/etc/opensuperbot.env`, so move the key there from `/etc/opengrokbot.env`.
- **Windows.** Run `install-task.ps1` again. It stops and removes the old `OpenGrokBot gateway` task, then registers
  `OpenSuperBot gateway`. The log moves to `%LOCALAPPDATA%\OpenSuperBot\gateway.log`.

## Backups

Everything worth keeping is under `gateway/data/`: the SQLite database, each bot's `MEMORY.md` and screenshots
(`bots/`), workspaces and browser profiles (`workspaces/`), hired teammates (`teammates/`) and the token.
