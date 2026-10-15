import { describe, expect, it } from 'vitest'
import { buildThread, formatThreadTime, parseRunEnvelope, runAgentMessage, runOutputWithoutEnvelope } from '../app/utils/task-thread'

describe('runAgentMessage', () => {
  it('keeps the agent prose, drops system lines and the envelope, collapses blanks', () => {
    const out = [
      '[context] 52204/1000000',
      'Screenshot computed.',
      '',
      '',
      '',
      'Contract page is realistic.',
      '[tool] vision_analyze',
      '[RESULT] done',
    ].join('\n')
    expect(runAgentMessage(out)).toBe('Screenshot computed.\n\nContract page is realistic.')
  })

  it('returns empty when only system lines exist (failed stderr runs)', () => {
    expect(runAgentMessage('[stderr] boom\n[reaper] run timed out')).toBe('')
    expect(runAgentMessage('')).toBe('')
    expect(runAgentMessage(null)).toBe('')
  })
})

describe('parseRunEnvelope', () => {
  it('parses a RESULT envelope on the last line', () => {
    expect(parseRunEnvelope('work\n[RESULT] shipped v1')).toEqual({ kind: 'result', text: 'shipped v1' })
  })
  it('parses QUESTION and BLOCKED', () => {
    expect(parseRunEnvelope('[QUESTION] which db?')).toEqual({ kind: 'question', text: 'which db?' })
    expect(parseRunEnvelope('[BLOCKED] no key')).toEqual({ kind: 'blocked', text: 'no key' })
  })
  it('takes the LAST envelope when several appear', () => {
    expect(parseRunEnvelope('[RESULT] old\nmore\n[QUESTION] final?')?.kind).toBe('question')
  })
  it('returns null for no envelope or empty output', () => {
    expect(parseRunEnvelope('plain output')).toBeNull()
    expect(parseRunEnvelope('')).toBeNull()
    expect(parseRunEnvelope(null)).toBeNull()
  })
})

describe('runOutputWithoutEnvelope', () => {
  it('strips the envelope line, keeps prose', () => {
    expect(runOutputWithoutEnvelope('line one\n[RESULT] done')).toBe('line one')
  })
  it('returns output untouched when no envelope', () => {
    expect(runOutputWithoutEnvelope('plain')).toBe('plain')
  })
  it('nullish output without envelope returns empty string', () => {
    expect(runOutputWithoutEnvelope(undefined)).toBe('')
  })
})

describe('buildThread', () => {
  it('description becomes the first bubble even when newer than runs', () => {
    const items = buildThread({
      description: 'do the thing',
      createdAt: '2026-01-03T00:00:00Z',
      runs: [{ id: 'r1', status: 'done', output: 'x', exitCode: 0, startedAt: '2026-01-01T00:00:00Z', finishedAt: null }],
      activity: [{ id: 'a1', noteKind: 'question', body: 'q', authorName: 'Nam', createdAt: '2026-01-02T00:00:00Z' }],
    })
    expect(items[0]?.kind).toBe('brief')
    expect(items.map(i => i.id)).toEqual(['brief', 'r1', 'a1'])
  })
  it('interleaves runs and activity chronologically with id tiebreak', () => {
    const items = buildThread({
      runs: [
        { id: 'r2', status: 'done', output: '', exitCode: 0, startedAt: '2026-01-02T00:00:00Z', finishedAt: null },
        { id: 'r1', status: 'done', output: '', exitCode: 0, startedAt: '2026-01-01T00:00:00Z', finishedAt: null },
      ],
      activity: [
        { id: 'a9', noteKind: 'status', body: '', authorName: null, createdAt: '2026-01-03T00:00:00Z' },
      ],
    })
    expect(items.map(i => i.id)).toEqual(['r1', 'r2', 'a9'])
  })
  it('omits the brief when description is empty/whitespace', () => {
    expect(buildThread({ description: '   ', runs: [], activity: [] })).toEqual([])
  })
  it('carries run prompt through when the source provides it', () => {
    const items = buildThread({
      runs: [{ id: 'r1', status: 'done', output: 'out', prompt: 'please do it', agentName: 'Jay', exitCode: 0, startedAt: '2026-01-01T00:00:00Z', finishedAt: null }],
    })
    expect(items[0].kind === 'run' && items[0].agentName).toBe('Jay')
    expect(items[0].kind === 'run' && items[0].prompt).toBe('please do it')
    const none = buildThread({
      runs: [{ id: 'r2', status: 'done', output: '', exitCode: 0, startedAt: '2026-01-01T00:00:00Z', finishedAt: null }],
    })
    expect(none[0].kind === 'run' && none[0].prompt).toBeUndefined()
  })

  it('carries run fields through', () => {
    const [item] = buildThread({ runs: [{ id: 'r1', status: 'running', output: 'partial', exitCode: null, startedAt: 't', finishedAt: null }] })
    expect(item).toMatchObject({ kind: 'run', status: 'running', output: 'partial', exitCode: null })
  })
})

