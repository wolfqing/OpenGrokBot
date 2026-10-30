import { APPROVAL_KINDS } from './approvals.js'
import type { ToolDef } from './llm.js'

export const MESSAGE_USER_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'message_user',
    description:
      'Send a structured message to your operator. kind "report" renders the standard work-report chip (✓ system → result · count).',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['report'] },
        payload: {
          type: 'object',
          properties: {
            lines: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  system: { type: 'string', description: 'The system/surface you touched, e.g. "Salesforce"' },
                  result: { type: 'string', description: '2-5 plain words, e.g. "list pulled"' },
                  count: { type: 'string', description: 'The number that proves it, e.g. "52 accounts"' },
                },
                required: ['system', 'result'],
              },
            },
            closing: { type: 'string', description: 'ONE plain sentence surfacing only what needs the human.' },
          },
          required: ['lines'],
        },
      },
      required: ['kind', 'payload'],
    },
  },
}

const COMPUTER_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'shell',
      description: 'Run a bash command on your own computer. Working directory is /workspace, which persists between sessions.',
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string', description: 'The bash command line to run.' },
          timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds (default 60000, at most 600000). Start long-running servers in the background with their output in a file, e.g. `nohup npm run dev > dev.log 2>&1 &`.' },
        },
        required: ['cmd'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file from your workspace. Paths are relative to /workspace. Long files come back in slices; the reply tells you the offset for the next one.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'number', description: 'Character to start from (default 0).' },
          maxChars: { type: 'number', description: 'How many characters to return (default 4000, max 12000).' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a UTF-8 text file into your workspace, creating parent directories as needed.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_goto',
      description: 'Navigate the browser on your computer to a URL. The browser keeps its logins between sessions.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_extract',
      description: 'Read the visible text of the current page, plus the links on it (first slice only). Long pages come back in slices; the reply tells you the offset for the next one.',
      parameters: {
        type: 'object',
        properties: {
          offset: { type: 'number', description: 'Character to start from (default 0).' },
          maxChars: { type: 'number', description: 'How many characters to return (default 4000, max 12000).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Click something on the current page: pass a CSS selector, or the visible text of the control.',
      parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type into a field on the current page: pass a CSS selector, or the field\'s label or placeholder text. Set submit to press Enter afterwards. Never type a password — ask for a takeover instead.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          text: { type: 'string' },
          submit: { type: 'boolean', description: 'Press Enter after typing (default false).' },
        },
        required: ['target', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_press',
      description: 'Press a key on the current page, e.g. "Enter", "Escape", "Tab", "PageDown".',
      parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description: 'Scroll the current page by about one screen.',
      parameters: {
        type: 'object',
        properties: { direction: { type: 'string', enum: ['down', 'up'] } },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_back',
      description: 'Go back to the previous page.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Capture your screen and post it into the chat as evidence. Use it to show your operator what you saw.',
      parameters: {
        type: 'object',
        properties: { caption: { type: 'string', description: 'One short line describing what is on screen.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_for_login',
      description:
        'Ask your operator to sign in to a site on your computer. Use it the moment you hit a login wall — you never have their credentials and must never ask for them in chat. They take over your screen, sign in once, and the session stays in your browser from then on.',
      parameters: {
        type: 'object',
        properties: {
          site: { type: 'string', description: 'The site, e.g. "Zendesk".' },
          why: { type: 'string', description: 'What you will do once you are in, in one line.' },
        },
        required: ['site'],
      },
    },
  },
]

const WORKFLOW_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'hold_for_approval',
      description:
        'Hold an outward-facing action for your operator to approve. ALWAYS use this before anything that leaves your workspace — sending, publishing, paying, booking, replying on their behalf. Do the preparation first, then hold the finished draft.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'The action in one short line, e.g. "send the 4 queued drafts".' },
          detail: { type: 'string', description: 'What exactly would go out — recipients, amounts, the draft itself.' },
          kind: {
            type: 'string',
            enum: [...APPROVAL_KINDS],
            description: 'What sort of action this is. Be honest: it decides whether a standing rule from your operator can cover it. Purchases, bookings and "other" always wait for a person.',
          },
          target: {
            type: 'string',
            description: 'Where it goes, as one exact destination: an email address, a channel like "#ops", a site or account. Leave it empty when there is no single destination.',
          },
          items: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 200,
            description: 'When the same action goes to many recipients or records, one line per item (e.g. "#4812 · jane@acme.com · refund question"). Your operator can untick any before approving, and you then act on exactly the ones left.',
          },
        },
        required: ['action', 'kind'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_operator',
      description:
        'Ask your operator to choose between a few options — it shows as a card with buttons. Use it when the answer decides what you do next and the choices are clear. Then stop and wait; never guess the answer.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question in one line.' },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 6,
            items: { type: 'string' },
            description: 'Two to six short, distinct choices.',
          },
          multi: { type: 'boolean', description: 'Allow picking several (default false).' },
        },
        required: ['question', 'options'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description:
        'Write a standing rule into your MEMORY.md. Use it whenever your operator tells you how to behave from now on ("always...", "never...", "from now on..."). One rule per call, phrased so it still makes sense months later.',
      parameters: {
        type: 'object',
        properties: { rule: { type: 'string', description: 'The rule in one plain sentence.' } },
        required: ['rule'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forget_memory',
      description:
        'Remove one standing rule from your MEMORY.md when your operator says to drop it ("forget...", "you can stop...", "that rule no longer applies"). Quote the rule as it appears under your standing rules.',
      parameters: {
        type: 'object',
        properties: { rule: { type: 'string', description: 'The rule to remove, as written in your standing rules.' } },
        required: ['rule'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_routine',
      description:
        'Set up recurring work for yourself. Use cron when your operator says "every day", "each Monday", "from now on at 9". Use webhook when the work should start whenever another system calls in ("when a GitHub issue opens", "whenever the form is submitted"); your operator copies the webhook address from your computer panel. You may also propose one yourself when a task clearly repeats.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short name, e.g. "Morning digest".' },
          cron: { type: 'string', description: 'Five-field cron expression in the gateway timezone, e.g. "0 9 * * 1". Omit for a webhook-only routine.' },
          webhook: { type: 'boolean', description: 'Also start this routine whenever its webhook is called (default false).' },
          mode: {
            type: 'string',
            enum: ['act', 'watch'],
            description: '"watch" for keeping an eye on something: each run gets read-only tools and stays silent unless something needs your operator. Default "act".',
          },
          instructions: { type: 'string', description: 'What to do each time it fires, written to yourself.' },
        },
        required: ['name', 'instructions'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_routine',
      description:
        'Stop one of your routines for good — when your operator says to, or when it no longer makes sense. Your routines and their ids are listed in your instructions.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number', description: 'The routine id, e.g. 3.' } },
        required: ['id'],
      },
    },
  },
]

