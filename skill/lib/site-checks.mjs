import fs from 'node:fs';
import path from 'node:path';
import { decodeEntities, expectedCurrentIndex, hrefSection, isHomeHref } from './nav.mjs';
import { hasHomeCardMarkers, homeCards as navHomeCards, syncHomeHtml } from './home.mjs';

// Cross-page checks run by lint.mjs: sections missing from the nav, orphan pages,
// and home-page card data that drifted from the visible cards.

const externalPattern = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function attrValue(raw, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(raw);
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? '') : undefined;
}

export function isMovedStub(html) {
  const text = String(html ?? '');
  if (/<meta\s[^>]*name=["']cockpit:moved-to["']/i.test(text)) return true;
  for (const meta of text.match(/<meta\b[^>]*>/gi) ?? []) {
    if (attrValue(meta, 'http-equiv')?.toLowerCase() !== 'refresh') continue;
    const content = attrValue(meta, 'content') ?? '';
    const redirect = /(?:^|;)\s*url\s*=\s*(.*)$/i.exec(content)?.[1]?.trim();
    if (redirect && redirect.replace(/^["']|["']$/g, '').trim()) return true;
  }
  const block = /<script\b[^>]*id=["']cockpit-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(text);
  if (block) {
    try {
      const data = JSON.parse(block[1]);
      if (data && data.kind === 'moved') return true;
    } catch { /* not a stub */ }
  }
  return false;
}

function stripText(value) {
  return decodeEntities(String(value ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Resolve an href on pagePath to a root-relative page path, or undefined when external.
export function resolveLink(root, pagePath, href) {
  const raw = decodeEntities(String(href ?? '')).trim();
  if (raw === '' || raw.startsWith('#') || externalPattern.test(raw)) return undefined;
  const clean = raw.split('#')[0].split('?')[0];
  if (clean === '') return undefined;
  let target;
  if (clean.startsWith('/')) target = path.posix.normalize(clean.slice(1) || '.');
  else {
    const dir = path.posix.dirname(pagePath);
    target = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, clean));
  }
  if (target.startsWith('..')) return undefined;
  if (target === '.' || target === '') return 'index.html';
  if (clean.endsWith('/')) return `${target.replace(/\/+$/, '')}/index.html`;
  if (!path.posix.extname(target)) {
    const full = path.join(root, target);
    try {
      if (fs.statSync(full).isDirectory()) return `${target}/index.html`;
    } catch { /* missing */ }
  }
  return target;
}

function contentLinks(html) {
  const body = String(html)
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<a\b[^>]*class="[^"]*\bbrand\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi, ' ');
  const out = [];
  const pattern = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let match;
  while ((match = pattern.exec(body))) out.push(match[1] ?? match[2]);
  return out;
}

function footerLinks(html) {
  const out = [];
  for (const footer of String(html).match(/<footer\b[\s\S]*?<\/footer>/gi) ?? []) {
    const pattern = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let match;
    while ((match = pattern.exec(footer))) out.push(match[1] ?? match[2]);
  }
  return out;
}

function homeCards(html) {
  const main = /<main\b[\s\S]*?<\/main>/i.exec(html)?.[0] ?? html;
  const cards = [];
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(main))) {
    if (!(attrValue(` ${match[1]}`, 'class') ?? '').split(/\s+/).includes('card')) continue;
    const href = attrValue(` ${match[1]}`, 'href') ?? '';
    const title = stripText(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(match[2])?.[1] ?? '');
    cards.push({ href, title });
  }
  return cards;
}

function normalizeCardHref(href) {
  return String(href ?? '').replace(/^\.\//, '').replace(/^\//, '');
}

export function siteFindings({ root, pages, nav }) {
  const findings = [];
  const add = (pagePath, code, message) => findings.push({ severity: 'warning', path: pagePath, code, message });
  const byPath = new Map(pages.map((page) => [page.pagePath, page]));
  const stubs = new Set(pages.filter((page) => isMovedStub(page.html)).map((page) => page.pagePath));

  // unregistered-section: top-level folders with an index page that are neither in the nav nor hidden.
  const navSections = new Set(nav.items.map((item) => hrefSection(item.href)).filter(Boolean));
  const hidden = new Set(nav.hidden ?? []);
  const topSections = [...new Set(pages.map((page) => page.pagePath).filter((p) => /^[^/]+\/index\.html$/.test(p)).map((p) => p.split('/')[0]))].sort();
  if (nav.present) {
    for (const section of topSections) {
      if (stubs.has(`${section}/index.html`)) continue;
      if (!navSections.has(section) && !hidden.has(section)) add(`${section}/index.html`, 'unregistered-section', `Top-level section "${section}/" is not in .cockpit/nav.toml (add a [[nav]] entry, or list it in hidden = [...])`);
    }
    for (const section of hidden) {
      if (navSections.has(section)) add('.cockpit/nav.toml', 'hidden-section-in-nav', `"${section}/" is listed in hidden but also has a [[nav]] entry`);
    }
  }

  const home = byPath.get('index.html');
  if (home && nav.present) {
    // missing-home-card: every nav section (except Home and items with home = false) needs a link from the home page body.
    const homeTargets = new Set(contentLinks(home.html).map((href) => resolveLink(root, 'index.html', href)).filter(Boolean));
    for (const item of nav.items) {
      if (isHomeHref(item.href) || item.home === false) continue;
      const target = resolveLink(root, 'index.html', item.href);
      if (target && byPath.has(target) && !homeTargets.has(target)) add('index.html', 'missing-home-card', `Home page has no card or link for nav section "${item.label}" (${item.href}); add one or set home = false on the nav entry`);
    }

    if (hasHomeCardMarkers(home.html)) {
      let next;
      try { next = syncHomeHtml(home.html, navHomeCards(root, nav.items)); } catch { next = home.html; }
      if (next !== home.html) add('index.html', 'stale-home-cards', 'Home cards are out of date with .cockpit/nav.toml (run home-sync.mjs)');
    }

    // home-data-drift: cockpit-data.cards vs visible cards.
    const block = /<script\b[^>]*id=["']cockpit-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(home.html);
    let data;
    try { data = block ? JSON.parse(block[1]) : undefined; } catch { data = undefined; }
    if (data && Array.isArray(data.cards)) {
      const cards = data.cards.filter((card, index) => {
        if (card && typeof card === 'object' && !Array.isArray(card)
          && typeof card.href === 'string' && typeof card.title === 'string') return true;
        add('index.html', 'invalid-home-card', `Home cockpit-data.cards[${index}] must be an object with string href and title`);
        return false;
      });
      const expected = cards.map((card) => ({ href: normalizeCardHref(card.href), title: card.title.trim() }));
      const actual = homeCards(home.html).map((card) => ({ href: normalizeCardHref(card.href), title: card.title }));
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        const missing = expected.filter((e) => !actual.some((a) => a.href === e.href && a.title === e.title)).map((e) => `${e.title} (${e.href})`);
        const extra = actual.filter((a) => !expected.some((e) => e.href === a.href && e.title === a.title)).map((a) => `${a.title} (${a.href})`);
        const detail = [missing.length ? `in data only: ${missing.join(', ')}` : '', extra.length ? `visible only: ${extra.join(', ')}` : ''].filter(Boolean).join('; ') || 'card order differs';
        add('index.html', 'home-data-drift', `Home cockpit-data cards do not match the visible cards (${detail})`);
      }
      for (const card of cards) {
        const target = resolveLink(root, 'index.html', card.href);
        if (target && !byPath.has(target)) add('index.html', 'home-data-drift', `Home card "${card.title}" points to ${card.href}, which does not exist`);
      }
    }
  }

  // orphan-page: no inbound content link (nav and footer links do not count; footer links count for root-level pages).
  const inbound = new Map();
  for (const page of pages) {
    if (stubs.has(page.pagePath)) continue;
    for (const href of contentLinks(page.html)) {
      const target = resolveLink(root, page.pagePath, href);
      if (!target || target === page.pagePath) continue;
      inbound.set(target, (inbound.get(target) ?? 0) + 1);
    }
    for (const href of footerLinks(page.html)) {
      const target = resolveLink(root, page.pagePath, href);
      if (target && !target.includes('/')) inbound.set(target, (inbound.get(target) ?? 0) + 1);
    }
  }
  for (const page of pages) {
    const p = page.pagePath;
    if (p === 'index.html' || /^[^/]+\/index\.html$/.test(p) || stubs.has(p)) continue;
    if (!inbound.get(p)) add(p, 'orphan-page', 'No other page links here (nav and footer links do not count); link it from its section index');
  }

  return findings;
}

export { expectedCurrentIndex };
