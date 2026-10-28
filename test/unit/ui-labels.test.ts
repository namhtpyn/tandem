import { describe, expect, it } from 'vitest';

import {
  activityIcon,
  activityLabel,
  aiOptionLabel,
  categoryColor,
  categoryIcon,
  categoryLabel,
  categoryText,
  dotClass,
  endpointBadgeColor,
  kindLabel,
  runStatus,
  AGENT_RUN_VIEW,
  statusLabel,
} from '../../app/utils/ui-labels';

describe('ui-labels', () => {
  it('maps every seeded category to a badge color and label', () => {
    expect(categoryColor('done')).toBe('success');
    expect(categoryColor('cancelled')).toBe('error');
    expect(categoryColor('blocked')).toBe('error');
    expect(categoryColor('in_review')).toBe('info');
    expect(categoryColor('working')).toBe('warning');
    expect(categoryColor('waiting_answer')).toBe('warning');
    expect(categoryColor('todo')).toBe('neutral');
    expect(categoryColor('custom')).toBe('neutral');
    expect(categoryColor(null)).toBe('neutral');

    expect(categoryLabel('waiting_answer')).toBe('Waiting answer');
    expect(categoryLabel('in_review')).toBe('In review');
    expect(categoryLabel('todo')).toBe('To do');
    // map-miss: humanized, never the raw enum
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
    expect(activityIcon('note')).toBe('i-lucide-info');
  });

  it('builds AI picker labels from one helper', () => {
    expect(aiOptionLabel('Ada', 'ai')).toBe('Ada (AI)');
    expect(aiOptionLabel('Ada', 'human')).toBe('Ada');
    expect(aiOptionLabel('Ada', null)).toBe('Ada');
  });
});
