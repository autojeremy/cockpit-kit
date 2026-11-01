import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expectedCurrentIndex, navFromParsed, parseNav, renderNavItems, syncNavHtml } from '../skill/lib/nav.mjs';
import { parseToml } from '../skill/lib/toml.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const navSync = path.join(repoRoot, 'skill', 'scripts', 'nav-sync.mjs');
const lintScript = path.join(repoRoot, 'skill', 'scripts', 'lint.mjs');

const MANIFEST = `hidden = ["search/"]

[[nav]]
label = "Home"
href = "index.html"

[[nav]]
label = "Food"
href = "food/"
group = "Life"

[[nav]]
label = "Reading"
href = "reading/"
group = "Life"

[[nav]]
label = "Network"
href = "network/"
group = "Ops"
`;

function page(navInner, { body = '<h1>T</h1><p>x</p>' } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="cockpit:source" content="self"><meta name="cockpit:rendered-at" content="2026-07-05T18:00:00Z"><title>T</title></head><body>
  <aside class="rail">
    <a class="brand" href="index.html">Brand</a>
    <nav aria-label="Primary" class="cockpit-nav">
      <form class="nav-search" action="search/" method="get" role="search"><div><input name="q"></div></form>
${navInner}
    </nav>
  </aside>
  <main>${body}</main><script type="application/json" id="cockpit-data">{"kind":"t","schema_version":1}</script></body></html>`;
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-navsync-'));
  fs.mkdirSync(path.join(root, '.cockpit'), { recursive: true });
  fs.writeFileSync(path.join(root, '.cockpit', 'sources.toml'), '');
  fs.writeFileSync(path.join(root, '.cockpit', 'nav.toml'), MANIFEST);
  fs.writeFileSync(path.join(root, 'cockpit.css'), 'body { max-width: 60rem; }\n');
  return root;
}

function write(root, rel, html) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
}

const items = navFromParsed(parseToml(MANIFEST)).items;

test('expectedCurrentIndex maps pages to their top-level section', () => {
  assert.equal(expectedCurrentIndex(items, 'index.html'), 0);
  assert.equal(expectedCurrentIndex(items, 'food/index.html'), 1);
  assert.equal(expectedCurrentIndex(items, 'food/deep/page.html'), 1);
  assert.equal(expectedCurrentIndex(items, 'network/x.html'), 3);
  assert.equal(expectedCurrentIndex(items, 'search/index.html'), -1);
  assert.equal(expectedCurrentIndex(items, 'design-system.html'), -1);
  assert.deepEqual(navFromParsed(parseToml(MANIFEST)).hidden, ['search']);
});

test('renderNavItems emits depth-correct links, groups, and one current marker', () => {
  const out = renderNavItems(items, 'food/deep/page.html', '');
  assert.match(out, /<a href="\.\.\/\.\.\/index\.html">Home<\/a>/);
  assert.match(out, /<a href="\.\.\/\.\.\/food\/" aria-current="page">Food<\/a>/);
  assert.match(out, /<div class="nav-group" role="group" aria-labelledby="nav-group-life">/);
  assert.match(out, /<span class="nav-group-label" id="nav-group-ops">Ops<\/span>/);
  assert.equal((out.match(/aria-current/g) ?? []).length, 1);
});

test('syncNavHtml keeps form and brand, replaces stale links, and is idempotent', () => {
  const stale = page('      <a href="../index.html" aria-current="page">Home</a>\n      <a href="../inbox/">Inbox</a>');
  const once = syncNavHtml(stale, items, 'food/log.html');
  assert.match(once, /<form class="nav-search"/);
  assert.match(once, /<a class="brand" href="index.html">Brand<\/a>/, 'brand outside the nav is untouched');
  assert.doesNotMatch(once, /Inbox/);
  assert.match(once, /<a href="\.\.\/food\/" aria-current="page">Food<\/a>/);
  assert.doesNotMatch(once, /<a href="\.\.\/index\.html" aria-current/);
  assert.equal(syncNavHtml(once, items, 'food/log.html'), once);
  const links = parseNav(once).links;
  assert.deepEqual(links.map((link) => [link.label, link.group ?? null]), [['Home', null], ['Food', 'Life'], ['Reading', 'Life'], ['Network', 'Ops']]);
});

test('syncNavHtml refuses navs with links interleaved with other content', () => {
  const odd = page('      <a href="index.html">Home</a>\n      <p>note</p>\n      <a href="food/">Food</a>');
  assert.throws(() => syncNavHtml(odd, items, 'index.html'), /unexpected text|interleaved/);
});

test('syncNavHtml handles the starter layout with a home brand link inside the nav', () => {
  const plain = [{ label: 'Inbox', href: 'inbox/' }, { label: 'Search', href: 'search/' }];
  const html = `<html><body><nav aria-label="Primary" class="cockpit-nav">
    <a class="home" href="./" aria-current="page">Cockpit</a>
    <a href="inbox/">Inbox</a>
    <fieldset class="theme-switch"><legend>Theme</legend></fieldset>
  </nav></body></html>`;
  const root = syncNavHtml(html, plain, 'index.html');
  assert.match(root, /<a class="home" href="\.\/" aria-current="page">Cockpit<\/a>/);
  assert.match(root, /<a href="search\/">Search<\/a>\n    <fieldset/);
  const nested = syncNavHtml(html, plain, 'inbox/index.html');
  assert.match(nested, /<a class="home" href="\.\.\/">Cockpit<\/a>/);
  assert.match(nested, /<a href="\.\.\/inbox\/" aria-current="page">Inbox<\/a>/);
});

test('nav-sync script rewrites pages, --check reports drift, and lint accepts the result', () => {
  const root = makeRoot();
  write(root, 'index.html', page('      <a href="index.html" aria-current="page">Home</a>'));
  write(root, 'food/index.html', page('      <a href="../index.html" aria-current="page">Home</a>', { body: '<h1>Food</h1><p><a href="log.html">Log</a></p>' }));
  write(root, 'food/log.html', page('      <a href="../index.html" aria-current="page">Home</a>'));
  write(root, 'search/index.html', page('      <a href="../index.html" aria-current="page">Home</a>'));

  const before = spawnSync(process.execPath, [lintScript, '--root', root, '--json'], { encoding: 'utf8' });
  const codes = JSON.parse(before.stdout).findings.map((item) => item.code);
  assert.ok(codes.includes('stale-nav'));

  const check = spawnSync(process.execPath, [navSync, '--root', root, '--check'], { encoding: 'utf8' });
  assert.equal(check.status, 1, check.stderr);
  assert.match(check.stdout, /would change 4 page/);

  const run = spawnSync(process.execPath, [navSync, '--root', root], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const again = spawnSync(process.execPath, [navSync, '--root', root, '--check'], { encoding: 'utf8' });
  assert.equal(again.status, 0, again.stdout);
  assert.match(again.stdout, /would change 0 page/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'search/index.html'), 'utf8'), /aria-current/);

  const after = spawnSync(process.execPath, [lintScript, '--root', root, '--json'], { encoding: 'utf8' });
  const navCodes = JSON.parse(after.stdout).findings.map((item) => item.code).filter((code) => /nav|current/.test(code));
  assert.deepEqual(navCodes, []);
});

test('lint flags a non-home page that marks Home current', () => {
  const root = makeRoot();
  const synced = syncNavHtml(page('      <a href="index.html">Home</a>'), items, 'food/log.html');
  const wrong = synced.replace(' aria-current="page"', '').replace('<a href="../index.html">', '<a href="../index.html" aria-current="page">');
  write(root, 'food/log.html', wrong);
  const result = spawnSync(process.execPath, [lintScript, '--root', root, '--json'], { encoding: 'utf8' });
  assert.ok(JSON.parse(result.stdout).findings.some((item) => item.code === 'current-is-home' && item.path === 'food/log.html'));
});
