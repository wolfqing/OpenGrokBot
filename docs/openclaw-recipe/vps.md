# Running the OpenClaw recipe on a VPS (v0.1)

> This is the v0.1 OpenClaw path. To run v0.2 (the self-built core) always-on — Mac mini, Linux box or VPS —
> see [../always-on.md](../always-on.md).

Grok Bot's pitch is a bot that keeps working while you sleep. A $5 VPS does that too — and it's yours.

## 1. Get a box

Any provider, 2GB RAM minimum (image builds can OOM below that), Ubuntu 22.04+. Hetzner/Racknerd/DigitalOcean basic tiers all fit.

## 2. Install Docker & clone

```bash
curl -fsSL https://get.docker.com | sh
git clone https://github.com/wolfqing/OpenGrokBot.git
cd OpenGrokBot/docs/openclaw-recipe
```

## 3. Start the gateway

```bash
docker compose up -d
docker compose exec openclaw-gateway openclaw onboard   # first-time: model key, daemon config
```

## 4. Install the teammates

```bash
cd ../..
OPENCLAW_CONFIG_DIR=./docs/openclaw-recipe/data/config docs/openclaw-recipe/setup.sh
docker compose -f docs/openclaw-recipe/docker-compose.yml restart
```

## 5. Connect a channel

Telegram is the easiest on a headless box (bot token, no QR): [channel guides](https://docs.openclaw.ai/channels). WhatsApp needs a one-time QR pairing — do it via the Control UI over an SSH tunnel:

```bash
ssh -L 18789:127.0.0.1:18789 user@your-vps
# then open http://127.0.0.1:18789 locally
```

## Security on a public box

- Keep 18789 bound to localhost (the compose file already does). Remote access = SSH tunnel or Tailscale, never a raw port-forward.
- `OPENCLAW_SANDBOX=1` is on in our compose file — leave it on.
- Read the upstream [security guide](https://docs.openclaw.ai/gateway/security) before pointing any real accounts at it.

## When this file and official docs disagree

The official Docker guide (docs.openclaw.ai/install/docker, with its `scripts/docker/setup.sh`) is upstream truth; this compose file is a convenience following the same volume layout, verified against the docs on 2026-08-11. If upstream moved, trust upstream and open an issue here so we can catch up.
