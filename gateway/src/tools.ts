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
]

export function buildTools(hasComputer: boolean): ToolDef[] {
  return hasComputer ? [MESSAGE_USER_TOOL, ...COMPUTER_TOOLS] : [MESSAGE_USER_TOOL]
}
