import { describe, expect, it } from 'vitest';

import { NONE_ID } from '../../app/utils/forms.ts';
import {
  activityIcon,
  activityLabel,
  aiOptionLabel,
  AGENT_RUN_VIEW,
  categoryColor,
  categoryIcon,
  categoryLabel,
  categoryText,
  composerPlaceholder,
  dotClass,
  employeeOptions,
  endpointBadgeColor,
  humanizeEnum,
  kindLabel,
  roleLabel,
  runStatus,
  statusLabel,
  verdictLabel,
  waitingOnLabel,
} from '../../app/utils/ui-labels';
import { PROVIDER_ENDPOINT } from '../../shared/api-styles';
import { CATEGORIES, CATEGORY } from '../../shared/enums';

describe('ui-labels', () => {
  it('maps every category in the shared enum to a badge color and label', () => {
    for (const category of CATEGORIES) {
      expect(categoryColor(category)).toMatch(/^(primary|success|warning|error|info|neutral)$/);
      expect(categoryLabel(category)).not.toBe(category);
    }
    expect(categoryColor('done')).toBe('success');
    expect(categoryColor('cancelled')).toBe('error');
    expect(categoryColor('in_review')).toBe('info');
    expect(categoryColor('working')).toBe('warning');
    // one color per category: waiting_answer used to disagree with its own text class
    expect(categoryColor('waiting_answer')).toBe('info');
    expect(categoryColor('ready')).toBe('neutral');
    // retired keys ('todo'/'blocked') are gone — they fall back, they don't map
    expect(categoryColor('blocked')).toBe('neutral');
    expect(categoryColor('custom')).toBe('neutral');
    expect(categoryColor(null)).toBe('neutral');

    expect(categoryLabel('waiting_answer')).toBe('Waiting answer');
    expect(categoryLabel('in_review')).toBe('In review');
    expect(categoryLabel('backlog')).toBe('Backlog');
    // map-miss: humanized, never the raw enum
    expect(categoryLabel('todo')).toBe('Todo');
    expect(categoryLabel('mystery')).toBe('Mystery');
    expect(categoryLabel('IN_FLIGHT')).toBe('In flight');
    expect(categoryLabel(undefined)).toBe('');
  });

  it('humanizes employee kinds', () => {
    expect(kindLabel('ai')).toBe('AI agent');
    expect(kindLabel('human')).toBe('Human');
    expect(kindLabel('other')).toBe('Other');
    expect(kindLabel(null)).toBe('');
  });

  it('statusLabel never leaks a map-miss UUID', () => {
    const byId = new Map([['s1', { name: 'Doing' }]]);
    expect(statusLabel('s1', byId)).toBe('Doing');
    expect(statusLabel('not-a-status', byId)).toBe('Unknown status');
    expect(statusLabel(null, byId)).toBe('Unknown');
  });

  it('renders board/category styling from one shared mapping', () => {
    expect(dotClass('success')).toBe('bg-success');
    expect(dotClass('mystery')).toBe('bg-accented');
    expect(categoryText('done')).toBe('text-success');
    expect(categoryText('mystery')).toBe('text-dimmed');
    expect(categoryText(null)).toBe('text-dimmed');
    expect(categoryIcon('working')).toBe('i-lucide-clock-3');
    expect(categoryIcon('mystery')).toBe('i-lucide-circle-dot');
  });

  it('colors endpoint badges: decision → info, models → success, anthropic wire → warning, else primary', () => {
    expect(endpointBadgeColor('TYPESAFE-SYSTEMONE')).toBe('info');
    expect(endpointBadgeColor('OPENAI-COMPLETIONS')).toBe('primary');
    expect(endpointBadgeColor('ANTHROPIC-MESSAGES')).toBe('warning');
  });

  it('normalizes agent run statuses and shares one label/dot view', () => {
    expect(runStatus('RUNNING')).toBe('running');
    expect(runStatus('done')).toBe('done');
    // unknown/lifecycle-foreign values read as stopped, never crash the map
    expect(runStatus('mystery')).toBe('stopped');
    expect(AGENT_RUN_VIEW.running.label).toBe('Working');
    expect(AGENT_RUN_VIEW.done.run).toBe('Run completed');
    expect(AGENT_RUN_VIEW.running.dot).toContain('animate-pulse');
    expect(AGENT_RUN_VIEW.failed.dot).toBe('bg-error');
    expect(AGENT_RUN_VIEW.cancelled.dot).toBe('bg-accented');
  });

  it('renders activity kinds as words + glyphs with a humanized fallback', () => {
    expect(activityLabel('VERDICT')).toBe('Review verdict');
    expect(activityLabel('note')).toBe('Note');
    expect(activityLabel('weird_kind')).toBe('Weird kind');
    expect(activityIcon('question')).toBe('i-lucide-help-circle');
    expect(activityIcon('forward')).toBe('i-lucide-corner-up-right');
    expect(activityIcon('note')).toBe('i-lucide-message-square');
  });

  it('builds AI picker labels from one helper', () => {
    expect(aiOptionLabel('Ada', 'ai')).toBe('Ada (AI)');
    expect(aiOptionLabel('Ada', 'human')).toBe('Ada');
    expect(aiOptionLabel('Ada', null)).toBe('Ada');
  });
});

