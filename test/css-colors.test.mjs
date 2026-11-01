import test from 'node:test';
import assert from 'node:assert/strict';
import { hardcodedColorFindings, stripPrintMedia } from '../skill/lib/css-colors.mjs';
import { checkPage } from '../skill/lib/contract.mjs';

test('flags literal colors in ordinary declarations', () => {
  const f = hardcodedColorFindings('.a { color: #b91c1c; } .b { background: rgba(0,0,0,.1); } .c { border: 1px solid white; }');
  assert.equal(f.length, 3);
  assert.ok(f.every((x) => x.code === 'hardcoded-color'));
  assert.match(f[0].message, /color: #b91c1c/);
});

test('allows theme tokens, keywords and url fragments', () => {
  assert.deepEqual(hardcodedColorFindings('.a { color: var(--ok); background: transparent; border-color: currentColor; marker-end: url(#bad); }'), []);
});

test('ignores @media print blocks, including nested rules', () => {
  const css = '@media print { html, body { background: #fff !important; } .card { border-color: #ccc; } } .x { color: var(--ink); }';
  assert.deepEqual(hardcodedColorFindings(css), []);
  assert.equal(stripPrintMedia(css).trim(), '.x { color: var(--ink); }');
});

test('custom-property literals need a dark-theme definition', () => {
  assert.equal(hardcodedColorFindings(':root { --brand: #123456; } .a { color: var(--brand); }').length, 1);
  assert.deepEqual(hardcodedColorFindings(':root { --brand: #123456; } :root[data-theme="dark"] { --brand: #abcdef; }'), []);
  assert.deepEqual(hardcodedColorFindings(':root { --brand: #123456; } @media (prefers-color-scheme: dark) { :root { --brand: #abcdef; } }'), []);
});

test('ignores comments and reports each declaration once', () => {
  assert.deepEqual(hardcodedColorFindings('/* color: #fff */ .a { color: var(--ink); }'), []);
  assert.equal(hardcodedColorFindings('.a { color: #fff; } .b { color: #fff; }').length, 1);
});

test('checkPage reports hardcoded-color as a warning', () => {
  const html = '<!doctype html><html><head><meta name="cockpit:source" content="self"><style>.risk { border-left: 3px solid #b6473e; }</style></head><body></body></html>';
  const { warnings, errors } = checkPage({ pagePath: 'x.html', html, navItems: [] });
  assert.ok(warnings.some((w) => w.code === 'hardcoded-color'));
  assert.ok(!errors.some((e) => e.code === 'hardcoded-color'));
});
