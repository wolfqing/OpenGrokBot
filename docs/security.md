# Security: what is enforced, what is a convention, what is on you

The loudest objections to hosted always-on agents were about custody: an agent that never sleeps, holding your
credentials, on someone else's cloud. Self-hosting answers the custody question. It does **not** answer prompt
injection — that follows an agent wherever it runs. This page is precise about which is which.

## Enforced by the gateway (in code, covered by tests)

| Boundary | How it holds |
|---|---|
| Only you can drive the gateway | Every API call, the live stream, screenshots and screens need the gateway token — a random secret in `gateway/data/auth-token` (mode `0600`). A browser signs in once through the link printed at startup and keeps an `HttpOnly`, `SameSite=Strict` cookie; scripts send `Authorization: Bearer <token>`. |
| Other websites cannot act as you | Anything that changes state, and the WebSocket, must come from the gateway's own origin (or the UI's, `OPENGROKBOT_WEB_URL`), and requests with a body must be JSON — which no other page can send without a preflight the gateway never answers. A page you happen to visit cannot approve a hold, post into a thread or read the stream. |
| Your network cannot reach it | The gateway listens on `127.0.0.1` unless you set `OPENGROKBOT_HOST`. |
| A bot cannot approve its own holds | The token never enters a bot's workspace. A bot's shell or browser can reach the host, but cannot authenticate. |
| Only you can grant a standing approval | A rule is created only when you approve a hold with *Always allow…* from your signed-in browser. Its scope is fixed by the gateway: one teammate, one kind, one exact destination, with an expiry you pick. The destination must have the shape of one place — one email address, one channel or handle, one account, page or thread; wildcards, lists, "everyone" and whole services are refused, and so is anything over 200 characters. Destinations are compared whole: case is ignored except in a URL's path. Purchases, bookings and "other" can never become rules. Bots have no tool to create, widen or extend one; you revoke them from the computer panel. |
| Rules only cover work you started | A rule lets a hold through only in a turn you started — your message, your decision, your answer, your question to the group — and only while no webhook payload is in the teammate's view. Turns started by a routine, a webhook or a teammate's handoff always ask, and the chip says why. The model is never told which destinations a rule covers. What this does not cover: a page the teammate reads during a turn you started is still in front of it, and so is your own earlier message that named a destination — a convincing page could still steer a hold to a destination you once allowed. Keep standing rules for destinations where a wrong send is cheap. |
| A webhook opens one routine and nothing else | `POST /hooks/routines/:id` is the only path outside the token. Each routine has its own random key: sent as a header or `?key=`, or used by GitHub as the secret behind an `X-Hub-Signature-256` signature over the exact body. Both are compared in constant time; a wrong key, a wrong signature and an unknown id all get `404`. A repeated GitHub delivery runs once, and so does a captured signed request replayed under a different delivery id (the signature itself is remembered); a delivery refused because the last run was still going is not counted, so GitHub's redelivery of it runs. Bodies over 1 MB are refused as they arrive, before they are buffered, and at most 16,000 characters reach the model. The body is posted into the thread as an *outside data* card when the teammate picks it up, so you can see what set it off. The key never enters the thread or the model's context — only the computer panel shows it. |
| A payload stays inside its fence | What a webhook delivered reaches the model between two lines that carry the payload's own SHA-256 fingerprint, with every payload line prefixed by `│`. Writing a convincing end-of-payload line from inside would mean finding a text that contains its own hash. |
| An upgrade keeps a way back | Before a schema upgrade the gateway writes a complete copy of the database next to it and keeps the three most recent. It refuses to upgrade if the copy fails. |
| Bots cannot reach each other | All bot computers share one Docker network with container-to-container traffic switched off. And because on Docker Desktop a container can still reach ports published on the host, everything a computer publishes wants that computer's own secret: its shell/file shim and its browser control port (CDP) a per-container token, its screen a per-container VNC password. |
| Each computer is a cage | Its own container with memory, CPU and process limits, `no-new-privileges`, and only its own workspace mounted. Every port is published to `127.0.0.1` only. |
| A bot cannot put code in front of you | The screen page and its noVNC code are served by the gateway from its own copy; only the raw VNC stream comes from the bot's computer. Nothing a bot changes inside its container reaches your browser as a page. |
| Standing rules only change through the chip | `MEMORY.md` lives outside the bot's workspace. The only ways to change it are `save_memory`, `forget_memory` and the remove button in the computer panel, and each of them posts a diff chip; a `MEMORY.md` a bot writes into its own workspace is ignored. Screenshots — the evidence — are stored outside it too. |
| Handoffs are allowlisted | By default only the chief of staff can reach everyone. Peer directions need `OPENGROKBOT_A2A_ALLOW`, and relays stop after two hops. |
| A watch routine cannot act | Its turns are offered only read-only tools, and any other tool the model names is refused by the gateway: no shell, no writing files, no clicking, typing or key presses in the browser, no handoffs, no changes to rules or routines. What it holds never matches a standing rule. It can still load pages, so it can still be steered by what it reads; it just has nothing to act with. |
| A batch is approved item by item | The gateway stores the exact items a bot held and the ones you left ticked; the bot is told that subset and nothing else. A batch can never become a standing rule. |
| Shared skills are yours | Skills live in `<data>/skills`, outside every bot's computer; bots read them through `read_skill`, which only accepts a name from the list. |
| There is a record | Every tool call, approval decision and webhook call lands in the action log in SQLite, with what started the turn. Text typed into a page is not logged. Entries older than 90 days are dropped. |
| Spend has a ceiling if you want one | `OPENGROKBOT_DAILY_TOKENS` stops a bot for the rest of the day once it has used that many tokens. |
| You can always stop it | The stop button (or `POST /api/threads/:id/stop`) aborts the running turn — including a shell command in flight, which is killed in the container. No single command runs longer than ten minutes, and a turn pauses after 40 model steps or 20 minutes (`OPENGROKBOT_MAX_STEPS`, `OPENGROKBOT_TURN_MINUTES`). Routines can be paused or deleted from the computer panel. |