const SKILL_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'read_skill',
    description:
      'Read one of the shared skills listed in your instructions: a playbook your operator wrote for a kind of work. Read it before doing work it covers, and follow it.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The skill name, as listed.' },
        offset: { type: 'number', description: 'Character to start from, for a long skill (default 0).' },
      },
      required: ['name'],
    },
  },
}

/**
 * watch routine 的回合只拿这些：看网页、读文件、读技能、汇报、提问、把动作扣下来等人批。
 * 能改东西的（shell、写文件、点击、输入、按键）、能把话传出去的（转交）、能改规矩的都不给。
 */
export const WATCH_TOOL_NAMES: ReadonlySet<string> = new Set([
  'message_user', 'hold_for_approval', 'ask_operator', 'read_skill', 'read_file',
  'browser_goto', 'browser_extract', 'browser_scroll', 'browser_back', 'browser_screenshot', 'ask_for_login',
])

const RELAY_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'message_bot',
    description:
      'Hand a specific task to another teammate. It lands in their thread and they pick it up. Only allowlisted teammates are reachable. Say what "done" looks like and by when — never hand off something you have not scoped.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'The teammate id, e.g. "market-watch".' },
        content: { type: 'string', description: 'The task, its purpose and its deadline, written to them.' },
      },
      required: ['to', 'content'],
    },
  },
}

export function buildTools(opts: {
  hasComputer: boolean
  canRelay?: boolean
  hasSkills?: boolean
  watch?: boolean
  /** false = 这台电脑没有命令行（本机模式默认）：连工具都不列，模型就不会去试 */
  shell?: boolean
}): ToolDef[] {
  const computerTools = opts.shell === false ? COMPUTER_TOOLS.filter((t) => t.function.name !== 'shell') : COMPUTER_TOOLS
  const tools = [
    MESSAGE_USER_TOOL,
    ...WORKFLOW_TOOLS,
    ...(opts.hasSkills ? [SKILL_TOOL] : []),
    ...(opts.canRelay ? [RELAY_TOOL] : []),
    ...(opts.hasComputer ? computerTools : []),
  ]
  return opts.watch ? tools.filter((t) => WATCH_TOOL_NAMES.has(t.function.name)) : tools
}
