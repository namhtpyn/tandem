import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseStructuredOutput, renderOutputContract } from '../../shared/structured-output';

// a deliberately NON-tandem schema proves the module is application-agnostic
const ReportSchema = z.object({
  score: z.number().min(0).max(10),
  notes: z.string(),
  tags: z.array(z.string()),
});

describe('parseStructuredOutput (generic, async)', () => {
  it('parses any zod schema from the trailing JSON line', async () => {
    const out = 'analysis prose\n{"score": 8, "notes": "solid", "tags": ["api", "db"]}';
    expect(await parseStructuredOutput(out, ReportSchema)).toEqual({ score: 8, notes: 'solid', tags: ['api', 'db'] });
  });
  it('rejects schema-violating JSON', async () => {
    expect(await parseStructuredOutput('{"score": 99, "notes": "x", "tags": []}', ReportSchema)).toBeNull();
    expect(await parseStructuredOutput('{"notes": "missing score"}', ReportSchema)).toBeNull();
  });
  it('is fence-tolerant and window-bounded', async () => {
    expect(await parseStructuredOutput('```json\n{"score": 1, "notes": "f", "tags": []}\n```', ReportSchema)).toEqual({
      score: 1,
      notes: 'f',
      tags: [],
    });
    expect(
      await parseStructuredOutput(`{"score": 2, "notes": "far", "tags": []}\n${'tail\n'.repeat(6)}`, ReportSchema, 5),
    ).toBeNull();
    // default window is 40 — a verdict just inside it still parses
    expect(
      await parseStructuredOutput(`{"score": 2, "notes": "far", "tags": []}\n${'tail\n'.repeat(20)}`, ReportSchema),
    ).toEqual({ score: 2, notes: 'far', tags: [] });
    expect(
      await parseStructuredOutput(`{"score": 2, "notes": "far", "tags": []}\n${'tail\n'.repeat(45)}`, ReportSchema),
    ).toBeNull();
  });
  it('nullish input returns null', async () => {
    expect(await parseStructuredOutput(null, ReportSchema)).toBeNull();
    expect(await parseStructuredOutput('', ReportSchema)).toBeNull();
  });
});

describe('renderOutputContract (generic)', () => {
  it('renders JSON Schema + examples + outro', () => {
    const text = renderOutputContract(ReportSchema, {
      intro: 'REPORT CONTRACT:',
      examples: ['{"score": 10, "notes": "…", "tags": ["x"]}'],
      outro: 'No prose after the JSON.',
    });
    expect(text).toContain('REPORT CONTRACT:');
    expect(text).toContain('minimum');
    expect(text).toContain('{"score": 10, "notes": "…", "tags": ["x"]}');
    expect(text).toContain('No prose after the JSON.');
  });
  it('default intro mentions the JSON line rule', () => {
    expect(renderOutputContract(ReportSchema)).toContain('exactly one JSON line (no code fence)');
  });
});
