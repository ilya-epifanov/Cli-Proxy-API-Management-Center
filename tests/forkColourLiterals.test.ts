/**
 * Fork modules take colours only from custom properties (docs/frontend-design.md §13.1):
 * src/styles/fork-tokens.scss and the theme's own properties. A literal colour would ignore
 * the theme switch and skip the palette validation recorded in fork-tokens.scss.
 */

import { readdirSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

/** Feature directories written for the fork; add new ones here. */
const FORK_FEATURE_DIRS = ['src/features/usage'];

const NAMED_COLOURS =
  'black|white|red|green|blue|gray|grey|orange|yellow|purple|pink|brown|cyan|magenta|navy|teal';
const COLOUR_LITERALS = [
  /#[0-9a-fA-F]{3,8}\b/,
  /\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/,
  new RegExp(
    `\\b(?:color|background(?:-color)?|border(?:-[a-z]+)*|outline(?:-color)?|fill|stroke)\\s*:[^;]*\\b(?:${NAMED_COLOURS})\\b`
  ),
];

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const literalLines = (source: string): string[] =>
  stripComments(source)
    .split('\n')
    .filter((line) => COLOUR_LITERALS.some((pattern) => pattern.test(line)))
    .map((line) => line.trim());

describe('fork colour literals', () => {
  for (const dir of FORK_FEATURE_DIRS) {
    const files = readdirSync(new URL(`../${dir}`, import.meta.url), { recursive: true })
      .map(String)
      .filter((name) => /\.(scss|tsx?)$/.test(name));

    test(`${dir} has style sources to check`, () => {
      expect(files.length).toBeGreaterThan(0);
    });

    for (const name of files) {
      test(`${dir}/${name} uses no literal colours`, async () => {
        const source = await Bun.file(new URL(`../${dir}/${name}`, import.meta.url)).text();
        expect(literalLines(source)).toEqual([]);
      });
    }
  }

  test.each([
    ['a hex colour', 'background: #1d1b18;'],
    ['an rgba() colour', 'box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);'],
    ['a named colour', 'border-top: 1px solid white;'],
  ])('flags %s', (_name, line) => {
    expect(literalLines(line)).toEqual([line]);
  });

  test.each([
    ['a custom property', 'background: var(--series-1);'],
    ['transparent', 'border-top: 2px solid transparent;'],
    ['SCSS interpolation', 'margin-left: calc(var(--y-axis-width) + #{$spacing-sm});'],
    ['a commented colour', '/* light surface #f0eee8 */'],
  ])('allows %s', (_name, line) => {
    expect(literalLines(line)).toEqual([]);
  });
});
