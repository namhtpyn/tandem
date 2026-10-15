// Brief builder unit tests: pure functions (chains, mention extraction, brief shape).
import { describe, expect, it } from 'vitest'
import { buildBrief, chainToRoot, extractMentionedEmployeeIds } from '../server/domains/tasks/brief.service'

const P = (id: string, name: string, title: string | null = null) => ({ id, name, title, kind: 'human' })

describe('chainToRoot', () => {
  const edges = [
    { employeeId: 'zed', supervisorId: 'nam' },
    { employeeId: 'ash', supervisorId: 'nam' },
    { employeeId: 'jim', supervisorId: 'zed' },
  ]
  it('walks up to the root', () => {
    expect(chainToRoot('jim', edges)).toEqual(['zed', 'nam'])
  })
  it('top of org yields empty chain', () => {
    expect(chainToRoot('nam', edges)).toEqual([])
  })
  it('cycles terminate', () => {
    const cyclic = [...edges, { employeeId: 'nam', supervisorId: 'jim' }]
    const out = chainToRoot('jim', cyclic)
    expect(out.length).toBeLessThan(5)
  })
})

describe('extractMentionedEmployeeIds', () => {
  const map = new Map([['Nam Hoang', 'u-nam'], ['Zed', 'u-zed'], ['Ash', 'u-ash']])
  it('matches plain @Name tokens exactly', () => {
    expect(extractMentionedEmployeeIds('Please ask @Zed for review', map)).toEqual(['u-zed'])
  })
  it('matches tiptap mention links', () => {
    expect(extractMentionedEmployeeIds('x @[Zed](mention-u-zed) y', map)).toEqual(['u-zed'])
  })
  it('multi-word names match whole', () => {
    expect(extractMentionedEmployeeIds('cc @Nam Hoang please', map)).toEqual(['u-nam'])
  })
  it('unknown names are ignored, never guessed', () => {
    expect(extractMentionedEmployeeIds('ask @Nobody here', map)).toEqual([])
  })
  it('matches tiptap [@ label] bracket form', () => {
    expect(extractMentionedEmployeeIds('Coordinate with [@ label="Zed"] now', map)).toEqual(['u-zed'])
  })
  it('dedupes', () => {
    expect(extractMentionedEmployeeIds('@Zed and @Zed again', map)).toEqual(['u-zed'])
  })
})

describe('buildBrief', () => {
  const base = {
    agent: P('u-zed', 'Zed', 'CEO'),
    agentInstructions: 'Always answer in Vietnamese.',
    upChain: [P('u-nam', 'Nam Hoang', 'Founder')],
    directReports: [P('u-ash', 'Ash', 'CTO')],
    extraChains: [{ person: P('u-jay', 'Jay', 'PSE'), chain: [P('u-nam', 'Nam Hoang', 'Founder')] }],
    task: {
      title: 'Write the spec',
      description: 'Coordinate with @Jay on the API',
      ownerName: 'Nam Hoang',
      reviewerNames: ['Ash'],
      projectName: 'Tandem',
    },
    outDir: '~/.tandem/t-123/attachments/out/',
    recentActivity: [{ kind: 'question', authorName: 'Nam Hoang', body: 'Which format?' }],
  }
  it('contains identity, chains, task, contract', () => {
    const b = buildBrief(base)
    expect(b).toContain('You are Zed, CEO.')
    expect(b).toContain('~/.tandem/t-123/attachments/out/')
    expect(b).toContain('You report to: Nam Hoang (Founder).')
    expect(b).toContain('Reports to you: Ash (CTO).')
    expect(b).toContain('Standing instructions: Always answer in Vietnamese.')
    expect(b).toContain('Jay: Jay (PSE); their chain: Nam Hoang (Founder).')
    expect(b).toContain('Title: Write the spec')
    expect(b).toContain('Coordinate with @Jay on the API')
    expect(b).toContain('Owner: Nam Hoang')
    expect(b).toContain('Reviewers (all must approve): Ash')
      expect(b).toContain('[RESULT] <final answer or summary of work done>')
  })
  it('agent without a title renders bare identity line', () => {
    const b = buildBrief({ ...base, agent: P('u-zed', 'Zed') })
    expect(b.startsWith('You are Zed.')).toBe(true)
  })
  it('no direct reports and empty reviewers/project omit their lines', () => {
    const b = buildBrief({ ...base, directReports: [], task: { ...base.task, reviewerNames: [], projectName: null } })
    expect(b).not.toContain('Reports to you')
    expect(b).not.toContain('Reviewers')
    expect(b).not.toContain('Project:')
  })
  it('no supervisors -> top of organization', () => {
    const b = buildBrief({ ...base, upChain: [] })
    expect(b).toContain('(nobody — top of organization)')
  })
  it('activity included on re-runs', () => {
    expect(buildBrief(base)).toContain('question by Nam Hoang: Which format?')
  })
  it('null body + null authorName + untitled people render safely', () => {
    const b = buildBrief({
      ...base,
      upChain: [P('u-x', 'NoTitle')],
      agentInstructions: '',
      recentActivity: [{ kind: 'status', authorName: null, body: null }],
    })
    expect(b).toContain('You report to: NoTitle.')
    expect(b).not.toContain('Standing instructions')
    expect(b).toMatch(/status by system: $/m)
  })
  it('mentioned person at the top of the org shows (unknown) chain', () => {
    const b = buildBrief({ ...base, extraChains: [{ person: P('u-lone', 'Lone'), chain: [] }] })
    expect(b).toContain('Lone: Lone; their chain: (unknown).')
  })
  it('strips tiptap mention markup but keeps the name', () => {
    const b = buildBrief({ ...base, task: { ...base.task, description: 'ping @[Jay](mention-u-jay) pls' } })
    expect(b).toContain('ping Jay pls')
    expect(b).not.toContain('mention-u-jay')
  })
})
