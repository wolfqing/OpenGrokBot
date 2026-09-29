# Plan: teammates' computers without Docker

> **Status: planned, not built.** Today every teammate's computer is a Docker container. This page is the plan for
> the next step; details will change as it lands, and the open questions at the end are still open.

The computers stay **on your machine** — no cloud VMs. What changes is what you have to install first. Many people
will not install Docker Desktop (or Node, pnpm and git) to try a product, so the default experience should need
none of them.

## Pluggable computers

The gateway already talks to a teammate's computer through one interface (`BotComputer`). The plan adds backends
and picks one per machine:

| Backend | What you install | Isolation | Runs on |
|---|---|---|---|
| **Local** (planned default) | Nothing: an existing Chrome/Edge, or a browser downloaded on first run | Browser: a separate profile per teammate. Commands: an OS sandbox that confines them to the teammate's own folder | macOS (Intel and Apple silicon), Windows, Linux |
| **Apple container** | Apple's signed `container` package (one admin password) | A lightweight VM per teammate | macOS 26 on Apple silicon |
| **Docker** (today) | Docker Desktop, or Docker on a server | A container per teammate | Anywhere Docker runs |

## Local mode

- **Out of your way.** Teammates work in a headless browser in the background — no windows popping up.
- **Signing in gets simpler.** At a login wall, the teammate's browser opens as a normal window on your desktop;
  you sign in there, and the session stays in that teammate's own profile. No VNC in between.
- **Watching still works.** The computer panel streams the browser's screen directly.
- **The browser keeps its own sandbox.** On the host, Chromium runs with its sandbox on (inside containers it
  cannot).
- **Commands are the trade-off.** Instead of a separate computer, shell commands run in an OS sandbox: Seatbelt on
  macOS, bubblewrap on Linux — the same primitives developer agents use today. Windows has no equally mature
  built-in option yet, so there the first version limits teammates to the browser and their files, or asks you
  before each command.
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

1. The computer backend interface and local mode (sandboxed commands on macOS and Linux; browser and files on
   Windows).
2. The desktop app, first-run wizard and Chinese UI.
3. The Apple container backend, for strong isolation without Docker on macOS 26.
4. Docker stays for servers and anyone who prefers it.

## Open questions

- In local mode, should shell commands be **off by default** (safest and simplest; most teammates mostly need the
  browser) or **on inside the sandbox**?
- Does the first version cover **Windows**?

Ideas and objections are welcome in the issues.
