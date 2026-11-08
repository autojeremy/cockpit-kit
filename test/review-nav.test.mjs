import test from 'node:test';
import assert from 'node:assert/strict';
import { renderNavItems, syncNavHtml, parseNav } from '../skill/lib/nav.mjs';
import { checkPage } from '../skill/lib/contract.mjs';

test('nested nav preserves absolute, protocol-relative and root-relative hrefs', () => {
  const html = renderNavItems([
    { label: 'External', href: 'https://example.test/' },
    { label: 'Protocol', href: '//example.test/' },
    { label: 'Root', href: '/notes/' },
    { label: 'Notes', href: 'notes/' },
  ], 'notes/detail.html');
  assert.match(html, /href="https:\/\/example.test\/"/);
  assert.match(html, /href="\/\/example.test\/"/);
  assert.match(html, /href="\/notes\/"/);
  assert.match(html, /href="\.\.\/notes\/"/);
});

test('every repeated or colliding nav group has a unique label reference', () => {
  const items = ['Work-Life', 'Work Life', 'Work-Life', '日本語', '中文'].map((group, index) => ({ group, label: `Item ${index}`, href: `item-${index}/` }));
  const html = renderNavItems(items, 'index.html');
  const ids = [...html.matchAll(/ id="([^"]*)"/g)].map((m) => m[1]);
  const refs = [...html.matchAll(/aria-labelledby="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(ids.length, items.length);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(refs, ids);
});

test('brand rewrite accepts single quotes and unquoted attributes without duplicate current markers', () => {
  const items = [{ label: 'Notes', href: 'notes/' }];
  for (const attrs of ["class='home' href='./' aria-current='page'", 'class=brand href=./ aria-current=page']) {
    const original = `<nav><a ${attrs}>Home</a><a href='notes/'>Notes</a></nav>`;
    const nested = syncNavHtml(original, items, 'notes/detail.html');
    const links = parseNav(nested).links;
    assert.equal(links[0].href, '../');
    assert.equal(links[0].current, false);
    assert.equal(links[1].current, true);
    const home = syncNavHtml(original, items, 'index.html');
    assert.equal((home.match(/aria-current=/g) ?? []).length, 1);
    assert.equal(syncNavHtml(home, items, 'index.html'), home);
  }
});

test('a current home brand on a nested page is flagged even without a Home manifest item', () => {
  const items = [{ label: 'Notes', href: 'notes/' }];
  for (const navItems of [items, [{ label: 'Home', href: 'index.html' }, ...items]]) {
    const links = navItems.map((item) => `<a href='../${item.href}'>${item.label}</a>`).join('');
    const result = checkPage({ pagePath: 'notes/detail.html', html: `<nav><a class='home' href='../' aria-current='page'>Home</a>${links}</nav>`, navItems, navManifestPresent: true });
    assert.equal(result.warnings.filter((f) => f.code === 'current-is-home').length, 1);
  }
});
