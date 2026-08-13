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
          timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds (default 60000).' },
        },
        required: ['cmd'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file from your workspace. Paths are relative to /workspace.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
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
      description: 'Read the visible text of the current page.',
      parameters: {
        type: 'object',
        properties: { maxChars: { type: 'number', description: 'Truncate to this many characters (default 4000).' } },
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
        },
        required: ['action'],
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
      name: 'create_routine',
      description:
        'Schedule recurring work for yourself. Use it when your operator says "every day", "each Monday", "from now on at 9". You may also propose one yourself when a task clearly repeats.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short name, e.g. "Morning digest".' },
          cron: { type: 'string', description: 'Five-field cron expression in the gateway timezone, e.g. "0 9 * * 1".' },
          instructions: { type: 'string', description: 'What to do each time it fires, written to yourself.' },
        },
        required: ['name', 'cron', 'instructions'],
      },
    },
  },
]

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

export function buildTools(opts: { hasComputer: boolean; canRelay?: boolean }): ToolDef[] {
  return [
    MESSAGE_USER_TOOL,
    ...WORKFLOW_TOOLS,
    ...(opts.canRelay ? [RELAY_TOOL] : []),
    ...(opts.hasComputer ? COMPUTER_TOOLS : []),
  ]
}