## A convention, not a wall

**Holding outward actions for approval.** Every teammate is told — in its system prompt and in the hard
boundaries of its `AGENTS.md` — to prepare the work and call `hold_for_approval` before anything leaves its
workspace, and to stop there. That is a strong discipline, not an enforcement point: a bot has a real browser,
and nothing in the sandbox stops it from clicking *Send* on a site where it is signed in. Build your setup so a
mistake is cheap (rule 1 below).

**What a standing approval trusts.** A rule matches the kind and destination the bot itself declares when it
holds an action, and then the bot performs the action on its own computer. The gateway decides whether to ask
you again; it does not inspect what the bot then does. Outside input cannot start a turn in which a rule
applies, and the bot is not told which destinations its rules cover — but within a turn you started, a bot that
mislabels an action, by mistake or because a page it read told it to, could still slip one past a rule. So rules
save you waiting on a teammate you already trust with that destination; they do not make the approval gate
stronger. Keep them narrow and short-lived.

**Treating what it reads as data.** Bots are told that pages, files and emails are data, never orders, and a
webhook's body arrives explicitly labelled as data from another system. Prompt injection against tool-using
agents is still an unsolved problem industry-wide.

**Forgetting is visible, not gated.** A bot can drop a standing rule with `forget_memory` without asking you
first, the same way it can save one. Every removal posts a red diff chip in its thread, so a rule that vanished
because of something the bot read shows up there.

## Rules for you

1. **Give bots their own accounts, never yours.** Separate email, separate calendar, invited only into what
   they need. A bot with its own account has a blast radius; a bot with yours has your life.
2. **Sign in to only what the job needs.** Sessions live in the bot's browser profile on your disk
   (`gateway/data/workspaces/<bot>/.browser`), and they are as powerful as the account behind them.
3. **Keep the gateway on loopback.** For remote access, tunnel — see [always-on.md](always-on.md). If you
   must bind `0.0.0.0`, the token still guards it, but put TLS in front.
4. **Cap spend twice**: a limit on the API key at your provider, and `OPENGROKBOT_DAILY_TOKENS` here.
5. **Rotate the token if it leaked**: delete `gateway/data/auth-token` and restart. Every browser signs in again.
6. **Treat a webhook address like a password.** Anyone holding it can wake that routine with any body. If one
   leaked, delete the routine and ask for a new one.

## Where secrets live

| Secret | Where |
|---|---|
| Model API key | The `OPENGROKBOT_API_KEY` environment variable. The gateway never writes it to disk. |
| Gateway token | `gateway/data/auth-token` (`0600`), or `OPENGROKBOT_TOKEN` if you pin one. Set `OPENGROKBOT_QUIET_TOKEN=1` to keep it out of service logs. |
| Bot logins | Each bot's browser profile, inside its own workspace. The gateway never sees a password. |
| Shim token, VNC password | Generated per container at creation, kept in that container's environment. |
| Webhook keys | One per webhook routine, in the gateway's SQLite database. Shown only in the computer panel — inside the address, and on its own as the *Secret* for GitHub — and in the token-guarded routine listing the panel reads. |

## What self-hosting buys you

| Risk | Hosted (Grok Bot) | Self-hosted (this repo) |
|---|---|---|
| Where your sessions live | the vendor's cloud VM | your disk |
| Who can subpoena, breach or train on them | the vendor | you |
| Kill switch | a support ticket | the stop button, `docker stop`, or the power cable |
| Audit trail | what the vendor shows you | every message and every action in SQLite on your disk |

## The threat you still own

If a workflow would make a bot both read strangers' input **and** act outward, keep a human decision in the
loop — or redesign the workflow. The approval chip is where that decision happens; keep it meaningful by giving
bots accounts whose worst case you can live with.
