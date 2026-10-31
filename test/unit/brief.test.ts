// Brief builder unit tests: pure functions (chains, mention extraction, brief shape).
import { consola } from 'consola';
import { describe, expect, it, vi } from 'vitest';

import {
  buildBrief,
  chainToRoot,
  extractMentionedEmployeeIds,
  mentionMatcher,
} from '#server/domains/tasks/brief.service';
import { ACTIVITY_KIND } from '#shared/enums';

const P = (id: string, name: string, title: string | null = null) => ({ id, name, title, kind: 'human' });

describe('chainToRoot', () => {
  const edges = [
    { employeeId: '00000000-0000-7000-8000-5821b64a4515', supervisorId: '00000000-0000-7000-8000-ce4004f150eb' },
    { employeeId: '00000000-0000-7000-8000-cb101192dff2', supervisorId: '00000000-0000-7000-8000-ce4004f150eb' },
    { employeeId: 'jim', supervisorId: '00000000-0000-7000-8000-5821b64a4515' },
  ];
  it('walks up to the root, one level per layer', () => {
    expect(chainToRoot('jim', edges)).toEqual([
      ['00000000-0000-7000-8000-5821b64a4515'],
      ['00000000-0000-7000-8000-ce4004f150eb'],
    ]);
  });
  it('a person with two supervisors yields a combined level, cycles terminate', () => {
    const dual = [...edges, { employeeId: '00000000-0000-7000-8000-5821b64a4515', supervisorId: 'boss2' }];
    expect(chainToRoot('jim', dual)).toEqual([
      ['00000000-0000-7000-8000-5821b64a4515'],
      ['00000000-0000-7000-8000-ce4004f150eb', 'boss2'],
    ]);
  });
  it('top of org yields empty chain', () => {
    expect(chainToRoot('00000000-0000-7000-8000-ce4004f150eb', edges)).toEqual([]);
  });
  it('cycles terminate', () => {
    const cyclic = [...edges, { employeeId: '00000000-0000-7000-8000-ce4004f150eb', supervisorId: 'jim' }];
    const out = chainToRoot('jim', cyclic);
    expect(out.length).toBeLessThan(5);
  });
});

