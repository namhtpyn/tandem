import { describe, expect, it } from 'vitest';

import { formatDate, formatWhen } from '../../app/utils/format-when';
import { categoryColor, categoryLabel, kindLabel } from '../../app/utils/ui-labels';

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
    expect(categoryLabel('mystery')).toBe('mystery');
    expect(categoryLabel(undefined)).toBe('');
  });

  it('humanizes employee kinds', () => {
    expect(kindLabel('ai')).toBe('AI agent');
    expect(kindLabel('human')).toBe('Human');
    expect(kindLabel('other')).toBe('other');
    expect(kindLabel(null)).toBe('');
  });
});

describe('formatDate', () => {
  it('renders date-only and tolerates junk', () => {
    const d = new Date(2026, 9, 27, 14, 30);
    expect(formatDate(d)).toBe(d.toLocaleDateString());
    expect(formatWhen(d)).toBe(d.toLocaleString());
    expect(formatDate(null)).toBe('');
    expect(formatDate('not-a-date')).toBe('');
  });
});