describe('envelope edge arms', () => {
  it('question envelope with empty text yields kind and empty text', () => {
    expect(parseRunEnvelope('pre\n[QUESTION]')).toEqual({ kind: 'question', text: '' })
  })
  it('envelope inside earlier line but not last still found from the end', () => {
    expect(parseRunEnvelope('[RESULT] first\nmid\n[QUESTION] q?')?.text).toBe('q?')
  })
  it('output of envelope-only run strips to empty string', () => {
    expect(runOutputWithoutEnvelope('[BLOCKED] waiting')).toBe('')
  })
  it('envelope-only run strips to empty (envelope at position 0)', () => {
    expect(runOutputWithoutEnvelope('[RESULT] only line')).toBe('')
  })
  it('whitespace-only description omits brief; null description too', () => {
    expect(buildThread({ description: null as string | null, runs: [], activity: [] })).toEqual([])
  })
  it('note items carry kind and author fields', () => {
    const [n] = buildThread({ activity: [{ id: 'a1', noteKind: 'verdict', body: 'approved', authorName: 'Zed', createdAt: 't' }] })
    expect(n).toMatchObject({ kind: 'note', noteKind: 'verdict', body: 'approved', authorName: 'Zed' })
  })
})

describe('buildThread degenerate sources', () => {
  it('no runs and no activity keys at all yields brief only', () => {
    expect(buildThread({ description: 'solo', createdAt: 't' }).map(i => i.kind)).toEqual(['brief'])
  })
  it('trailing non-envelope lines after an earlier envelope still resolve from the end', () => {
    expect(parseRunEnvelope('[RESULT] early\ntail line\nmore tail')?.kind).toBe('result')
  })
  it('empty-string description (falsy) omits brief via the other arm', () => {
    expect(buildThread({ description: '', runs: [], activity: [] })).toEqual([])
  })
  it('brief falls back to empty createdAt when absent', () => {
    const [b] = buildThread({ description: 'x' })
    expect(b).toMatchObject({ kind: 'brief', createdAt: '' })
  })
  it('equal timestamps order by id (tiebreak arm)', () => {
    const items = buildThread({
      runs: [
        { id: 'rb', status: 'done', output: '', exitCode: 0, startedAt: '2026-01-01T00:00:00Z', finishedAt: null },
        { id: 'ra', status: 'done', output: '', exitCode: 0, startedAt: '2026-01-01T00:00:00Z', finishedAt: null },
      ],
    })
    expect(items.map(i => i.id)).toEqual(['ra', 'rb'])
  })
})

describe('formatThreadTime', () => {
  it('shows HH:MM for same-day timestamps', () => {
    expect(formatThreadTime('2026-01-02T14:32:00.000Z', new Date('2026-01-02T23:00:00.000Z'))).toMatch(/^\d{2}:\d{2}$/)
  })
  it('shows Mon D, HH:MM for other days this year', () => {
    const t = formatThreadTime(new Date('2026-03-05T09:05:00').toISOString(), new Date('2026-10-02T12:00:00'))
    expect(t).toBe('Mar 5, 09:05')
  })
  it('includes the year for other-year timestamps', () => {
    const d = new Date(2024, 2, 5, 9, 5)
    expect(formatThreadTime(d.toISOString(), new Date(2026, 9, 2))).toBe('Mar 5 2024')
  })
  it('returns empty string for invalid dates', () => {
    expect(formatThreadTime('not-a-date')).toBe('')
  })
  it('pads hours and minutes', () => {
    const d = new Date(2026, 0, 2, 5, 7)
    const now = new Date(2026, 0, 2, 8, 0)
    expect(formatThreadTime(d.toISOString(), now)).toBe('05:07')
  })
})
