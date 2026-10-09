import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { UsageTable } from '@/features/usage/UsageTable';
import { buildUsageTree, ZERO_COUNTERS } from '@/features/usage/usageModel';
import type { AuthIndex, UsageCounters, UsageTotalsRow } from '@/services/api/usageHistory';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

const row = (
  provider: string,
  authIndex: string,
  model: string,
  values: Partial<UsageCounters>
): UsageTotalsRow => ({
  provider,
  authIndex: authIndex as AuthIndex,
  model,
  ...ZERO_COUNTERS,
  ...values,
});

const render = (rows: UsageTotalsRow[]) =>
  renderToStaticMarkup(
    createElement(UsageTable, {
      tree: buildUsageTree(rows),
      labelOf: (node) => ({
        primary: `label:${node.key}`,
        secondary: node.level === 'account' ? `id:${node.key}` : null,
      }),
    })
  );

describe('usage breakdown table', () => {
  test('shows providers expanded and accounts collapsed at first', () => {
    const html = render([row('claude', 'a1', 'claude-fable-5', { input: 10, requests: 1 })]);
    expect(html).toContain('label:claude');
    expect(html).toContain('label:a1');
    expect(html).toContain('id:a1');
    expect(html).not.toContain('label:claude-fable-5');
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(1);
  });

  test('adds the Unclassified column only when some tokens are unclassified', () => {
    const classified = render([row('claude', 'a1', 'm', { input: 10 })]);
    expect(classified).not.toContain('Unclassified');
    const unclassified = render([row('claude', 'a1', 'm', { input: 10, unclassified: 3 })]);
    expect(unclassified).toContain('Unclassified');
  });

  test('explains every column header and keeps exact values of compacted numbers', () => {
    const html = render([row('claude', 'a1', 'm', { cacheRead: 1_234_567 })]);
    expect(html).toContain('title="Input tokens read from the prompt cache"');
    expect(html).toContain('title="1,234,567"');
    expect(html).toContain('1.2M');
  });
});
