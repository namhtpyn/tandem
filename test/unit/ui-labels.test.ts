import { describe, expect, it } from 'vitest';

import { formatWhen } from '../../app/utils/format-when';
import {
  categoryColor,
  categoryIcon,
  categoryLabel,
  categoryText,
  dotClass,
  endpointBadgeColor,
  kindLabel,
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
});
