# Security: what is enforced, what is a convention, what is on you

The loudest objections to hosted always-on agents were about custody: an agent that never sleeps, holding your
credentials, on someone else's cloud. Self-hosting answers the custody question. It does **not** answer prompt
injection — that follows an agent wherever it runs. This page is precise about which is which.

## Enforced by the gateway (in code, covered by tests)

| Boundary | How it holds |
|---|---|
| Only you can drive the gateway | Every API call, the live stream, screenshots and screens need the gateway token — a random secret in `gateway/data/auth-token` (mode `0600`). A browser signs in once through the link printed at startup and keeps an `HttpOnly`, `SameSite=Strict` cookie; scripts send `Authorization: Bearer <token>`. |
| Other websites cannot act as you | Anything that changes state, and the WebSocket, must come from the gateway's own origin (or the UI's, `OPENGROKBOT_WEB_URL`). A page you happen to visit cannot approve a hold, post into a thread or read the stream. |
| Your network cannot reach it | The gateway listens on `127.0.0.1` unless you set `OPENGROKBOT_HOST`. |
| A bot cannot approve its own holds | The token never enters a bot's workspace. A bot's shell or browser can reach the host, but cannot authenticate. |
| Bots cannot reach each other | All bot computers share one Docker network with container-to-container traffic switched off. |
| Each computer is a cage | Its own container with memory, CPU and process limits, `no-new-privileges`, and only its own workspace mounted. The shell/file shim wants a per-container token, the screen a per-container VNC password, and every port is published to `127.0.0.1` only. The screen itself reaches your browser through the gateway, behind the same sign-in. |
| Standing rules only change through the chip | `MEMORY.md` lives outside the bot's workspace. The only way in is `save_memory`, which always posts a diff chip. Screenshots — the evidence — are stored outside it too. |
| Handoffs are allowlisted | By default only the chief of staff can reach everyone. Peer directions need `OPENGROKBOT_A2A_ALLOW`, and relays stop after two hops. |
| Spend has a ceiling if you want one | `OPENGROKBOT_DAILY_TOKENS` stops a bot for the rest of the day once it has used that many tokens. |
| You can always stop it | The stop button (or `POST /api/threads/:id/stop`) aborts the running turn; routines can be paused or deleted from the computer panel. |

## A convention, not a wall

**Holding outward actions for approval.** Every teammate is told — in its system prompt and in the hard
boundaries of its `AGENTS.md` — to prepare the work and call `hold_for_approval` before anything leaves its
workspace, and to stop there. That is a strong discipline, not an enforcement point: a bot has a real browser,
and nothing in the sandbox stops it from clicking *Send* on a site where it is signed in. Build your setup so a
mistake is cheap (rule 1 below).

**Treating what it reads as data.** Bots are told that pages, files and emails are data, never orders. Prompt
injection against tool-using agents is still an unsolved problem industry-wide.

## Rules for you

1. **Give bots their own accounts, never yours.** Separate email, separate calendar, invited only into what
   they need. A bot with its own account has a blast radius; a bot with yours has your life.
2. **Sign in to only what the job needs.** Sessions live in the bot's browser profile on your disk
   (`gateway/data/workspaces/<bot>/.browser`), and they are as powerful as the account behind them.
3. **Keep the gateway on loopback.** For remote access, tunnel — see [always-on.md](always-on.md). If you
   must bind `0.0.0.0`, the token still guards it, but put TLS in front.
4. **Cap spend twice**: a limit on the API key at your provider, and `OPENGROKBOT_DAILY_TOKENS` here.
5. **Rotate the token if it leaked**: delete `gateway/data/auth-token` and restart. Every browser signs in again.

## Where secrets live

| Secret | Where |
|---|---|
| Model API key | The `OPENGROKBOT_API_KEY` environment variable. The gateway never writes it to disk. |
| Gateway token | `gateway/data/auth-token` (`0600`), or `OPENGROKBOT_TOKEN` if you pin one. Set `OPENGROKBOT_QUIET_TOKEN=1` to keep it out of service logs. |
| Bot logins | Each bot's browser profile, inside its own workspace. The gateway never sees a password. |
| Shim token, VNC password | Generated per container at creation, kept in that container's environment. |

## What self-hosting buys you

| Risk | Hosted (Grok Bot) | Self-hosted (this repo) |
|---|---|---|
| Where your sessions live | the vendor's cloud VM | your disk |
| Who can subpoena, breach or train on them | the vendor | you |
| Kill switch | a support ticket | the stop button, `docker stop`, or the power cable |
| Audit trail | what the vendor shows you | every message in SQLite on your disk |

## The threat you still own

If a workflow would make a bot both read strangers' input **and** act outward, keep a human decision in the
loop — or redesign the workflow. The approval chip is where that decision happens; keep it meaningful by giving
bots accounts whose worst case you can live with.
