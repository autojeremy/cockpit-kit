import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const lintScript = path.join(repoRoot, 'scripts', 'lint.mjs');
const indexScript = path.join(repoRoot, 'scripts', 'search-index.mjs');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function run(script, args, env = process.env) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, env, encoding: 'utf8' });
}

function makeRoot() {
  const root = tempDir('cockpit-lint-root-');
  fs.mkdirSync(path.join(root, '.cockpit'), { recursive: true });
  fs.writeFileSync(path.join(root, '.cockpit', 'sources.toml'), '');
  fs.writeFileSync(path.join(root, '.cockpit', 'nav.toml'), '[[nav]]\nlabel = "Inbox"\nhref = "inbox/"\n');
  fs.writeFileSync(path.join(root, 'cockpit.css'), 'body { max-width: 60rem; }\n');
  return root;
}

function page({ title = 'Home', source = 'self', renderedAt = '2026-07-05T18:00:00Z', viewport = 'width=device-width, initial-scale=1', nav = '<nav><a href="inbox/" aria-current="page">Inbox</a></nav>', data = '{"kind":"test-page","schema_version":1,"summary":"Starter summary"}', body = '<h1>Home</h1><p>Useful body text.</p>', css = '', href = './cockpit.css' } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="${viewport}"><meta name="cockpit:source" content="${source}"><meta name="cockpit:rendered-at" content="${renderedAt}"><title>${title}</title><link rel="stylesheet" href="${href}"><style>${css}</style></head><body>${nav}<main>${body}</main><footer>Footer Token ghp-footersecret1234567890</footer><script type="application/json" id="cockpit-data">${data}</script><script>window.skipMe = 'secret';</script></body></html>`;
}

function writePage(root, rel, html) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html, 'utf8');
}

function lintJson(root, extra = []) {
  const result = run(lintScript, ['--root', root, '--json', ...extra]);
  return { result, payload: result.stdout ? JSON.parse(result.stdout) : undefined };
}

test('lint reports page contract errors and strict fails warning-only roots', () => {
  const root = makeRoot();
  writePage(root, 'index.html', page({ nav: '<nav><a href="inbox/">Inbox</a></nav>' }));

  const warning = lintJson(root);
  assert.equal(warning.result.status, 0, warning.result.stderr);
  assert.equal(warning.payload.findings.some((item) => item.code === 'no-aria-current'), true);
  assert.equal(warning.payload.findings.some((item) => item.code === 'missing-search-index'), true);

  const strict = lintJson(root, ['--strict']);
  assert.equal(strict.result.status, 1);

  writePage(root, 'bad.html', page({ source: 'elsewhere', data: '{ bad', css: 'article { width: 400px; }', href: 'https://cdn.example.test/site.css' }));
  const failed = lintJson(root);
  const codes = new Set(failed.payload.findings.map((item) => item.code));
  assert.equal(failed.result.status, 1);
  assert.equal(codes.has('invalid-source-value'), true);
  assert.equal(codes.has('invalid-data-block-json'), true);
  assert.equal(codes.has('fixed-pixel-width'), true);
  assert.equal(codes.has('external-stylesheet'), true);
});

test('lint accepts common viewport scale decimals', () => {
  const root = makeRoot();
  writePage(root, 'index.html', page({ viewport: 'width=device-width, initial-scale=1.0' }));
  const result = lintJson(root);
  assert.equal(result.payload.findings.some((item) => item.code === 'invalid-viewport'), false);
});

test('shared stylesheet fixed-width findings are reported once', () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, 'cockpit.css'), '.wide { width: 640px; }\n');
  writePage(root, 'index.html', page());
  writePage(root, 'inbox/index.html', page({ title: 'Inbox' }));
  const result = lintJson(root);
  const fixedWidth = result.payload.findings.filter((item) => item.code === 'fixed-pixel-width' && item.path === 'cockpit.css');
  assert.equal(fixedWidth.length, 1);
});

test('starter template passes strict lint after generated index', () => {
  const root = tempDir('cockpit-starter-root-');
  fs.cpSync(path.join(repoRoot, 'templates', 'cockpit-root'), root, { recursive: true });
  const generated = run(indexScript, ['--root', root]);
  assert.equal(generated.status, 0, generated.stderr);
  const linted = run(lintScript, ['--root', root, '--strict', '--json']);
  assert.equal(linted.status, 0, linted.stderr);
  assert.equal(JSON.parse(linted.stdout).findings.length, 0);
});

test('search-index refuses unvalidated roots', () => {
  const root = tempDir('cockpit-invalid-root-');
  const result = run(indexScript, ['--root', root]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing \.cockpit/);
});

test('search-index output is deterministic and omits private fields', () => {
  const root = makeRoot();
  writePage(root, 'index.html', page({ body: '<h1>Home</h1><p>token = ghp-supersecret1234567890</p>' }));
  const first = run(indexScript, ['--root', root]);
  assert.equal(first.status, 0, first.stderr);
  const one = fs.readFileSync(path.join(root, '.cockpit', 'search-index.json'), 'utf8');
  const second = run(indexScript, ['--root', root]);
  assert.equal(second.status, 0, second.stderr);
  const two = fs.readFileSync(path.join(root, '.cockpit', 'search-index.json'), 'utf8');
  assert.equal(two, one);
  const payload = JSON.parse(one);
  assert.equal(payload.generated_at, '2026-07-05T18:00:00Z');
  assert.equal(Object.hasOwn(payload, 'root'), false);
  assert.equal(Object.hasOwn(payload.pages[0], 'tags'), false);
  assert.equal(payload.pages[0].text.includes('ghp-supersecret'), false);
  assert.match(payload.pages[0].text, /\[REDACTED\]/);
});

test('search-index covers nested pages, exclusions, skipped text, and text caps', () => {
  const root = makeRoot();
  const longText = 'alpha '.repeat(4000);
  writePage(root, 'index.html', page({ body: `<h1>Home</h1><p>${longText}</p><nav>NavSkip</nav>` }));
  writePage(root, 'projects/deep/index.html', page({ title: 'Deep', nav: '<nav><a href="../../inbox/" aria-current="page">Inbox</a></nav>', body: '<h1>Deep Page</h1><p>Nested body</p>' }));
  writePage(root, 'attachments/hidden.html', page({ title: 'Hidden' }));
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  writePage(root, 'node_modules/pkg/ignored.html', page({ title: 'Ignored' }));
  const outside = tempDir('cockpit-outside-pages-');
  fs.writeFileSync(path.join(outside, 'outside.html'), page({ title: 'Outside' }), 'utf8');
  fs.symlinkSync(path.join(outside, 'outside.html'), path.join(root, 'outside-link.html'));
  fs.symlinkSync(outside, path.join(root, 'outside-dir'));
  fs.symlinkSync(root, path.join(root, 'loop'));

  const result = run(indexScript, ['--root', root]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(fs.readFileSync(path.join(root, '.cockpit', 'search-index.json'), 'utf8'));
  assert.deepEqual(payload.pages.map((item) => item.path), ['index.html', 'projects/deep/index.html']);
  assert.equal(payload.pages.some((item) => item.path === '.cockpit/search-index.json'), false);
  assert.equal(payload.pages[0].text.includes('NavSkip'), false);
  assert.equal(payload.pages[0].text.length <= 12000, true);
  assert.equal(payload.pages[1].href, '/projects/deep/');
});

test('lint and search-index accept hyphen-prefixed root paths with end-of-options escape', () => {
  const rootName = `-cockpit-lint-${process.pid}-${Date.now()}`;
  const root = path.join(repoRoot, rootName);
  try {
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(root, '.cockpit'));
    fs.writeFileSync(path.join(root, '.cockpit', 'sources.toml'), '');
    fs.writeFileSync(path.join(root, '.cockpit', 'nav.toml'), '[[nav]]\nlabel = "Inbox"\nhref = "inbox/"\n');
    fs.writeFileSync(path.join(root, 'cockpit.css'), 'body { max-width: 60rem; }\n');
    writePage(root, 'index.html', page());

    const indexed = run(indexScript, ['--root', '--', rootName]);
    assert.equal(indexed.status, 0, indexed.stderr);
    const linted = run(lintScript, ['--root', '--', rootName, '--json']);
    assert.equal(linted.status, 0, linted.stderr);
    assert.equal(JSON.parse(linted.stdout).page_count, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lint warns for invalid and stale search indexes', () => {
  const root = makeRoot();
  writePage(root, 'index.html', page());
  fs.writeFileSync(path.join(root, '.cockpit', 'search-index.json'), '{ nope');
  assert.equal(lintJson(root).payload.findings.some((item) => item.code === 'invalid-search-index'), true);

  fs.writeFileSync(path.join(root, '.cockpit', 'search-index.json'), JSON.stringify({ kind: 'cockpit-search-index', schema_version: 1, generated_at: '2026-07-05T18:00:00Z', page_count: 0, pages: [] }));
  assert.equal(lintJson(root).payload.findings.some((item) => item.code === 'stale-search-index'), true);

  fs.writeFileSync(path.join(root, '.cockpit', 'search-index.json'), JSON.stringify({ kind: 'cockpit-search-index', schema_version: 1, generated_at: '2026-07-04T18:00:00Z', page_count: 1, pages: [{ path: 'index.html' }] }));
  assert.equal(lintJson(root).payload.findings.filter((item) => item.code === 'stale-search-index').length > 0, true);
});
