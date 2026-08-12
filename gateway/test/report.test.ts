import { describe, expect, it } from 'vitest'
import { validateReportPayload } from '../src/report.js'

describe('validateReportPayload', () => {
  it('accepts lines with optional count and closing, trimming strings', () => {
    const p = validateReportPayload({
      lines: [
        { system: ' Salesforce ', result: 'list pulled ', count: ' 52 accounts ' },
        { system: 'LinkedIn', result: 'skipped' },
      ],
      closing: ' two things need you today ',
    })
    expect(p).toEqual({
      lines: [
        { system: 'Salesforce', result: 'list pulled', count: '52 accounts' },
        { system: 'LinkedIn', result: 'skipped' },
      ],
      closing: 'two things need you today',
    })
  })

  it('rejects junk', () => {
    expect(validateReportPayload(null)).toBeNull()
    expect(validateReportPayload({})).toBeNull()
    expect(validateReportPayload({ lines: [] })).toBeNull()
    expect(validateReportPayload({ lines: [{ system: 'X' }] })).toBeNull() // result 缺失
    expect(validateReportPayload({ lines: [{ system: 42, result: 'ok' }] })).toBeNull()
    expect(validateReportPayload({ lines: [{ system: 'X', result: 'ok', count: 7 }] })).toBeNull() // count 非 string
  })

  it('drops empty closing', () => {
    expect(validateReportPayload({ lines: [{ system: 'X', result: 'ok' }], closing: '  ' }))
      .toEqual({ lines: [{ system: 'X', result: 'ok' }] })
  })
})
