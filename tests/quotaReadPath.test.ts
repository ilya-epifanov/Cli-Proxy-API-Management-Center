/**
 * Claude and Codex quota reads must go through the adapter registry
 * (src/features/quota/providers/index.ts). It sends them to the server's rate-limited quota
 * reads (`POST /quota/probes/refresh`) when the server reads quota, and to the provider's direct
 * read otherwise. A caller that reaches a provider's direct read on its own bypasses the
 * server's limit, so only the files below may.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const SRC = new URL('../src/', import.meta.url);

const sources: ReadonlyMap<string, string> = new Map(
  readdirSync(SRC, { recursive: true })
    .map(String)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => [`src/${name}`, readFileSync(new URL(name, SRC), 'utf8')] as const)
);

const filesReferencing = (identifier: string): string[] =>
  [...sources]
    .filter(([, source]) => new RegExp(`\\b${identifier}\\b`).test(source))
    .map(([file]) => file)
    .sort();

describe('Claude and Codex quota read path', () => {
  test('finds the sources', () => {
    expect(sources.has('src/features/quota/providers/index.ts')).toBe(true);
  });

  test.each([
    ['CLAUDE_CONFIG', 'src/features/quota/providers/claude/data.ts'],
    ['CODEX_CONFIG', 'src/features/quota/providers/codex/data.ts'],
  ])('%s reaches the UI only through the registry', (config, definition) => {
    expect(filesReferencing(config)).toEqual(
      [definition, 'src/features/quota/logic.ts', 'src/features/quota/providers/index.ts'].sort()
    );
    // logic.ts classifies files and must not read quota.
    const uses = sources
      .get('src/features/quota/logic.ts')!
      .match(new RegExp(`\\b${config}\\b(\\.\\w+)?`, 'g'));
    expect(uses?.filter((use) => use !== `${config}.filterFn` && use !== config)).toEqual([]);
    expect(uses?.filter((use) => use === config)).toHaveLength(1); // the import
  });

  test.each(['fetchClaudeQuota', 'fetchCodexQuota'])('%s is not exported', (fetcher) => {
    expect(filesReferencing(fetcher)).toHaveLength(1);
    expect([...sources.values()].join('\n')).not.toMatch(
      new RegExp(`export[^\\n]*\\b${fetcher}\\b`)
    );
  });

  test.each([
    ['CLAUDE_USAGE_URL', 'src/features/quota/providers/claude/data.ts'],
    ['CLAUDE_PROFILE_URL', 'src/features/quota/providers/claude/data.ts'],
    ['CODEX_USAGE_URL', 'src/features/quota/providers/codex/data.ts'],
    ['CODEX_SUBSCRIPTION_URL', 'src/features/quota/providers/codex/data.ts'],
    ['CODEX_RATE_LIMIT_RESET_CREDITS_URL', 'src/features/quota/providers/codex/data.ts'],
  ])('%s is read only by its provider', (url, provider) => {
    expect(filesReferencing(url)).toEqual(['src/utils/quota/constants.ts', provider].sort());
  });

  test('Claude reset grant status is read directly only where the server path is handled', () => {
    expect(filesReferencing('ANTHROPIC_RESET_GRANT_STATUS_PATH')).toEqual([
      'src/services/api/claudeResetGrants.ts',
    ]);
    expect(filesReferencing('readClaudeResetGrants')).toEqual([
      // The card reads directly only when the server does not read quota.
      'src/features/quota/providers/claude/ClaudeResetGrants.tsx',
      // Re-checks the grant right before a user-initiated claim spends it.
      'src/features/quota/providers/claude/resetGrantOperations.ts',
      'src/services/api/claudeResetGrants.ts',
    ]);
    expect(sources.get('src/features/quota/providers/claude/ClaudeResetGrants.tsx')).toMatch(
      /serverReads \? Promise\.reject\([^)]*\)\) : readClaudeResetGrants\(authIndex\)/
    );
  });
});
