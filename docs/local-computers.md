# Plan: teammates' computers without Docker

> **Status: the local computer has shipped for macOS and Linux** (step 1 below). The desktop app, the first-run
> wizard and the Apple container backend are still plans. The two questions this page once left open were settled
> on 2026-10-30 (see [Decided](#decided)).

The computers stay **on your machine** — no cloud VMs. What changes is what you have to install first. Many people
will not install Docker Desktop (or Node, pnpm and git) to try a product, so the default experience should need
none of them.

## Pluggable computers

The gateway already talks to a teammate's computer through one interface (`BotComputer`). The plan adds backends
and picks one per machine:

| Backend | What you install | Isolation | Runs on |
|---|---|---|---|
| **Local** (shipped; the default when Docker is not running) | Nothing: an existing Chrome/Edge/Chromium, or a Chrome for Testing downloaded on first use | Browser: a separate profile per teammate. Commands: off by default; when on, an OS sandbox that confines them to the teammate's own folder | macOS (Intel and Apple silicon) and Linux; Windows later |
| **Apple container** | Apple's signed `container` package (one admin password) | A lightweight VM per teammate | macOS 26 on Apple silicon |
| **Docker** (today) | Docker Desktop, or Docker on a server | A container per teammate | Anywhere Docker runs |

## Local mode

The gateway chooses at startup — Docker when the daemon answers, local otherwise — and says so in its log.
`OPENGROKBOT_COMPUTERS=docker|local` forces one; `OPENGROKBOT_BROWSER` names a browser executable, and
`OPENGROKBOT_BROWSER_MIRROR` a download host for the Chrome for Testing fallback.

- **Out of your way.** Teammates work in a headless browser in the background — no windows popping up.
- **Signing in gets simpler.** At a login wall, the teammate's browser reopens as a normal window on your desktop,
  on the page it was stuck on; you sign in there, click *I'm done signing in* in the panel (or just send it the next
  message), and it goes back to the background with the session in its own profile. No VNC in between.
- **Watching still works.** The computer panel shows the browser's screen as a live stream (CDP screencast), view
  only.
- **The browser keeps its own sandbox.** On the host, Chromium runs with its sandbox on (inside containers it
  cannot).
- **Commands are off by default.** A local teammate gets a browser and its own folder; most of the work people
  hand off needs nothing more. You can turn commands on per teammate in its computer panel, and then they run in
  an OS sandbox that confines them to that teammate's folder: Seatbelt on macOS, bubblewrap on Linux — the same
  primitives developer agents use today. The switch refuses to turn on until the sandbox passes a self-check (a
  write outside the folder and a read of the gateway token must both fail). What the sandbox does and does not
  promise is spelled out in [security.md](security.md#local-computers).
- **No Linux userland.** A local teammate cannot `apt install` tools. Teammates that need that get a sealed
  computer (Apple container or Docker) instead.

Each teammate will show which kind of computer it has — **sealed** (container or VM) or **local sandbox** — and you
can move a teammate between them.

## No terminal either

Removing Docker is half of it. The other half is a desktop app that carries the gateway, the UI and the runtime,
starts at login, lives in the tray and updates itself, plus a first-run wizard: pick a model provider (presets for
DeepSeek, Kimi, xAI, OpenAI, OpenRouter, a local Ollama), paste a key, test it — or start in demo mode with no key.
The interface gets a Chinese translation. The desktop technology is not decided yet.

## Order

1. ~~The computer backend interface and local mode on macOS and Linux (browser and files; commands off by default,
   sandboxed when turned on).~~ Shipped.
2. The desktop app, first-run wizard and Chinese UI.
3. The Apple container backend, for strong isolation without Docker on macOS 26.
4. Docker stays for servers and anyone who prefers it.

## Decided

- **Shell commands are off by default in local mode.** It is the safest and simplest default, and most teammates
  mostly need the browser. Turning them on is a per-teammate switch, and they still run inside the OS sandbox.
- **The first version does not cover Windows.** It has no sandbox as mature as Seatbelt or bubblewrap, and
  half-supporting it would make the default experience worse. Windows comes after macOS and Linux are solid;
  until then Docker remains the way to run teammates there.

Ideas and objections are welcome in the issues.
