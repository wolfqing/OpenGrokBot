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
