import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isMovedStub, resolveLink } from '../skill/lib/site-checks.mjs';
import { decodeEntities } from '../skill/lib/nav.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const lintScript = path.join(repoRoot, 'skill', 'scripts', 'lint.mjs');
const indexScript = path.join(repoRoot, 'skill', 'scripts', 'search-index.mjs');
const navSync = path.join(repoRoot, 'skill', 'scripts', 'nav-sync.mjs');

function page({ title = 'T', body = '<h1>T</h1>', data = '{"kind":"t","schema_version":1}', head = '' } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="cockpit:source" content="self"><meta name="cockpit:rendered-at" content="2026-07-05T18:00:00Z">${head}<title>${title}</title></head><body><nav class="cockpit-nav"><a href="index.html">Home</a></nav><main>${body}</main><footer><a href="design.html">Design</a></footer><script type="application/json" id="cockpit-data">${data}</script></body></html>`;
}

function makeRoot(manifest) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-site-'));
  fs.mkdirSync(path.join(root, '.cockpit'), { recursive: true });
  fs.writeFileSync(path.join(root, '.cockpit', 'sources.toml'), '');
  fs.writeFileSync(path.join(root, '.cockpit', 'nav.toml'), manifest);
  fs.writeFileSync(path.join(root, 'cockpit.css'), 'body { max-width: 60rem; }\n');
  return root;
}

function write(root, rel, html) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), html);
}

function lint(root) {
  spawnSync(process.execPath, [navSync, '--root', root], { encoding: 'utf8' });
  spawnSync(process.execPath, [indexScript, '--root', root], { encoding: 'utf8' });
  const result = spawnSync(process.execPath, [lintScript, '--root', root, '--json', '--strict'], { encoding: 'utf8' });
  return { status: result.status, findings: JSON.parse(result.stdout).findings };
}

const MANIFEST = 'hidden = ["search/"]\n\n[[nav]]\nlabel = "Home"\nhref = "index.html"\n\n[[nav]]\nlabel = "Food"\nhref = "food/"\n\n[[nav]]\nlabel = "Inbox"\nhref = "inbox/"\nhome = false\n';
const HOME_DATA = '{"kind":"home","schema_version":1,"cards":[{"title":"Food","href":"food/"}]}';

function healthyRoot() {
  const root = makeRoot(MANIFEST);
  write(root, 'index.html', page({ body: '<h1>Home</h1><a class="card" href="food/"><h3>Food</h3></a>', data: HOME_DATA }));
  write(root, 'design.html', page({ title: 'Design' }));
  write(root, 'food/index.html', page({ title: 'Food &amp; drink', body: '<h1>Food</h1><a href="log.html">Log</a>' }));
  write(root, 'food/log.html', page({ title: 'Log' }));
  write(root, 'inbox/index.html', page({ title: 'Inbox' }));
  write(root, 'search/index.html', page({ title: 'Search' }));
  return root;
}

test('a well-linked root passes the site checks', () => {
  const { status, findings } = lint(healthyRoot());
  assert.deepEqual(findings, []);
  assert.equal(status, 0);
});

test('unregistered-section flags top-level folders missing from nav and hidden', () => {
  const root = healthyRoot();
  write(root, 'garden/index.html', page({ title: 'Garden' }));
  const { findings } = lint(root);
  assert.ok(findings.some((f) => f.code === 'unregistered-section' && f.path === 'garden/index.html'));
  assert.ok(!findings.some((f) => f.code === 'unregistered-section' && f.path === 'search/index.html'));
});

test('missing-home-card and home-data-drift catch stale home pages', () => {
  const root = healthyRoot();
  write(root, 'index.html', page({ body: '<h1>Home</h1><a class="card" href="food/"><h3>Food log</h3></a>', data: '{"kind":"home","schema_version":1,"cards":[{"title":"Food","href":"food/"},{"title":"Garden","href":"garden/"}]}' }));
  let { findings } = lint(root);
  const drift = findings.filter((f) => f.code === 'home-data-drift').map((f) => f.message).join('\n');
  assert.match(drift, /in data only: Food \(food\/\), Garden \(garden\/\)/);
  assert.match(drift, /visible only: Food log/);
  assert.match(drift, /"Garden" points to garden\/, which does not exist/);
  write(root, 'index.html', page({ body: '<h1>Home</h1>' }));
  ({ findings } = lint(root));
  assert.ok(findings.some((f) => f.code === 'missing-home-card' && /"Food"/.test(f.message)));
  assert.ok(!findings.some((f) => f.code === 'missing-home-card' && /"Inbox"/.test(f.message)), 'home = false opts out');
});

test('orphan-page flags unlinked pages but not section indexes, stubs, or footer-linked root pages', () => {
  const root = healthyRoot();
  write(root, 'food/secret.html', page({ title: 'Secret' }));
  write(root, 'food/old.html', page({ title: 'Old (moved)', head: '<meta http-equiv="refresh" content="0; url=log.html">', data: '{"kind":"moved","schema_version":1,"moved_to":"log.html"}' }));
  const { findings } = lint(root);
  const orphans = findings.filter((f) => f.code === 'orphan-page').map((f) => f.path);
  assert.deepEqual(orphans, ['food/secret.html']);
});

test('search-index uses nav labels for sections, decodes entities, and skips moved stubs', () => {
  const root = healthyRoot();
  write(root, 'food/old.html', page({ title: 'Old', data: '{"kind":"moved","schema_version":1,"moved_to":"log.html"}' }));
  const { findings } = lint(root);
  assert.deepEqual(findings, []);
  const index = JSON.parse(fs.readFileSync(path.join(root, '.cockpit', 'search-index.json'), 'utf8'));
  const byPath = Object.fromEntries(index.pages.map((p) => [p.path, p]));
  assert.equal(byPath['food/old.html'], undefined);
  assert.equal(byPath['food/log.html'].section, 'Food');
  assert.equal(byPath['search/index.html'].section, 'Search');
  assert.equal(byPath['design.html'].section, '');
  assert.equal(byPath['food/index.html'].title, 'Food & drink');
});

test('helpers: stub detection, link resolution, entity decoding', () => {
  assert.equal(isMovedStub('<meta name="cockpit:moved-to" content="x.html">'), true);
  assert.equal(isMovedStub('<script type="application/json" id="cockpit-data">{"kind":"note"}</script>'), false);
  const root = healthyRoot();
  assert.equal(resolveLink(root, 'food/log.html', '../index.html'), 'index.html');
  assert.equal(resolveLink(root, 'food/log.html', './'), 'food/index.html');
  assert.equal(resolveLink(root, 'index.html', '/food'), 'food/index.html');
  assert.equal(resolveLink(root, 'index.html', 'https://example.net/'), undefined);
  assert.equal(decodeEntities('Isaiah&#x27;s &amp; Widow&#39;s &rsquo; &bogus;'), "Isaiah's & Widow's ’ &bogus;");
});