describe('ui-labels: null-safe category views + endpoint colors', () => {
  it('null/unknown categories fall back to the neutral dot', () => {
    expect(categoryColor(null)).toBe('neutral');
    expect(categoryColor('nope')).toBe('neutral');
    expect(categoryIcon(null)).toBe('i-lucide-circle-dot');
    expect(categoryIcon(CATEGORY.WORKING)).toBe('i-lucide-clock-3');
  });

  it('humanizeEnum returns the input when nothing survives cleaning', () => {
    expect(humanizeEnum('  ')).toBe('  ');
    expect(humanizeEnum('in_progress')).toBe('In progress');
  });

  it('models endpoints badge success (decision → info is covered above)', () => {
    expect(endpointBadgeColor(PROVIDER_ENDPOINT.MODELS['OPENAI-MODELS'])).toBe('success');
  });
});

describe('ui-labels: composer/roles/verdicts', () => {
  it('composer placeholders are a parallel pair', () => {
    expect(composerPlaceholder(true)).toBe('Write an answer');
    expect(composerPlaceholder(false)).toBe('Write a note');
  });

  it('roleLabel words roles and humanizes unknowns', () => {
    expect(roleLabel('ADMIN')).toBe('Admin');
    expect(roleLabel('weird_role')).toBe('Weird role');
    expect(roleLabel(null)).toBe('');
    expect(roleLabel(undefined)).toBe('');
  });

  it('verdictLabel falls back to Pending on a miss', () => {
    expect(verdictLabel('x')).toBe('Pending');
  });

  it('employeeOptions excludes one id, prepends the none choice, labels AI', () => {
    const rows = [
      { id: 'a', name: 'Ada', kind: 'ai' },
      { id: 'b', name: 'Bob', kind: 'human' },
    ];
    expect(employeeOptions(rows)).toEqual([
      { label: 'Ada (AI)', value: 'a' },
      { label: 'Bob', value: 'b' },
    ]);
    expect(employeeOptions(rows, { noneLabel: 'Unassigned' })[0]).toEqual({
      label: 'Unassigned',
      value: NONE_ID,
    });
    expect(employeeOptions(rows, { excludeId: 'a' }).map((o) => o.value)).toEqual(['b']);
  });

  it('waitingOnLabel names the answer holder, else flags outstanding review approvers', () => {
    // the answer holder wins whenever one exists (waiting-answer category)
    expect(
      waitingOnLabel(
        { questionHolderName: 'Ada', reviewerNames: ['Ada'], reviewApprovals: [] },
        CATEGORY.WAITING_ANSWER,
      ),
    ).toBe('Waiting on Ada');
    // in-review with approvers outstanding → review pending
    expect(
      waitingOnLabel(
        { questionHolderName: null, reviewerNames: ['Ada', 'Bob'], reviewApprovals: ['x'] },
        CATEGORY.IN_REVIEW,
      ),
    ).toBe('Review pending');
    // in-review fully approved → nothing owed
    expect(
      waitingOnLabel(
        { questionHolderName: null, reviewerNames: ['Ada', 'Bob'], reviewApprovals: ['a', 'b'] },
        CATEGORY.IN_REVIEW,
      ),
    ).toBe(null);
    // a non-review category never reads as review pending
    expect(
      waitingOnLabel({ questionHolderName: null, reviewerNames: ['Ada'], reviewApprovals: [] }, CATEGORY.READY),
    ).toBe(null);
    expect(waitingOnLabel({ questionHolderName: null, reviewerNames: [], reviewApprovals: [] }, null)).toBe(null);
  });
});
