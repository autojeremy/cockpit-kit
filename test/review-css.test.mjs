import test from 'node:test';
import assert from 'node:assert/strict';
import { hardcodedColorFindings } from '../skill/lib/css-colors.mjs';

test('dark exemptions apply only to properties defined in a dark context', () => {
  const css = ':root { --brand: #fff; --paired: #123; } :root[data-theme="dark"] { --other: #000; --paired: var(--ink); }';
  const result = hardcodedColorFindings(css);
  assert.equal(result.length, 1);
  assert.match(result[0].message, /--brand:/);
});

test('nested dark media carries context, but sibling rules do not inherit it', () => {
  const css = ':root { --brand: #fff; --paired: #123; } @media screen { @media (prefers-color-scheme: dark) { :root { --paired: #456; } } :root { --light-only: #789; } }';
  const result = hardcodedColorFindings(css);
  assert.equal(result.length, 2);
  assert.ok(result.some((f) => /--brand:/.test(f.message)));
  assert.ok(result.some((f) => /--light-only:/.test(f.message)));
});
