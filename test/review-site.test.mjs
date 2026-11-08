import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function rootFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-review-'));
  fs.mkdirSync(path.join(root, '.cockpit'));
  fs.writeFileSync(path.join(root, '.cockpit', 'sources.toml'), '');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for test condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

import { isMovedStub, siteFindings } from '../skill/lib/site-checks.mjs';
import { syncHomeHtml, HOME_CARDS_START, HOME_CARDS_END } from '../skill/lib/home.mjs';
import { tryAcquire, releaseLock } from '../skill/lib/lock.mjs';
const nav = { present: true, items: [], hidden: [] };
function findings(root, html) { return siteFindings({ root, pages: [{ pagePath: 'index.html', html }], nav }); }

test('malformed cards produce findings instead of aborting either card loop', (t) => {
  const root = rootFor(t);
  const cards = [null, 3, 'card', [], {}, { href: null, title: 'Bad' }, { href: 'missing/', title: 'Valid' }];
  const result = findings(root, `<script id="cockpit-data">${JSON.stringify({ cards })}</script>`);
  assert.equal(result.filter((f) => f.code === 'invalid-home-card').length, 6);
  assert.ok(result.some((f) => /Valid.*does not exist/.test(f.message)));
});

test('refresh reloads are live pages; only nonempty redirect URLs indicate moved stubs', () => {
  for (const content of ['60', '0; url=', "0; url=''", '0; url=   ']) {
    assert.equal(isMovedStub(`<meta http-equiv="refresh" content="${content}">`), false);
  }
  assert.equal(isMovedStub("<meta content='0; URL=next.html' http-equiv='refresh'>"), true);
  assert.equal(isMovedStub('<meta name="cockpit:moved-to" content="next.html">'), true);
});

test('live refreshing pages still contribute inbound content links', (t) => {
  const root = rootFor(t);
  const pages = [
    { pagePath: 'index.html', html: '<meta http-equiv="refresh" content="60"><a href="notes/detail.html">Detail</a>' },
    { pagePath: 'notes/detail.html', html: '' },
  ];
  assert.deepEqual(siteFindings({ root, pages, nav }), []);
});

test('single-quoted visible cards and entity-encoded hrefs match home data', (t) => {
  const root = rootFor(t);
  const html = `<main><a href='https://example.test/?a=1&amp;b=2' class='wide card'><h3>Notes &amp; drafts</h3></a></main>
    <script id="cockpit-data">{"cards":[{"href":"https://example.test/?a=1&b=2","title":"Notes & drafts"}]}</script>`;
  assert.deepEqual(findings(root, html), []);
});

test('nonconsecutive home groups preserve HTML and JSON card order with no drift', (t) => {
  const root = rootFor(t);
  const cards = ['Life', 'Work', 'Life'].map((group, i) => ({ group, title: `Card ${i}`, href: `https://example.test/${i}`, body: "", tags: [] }));
  const original = `<main>${HOME_CARDS_START}${HOME_CARDS_END}</main><script id="cockpit-data">{}</script>`;
  const html = syncHomeHtml(original, cards);
  assert.deepEqual([...html.matchAll(/<h3>(.*?)<\/h3>/g)].map((m) => m[1]), cards.map((c) => c.title));
  assert.equal((html.match(/>Life<\/h2>/g) ?? []).length, 2);
  const matchingNav = { present: true, hidden: [], items: cards.map((c) => ({ label: c.title, href: c.href, group: c.group, summary: "" })) };
  assert.deepEqual(siteFindings({ root, pages: [{ pagePath: "index.html", html }], nav: matchingNav }), []);
});

test('home-sync reads the latest nav and home only after waiting for the writer', { timeout: 10000 }, async (t) => {
  const root = rootFor(t);
  const file = path.join(root, 'index.html');
  const manifest = path.join(root, '.cockpit', 'nav.toml');
  const original = `<main>${HOME_CARDS_START}${HOME_CARDS_END}</main><script id="cockpit-data">{}</script>`;
  fs.writeFileSync(file, original);
  fs.writeFileSync(manifest, '[[nav]]\nlabel = "Old"\nhref = "old/"\n');
  tryAcquire(root, { holder: 'writer' });
  const script = path.resolve(import.meta.dirname, '../skill/scripts/home-sync.mjs');
  const child = spawn(process.execPath, [script, '--root', root, '--lock-wait', '5s'], { env: { ...process.env, COCKPIT_LOCK_HOLDER: '' } });
  const done = once(child, 'close');
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; }); child.stdout.resume();
  t.after(() => child.kill('SIGTERM'));
  await until(() => /waiting up to/.test(stderr));
  fs.writeFileSync(file, '<!-- latest edit -->' + original);
  fs.writeFileSync(manifest, '[[nav]]\nlabel = "New"\nhref = "new/"\n');
  releaseLock(root, { holder: 'writer' });
  assert.equal((await done)[0], 0, stderr);
  const result = fs.readFileSync(file, 'utf8');
  assert.match(result, /latest edit/);
  assert.match(result, /<h3>New<\/h3>/);
  assert.doesNotMatch(result, /<h3>Old<\/h3>/);
});