describe('extractMentionedEmployeeIds', () => {
  const map = new Map([
    ['Nam Hoang', '00000000-0000-7000-8000-481d41fbaa78'],
    ['Zed', '00000000-0000-7000-8000-cba5723598ca'],
    ['Ash', '00000000-0000-7000-8000-b5ca5ca514c6'],
  ]);
  it('matches plain @Name tokens exactly', () => {
    expect(extractMentionedEmployeeIds('Please ask @Zed for review', map)).toEqual([
      '00000000-0000-7000-8000-cba5723598ca',
    ]);
  });
  it('matches tiptap mention links', () => {
    expect(extractMentionedEmployeeIds('x @[Zed](mention-00000000-0000-7000-8000-cba5723598ca) y', map)).toEqual([
      '00000000-0000-7000-8000-cba5723598ca',
    ]);
  });
  it('multi-word names match whole', () => {
    expect(extractMentionedEmployeeIds('cc @Nam Hoang please', map)).toEqual(['00000000-0000-7000-8000-481d41fbaa78']);
  });
  it('unknown names are ignored, never guessed', () => {
    expect(extractMentionedEmployeeIds('ask @Nobody here', map)).toEqual([]);
  });
  it('matches tiptap [@ label] bracket form', () => {
    expect(extractMentionedEmployeeIds('Coordinate with [@ label="Zed"] now', map)).toEqual([
      '00000000-0000-7000-8000-cba5723598ca',
    ]);
  });
  it('dedupes', () => {
    expect(extractMentionedEmployeeIds('@Zed and @Zed again', map)).toEqual(['00000000-0000-7000-8000-cba5723598ca']);
  });
  it('a poisoned name (regex metachars) matches literally instead of throwing', () => {
    const poison = new Map([['Ash (2) [dev]*', '00000000-0000-7000-8000-b5ca5ca514c6']]);
    expect(() => extractMentionedEmployeeIds('ping @Ash (2) [dev]* now', poison)).not.toThrow();
    expect(extractMentionedEmployeeIds('ping @Ash (2) [dev]* now', poison)).toEqual([
      '00000000-0000-7000-8000-b5ca5ca514c6',
    ]);
    // and it never half-matches a different name that merely contains the text
    expect(extractMentionedEmployeeIds('ping @Ash (2) [dev]*2 now', poison)).toEqual([]);
  });
  it('the boundary rejects a longer name sharing the prefix', () => {
    expect(extractMentionedEmployeeIds('ping @Zed2 now', map)).toEqual([]);
  });
  it('skips names that fail to compile, warns once, never throws', () => {
    const warn = vi.spyOn(consola, 'warn').mockImplementation(() => {});
    // force the compile failure: correct escaping makes every real name compile
    const spy = vi.spyOn(globalThis, 'RegExp').mockImplementation((() => {
      throw new SyntaxError('mock compile failure');
    }) as never);
    try {
      expect(extractMentionedEmployeeIds('ping @Zed now', map)).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      // every known name failed (the stub throws for all RegExp compiles)
      expect(String(warn.mock.calls[0]?.[0])).toContain(String(map.size));
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });
  it('mentionMatcher still compiles unicode names exactly', () => {
    expect(mentionMatcher('Renée')?.test('ping @Renée ok')).toBe(true);
    expect(mentionMatcher('Renée')?.test('ping @Renée2 ok')).toBe(false);
  });
});

describe('buildBrief', () => {
  const base = {
    agent: P('00000000-0000-7000-8000-cba5723598ca', 'Zed', 'CEO'),
    agentInstructions: 'Always answer in Vietnamese.',
    upChain: [[P('00000000-0000-7000-8000-481d41fbaa78', 'Nam Hoang', 'Founder')]],
    directReports: [P('00000000-0000-7000-8000-b5ca5ca514c6', 'Ash', 'CTO')],
    extraChains: [
      {
        person: P('00000000-0000-7000-8000-4a10b4d22ecf', 'Jay', 'PSE'),
        chain: [[P('00000000-0000-7000-8000-481d41fbaa78', 'Nam Hoang', 'Founder')]],
      },
    ],
    task: {
      title: 'Write the spec',
      description: 'Coordinate with @Jay on the API',
      ownerName: 'Nam Hoang',
      ownerId: '00000000-0000-7000-8000-481d41fbaa78',
      reviewerNames: ['Ash'],
      projectName: 'Tandem',
    },
    outDir: '~/.tandem/t-123/attachments/out/',
    recentActivity: [{ kind: ACTIVITY_KIND.QUESTION, authorName: 'Nam Hoang', body: 'Which format?' }],
  };
  it('contains identity, chains, task, contract', () => {
    const b = buildBrief(base);
    expect(b).toContain('You are Zed, CEO.');
    expect(b).toContain('~/.tandem/t-123/attachments/out/');
    expect(b).toContain('You report to: Nam Hoang (Founder).');
    expect(b).toContain('Reports to you: Ash (CTO).');
    expect(b).toContain('Standing instructions: Always answer in Vietnamese.');
    expect(b).toContain('Jay: Jay (PSE); their chain: Nam Hoang (Founder).');
    expect(b).toContain('Title: Write the spec');
    expect(b).toContain('Coordinate with @Jay on the API');
    expect(b).toContain('Owner: Nam Hoang');
    expect(b).toContain('Reviewers (all must approve): Ash');
    expect(b).toContain('{"kind": "result", "body": "<final answer or summary of work done>"}');
    expect(b).toContain('OUTPUT CONTRACT');
  });
  it('agent without a title renders bare identity line', () => {
    const b = buildBrief({ ...base, agent: P('00000000-0000-7000-8000-cba5723598ca', 'Zed') });
    expect(b.startsWith('You are Zed.')).toBe(true);
  });
  it('attachments label inlined vs staged-only images (SPEC 2026-10-31)', () => {
    const b = buildBrief({
      ...base,
      attachments: [
        {
          id: 'att-1',
          filename: 'shot.png',
          mime: 'image/png',
          size: 2048,
          remotePath: '~/.tandem/t-123/attachments/shot.png',
          inline: true,
        },
        {
          id: 'att-2',
          filename: 'huge.png',
          mime: 'image/png',
          size: 9 * 1024 * 1024,
          remotePath: '~/.tandem/t-123/attachments/huge.png',
        },
        {
          id: 'att-3',
          filename: 'notes.txt',
          mime: 'text/plain',
          size: 512,
          remotePath: '~/.tandem/t-123/attachments/notes.txt',
        },
      ],
    });
    expect(b).toContain('shot.png, image — inlined into this prompt, 2KB');
    expect(b).toContain('huge.png, image — view with your image tool, 9216KB');
    expect(b).toContain('notes.txt, document — read with file tools, 1KB');
  });
  it('no direct reports and empty reviewers/project omit their lines', () => {
    const b = buildBrief({ ...base, directReports: [], task: { ...base.task, reviewerNames: [], projectName: null } });
    expect(b).not.toContain('Reports to you');
    expect(b).not.toContain('Reviewers');
    expect(b).not.toContain('Project:');
  });
  it('company and project prompts ride the brief above TASK', () => {
    const b = buildBrief({
      ...base,
      companyPrompt: 'Always ship pinned deps.',
      projectPrompt: 'This project is the FedEx integration.',
    });
    expect(b).toContain('COMPANY (applies to all your work)\nAlways ship pinned deps.');
    expect(b).toContain('PROJECT — Tandem\nThis project is the FedEx integration.');
    expect(b.indexOf('COMPANY')).toBeLessThan(b.indexOf('PROJECT'));
    expect(b.indexOf('PROJECT')).toBeLessThan(b.indexOf('\nTASK'));
  });

  it('empty company/project prompts omit their sections entirely', () => {
    const b = buildBrief({ ...base });
    expect(b).not.toContain('COMPANY');
    expect(b).not.toContain('PROJECT');
  });

  it('project prompt without a project name still renders the section', () => {
    const b = buildBrief({ ...base, task: { ...base.task, projectName: null }, projectPrompt: 'standards apply' });
    expect(b).toContain('PROJECT\nstandards apply');
  });

  it('no supervisors -> top of organization', () => {
    const b = buildBrief({ ...base, upChain: [] });
    expect(b).toContain('(nobody — top of organization)');
  });
  it('activity included on re-runs', () => {
    expect(buildBrief(base)).toContain('question by Nam Hoang: Which format?');
  });
  it('null body + null authorName + untitled people render safely', () => {
    const b = buildBrief({
      ...base,
      upChain: [[P('00000000-0000-7000-8000-f20d9b639839', 'NoTitle')]],
      agentInstructions: '',
      recentActivity: [{ kind: 'status', authorName: null, body: null }],
    });
    expect(b).toContain('You report to: NoTitle.');
    expect(b).not.toContain('Standing instructions');
    expect(b).toMatch(/status by system: $/m);
  });
  it('mentioned person at the top of the org shows (unknown) chain', () => {
    const b = buildBrief({
      ...base,
      extraChains: [{ person: P('00000000-0000-7000-8000-a75828b8df28', 'Lone'), chain: [] }],
    });
    expect(b).toContain('Lone: Lone; their chain: (unknown).');
  });
  it('strips tiptap mention markup but keeps the name', () => {
    const b = buildBrief({
      ...base,
      task: { ...base.task, description: 'ping @[Jay](mention-00000000-0000-7000-8000-4a10b4d22ecf) pls' },
    });
    expect(b).toContain('ping Jay pls');
    expect(b).not.toContain('mention-00000000-0000-7000-8000-4a10b4d22ecf');
  });
});
