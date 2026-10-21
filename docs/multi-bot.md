# Many teammates, one crew

Grok Bot's headline demo is bots that report to a room and hand work to each other. Here is how that works in
OpenGrokBot, and where you set the boundaries.

## A teammate is a folder

```
teammates/researcher/
  SOUL.md     # who it is: temperament, voice, what it refuses to be
  AGENTS.md   # how it works: protocol, where it files things, hard boundaries
```

Both files go into the system prompt, the persona first and the operating manual after it. Role and emoji sit
in `SOUL.md`'s frontmatter:

```markdown
---
role: Turns a one-line question into a decision-ready brief with sources
emoji: 🔎
---
# Scout
```

The crew that ships with the repo lives in [`teammates/`](../teammates/). Teammates you hire from the sidebar
(`+`, a name, one line of job description) are written to `gateway/data/teammates/<id>/` and join the default
group. To add one by hand, drop a folder with a `SOUL.md` (and ideally an `AGENTS.md`) into either place and
restart the gateway.

## Group threads

Ask the room a question and every member answers for its own patch — in parallel, since nobody needs to wait for
anyone else. Then the chief of staff reads all of it and closes with a dispatch table:

```
✓ Pricing → @market-watch · Friday
✓ Brief → @researcher · Thursday
One thing needs you today: pick the deadline for the Globex reply.
```

A second question waits until the first round has closed, so answers never interleave. The stop button ends the
round: whoever is still talking stops, and the chief does not close.

## Handoffs

A teammate can pass a scoped task with `message_bot`. It lands in the other teammate's thread as a
*Messages from @…* chip, and that teammate picks it up right away.

Who may reach whom is an allowlist:

- The chief of staff (`OPENGROKBOT_CHIEF`, default `chief`) can message anyone, and anyone can message it.
- Everything else is off until you name a direction:

  ```bash
  OPENGROKBOT_A2A_ALLOW='researcher>market-watch,market-watch>researcher'
  ```

- A relay can go two hops — a dispatch and a reply — and no further, so two bots cannot echo at each other.

A refused handoff is reported back to the bot, which tells you plainly instead of pretending; routing it through
the chief always works.

## One thing at a time

Each teammate does one turn at a time. A message you send while it is busy shows up immediately and is answered
next; several messages that pile up are answered together. Routines, approvals and handoffs queue the same way,
so two jobs never fight over one browser. The same routine never runs twice at once.

## Budgets

`OPENGROKBOT_DAILY_TOKENS` caps each teammate's model use per day; its computer panel shows today's count. A
routine that fires every minute cannot run up your bill past that line — and you can pause or delete it from the
same panel, or tell the bot to `stop_routine`.

## Shared skills

Write a playbook once and every teammate can follow it. A skill is a Markdown file in `<data>/skills/`
(`gateway/data/skills/` by default); its file name is its name, in lowercase letters, digits, `-` or `_`:

```markdown
---
description: How the Friday report is laid out
---
# Weekly report

Three sections: wins, risks, asks. One line each, numbers first.
```

Every teammate sees the list — names and the `description` line, or the first line of text — in its
instructions, and calls `read_skill` to load one before work it covers. Skills are read fresh at the start of
each turn, so a new or edited file applies from the next message. Bots cannot write them: the folder is outside
their computers. Memory and routines stay per teammate; skills are the one thing they all share.
