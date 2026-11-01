import fs from 'node:fs';
import path from 'node:path';
import { parseToml } from './toml.mjs';

// Shared nav helpers for nav-sync, home-sync, lint, and search-index.
// nav.toml shape:
//   hidden = ["search/"]          # optional: sections reachable but kept out of the nav
//   [[nav]]
//   label = "Food"
//   href = "food/"
//   group = "Life"                # optional: consecutive items with the same group render under one heading
//   summary = "..."               # optional: home card text (home-sync)
//   tags = ["a", "b"]             # optional: home card tags (home-sync)
//   home = false                  # optional: leave this item off the home cards

export function normalizeHref(href) {
  const value = String(href ?? '').split('#')[0].split('?')[0].replace(/^\.\//, '').replace(/^\//, '');
  return value === '' ? '' : value.replace(/\/+$/, '');
}

export function isHomeHref(href) {
  const value = normalizeHref(href);
  return value === '' || value === '.' || value === 'index.html';
}

// Section key for a manifest href: top-level folder ("food/" -> "food"), or the
// root-level file name for a root page ("design-system.html"), or "" for home.
export function hrefSection(href) {
  const value = normalizeHref(href);
  if (isHomeHref(value)) return '';
  const first = value.split('/')[0];
  return first;
}

// Section key for a page path relative to the root.
export function pageSection(pagePath) {
  const value = String(pagePath).split(path.sep).join('/');
  if (value === 'index.html') return '';
  return value.split('/')[0];
}

export function readNavManifest(root) {
  const file = path.join(root, '.cockpit', 'nav.toml');
  if (!fs.existsSync(file)) return { present: false, items: [], hidden: [] };
  const parsed = parseToml(fs.readFileSync(file, 'utf8'));
  return { present: true, ...navFromParsed(parsed) };
}

export function navFromParsed(parsed) {
  const items = Array.isArray(parsed.nav)
    ? parsed.nav
      .filter((item) => typeof item.label === 'string' && typeof item.href === 'string')
      .map((item) => ({
        label: item.label,
        href: item.href,
        ...(typeof item.group === 'string' && item.group.trim() ? { group: item.group.trim() } : {}),
        ...(typeof item.summary === 'string' ? { summary: item.summary } : {}),
        ...(Array.isArray(item.tags) ? { tags: item.tags } : {}),
        ...(item.home === false ? { home: false } : {}),
      }))
    : [];
  const hidden = Array.isArray(parsed.hidden) ? parsed.hidden.map((value) => hrefSection(value)).filter(Boolean) : [];
  return { items, hidden };
}

export function pagePrefix(pagePath) {
  const dir = path.posix.dirname(String(pagePath).split(path.sep).join('/'));
  return dir === '.' ? '' : '../'.repeat(dir.split('/').length);
}

// Index of the nav item a page belongs to, or -1 when no item matches
// (a hidden section, a root-level page that is not in the nav, ...).
export function expectedCurrentIndex(items, pagePath) {
  const section = pageSection(pagePath);
  if (section === '') return items.findIndex((item) => isHomeHref(item.href));
  return items.findIndex((item) => !isHomeHref(item.href) && hrefSection(item.href) === section);
}

export function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'group';
}

// Group consecutive items: [{ group: undefined|string, items: [{item, index}] }]
export function groupItems(items) {
  const groups = [];
  items.forEach((item, index) => {
    const last = groups.at(-1);
    if (last && last.group === item.group) last.items.push({ item, index });
    else groups.push({ group: item.group, items: [{ item, index }] });
  });
  return groups;
}

export function renderNavItems(items, pagePath, indent = '      ') {
  const prefix = pagePrefix(pagePath);
  const current = expectedCurrentIndex(items, pagePath);
  const link = ({ item, index }, pad) => `${pad}<a href="${escapeHtml(`${prefix}${item.href}`)}"${index === current ? ' aria-current="page"' : ''}>${escapeHtml(item.label)}</a>`;
  const lines = [];
  for (const group of groupItems(items)) {
    if (!group.group) {
      for (const entry of group.items) lines.push(link(entry, indent));
      continue;
    }
    lines.push(`${indent}<div class="nav-group" role="group" aria-labelledby="nav-group-${slug(group.group)}">`);
    lines.push(`${indent}  <span class="nav-group-label" id="nav-group-${slug(group.group)}">${escapeHtml(group.group)}</span>`);
    for (const entry of group.items) lines.push(link(entry, `${indent}  `));
    lines.push(`${indent}</div>`);
  }
  return lines.join('\n');
}

function attrValue(raw, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(raw);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : undefined;
}

function isBrandLink(openTag) {
  const cls = attrValue(openTag, 'class') ?? '';
  return /(^|\s)(home|brand)(\s|$)/.test(cls);
}

// Locate the item region inside a <nav class="cockpit-nav"> (or the first <nav>):
// the run of nav links and nav-group blocks, ignoring a leading search form,
// a brand/home link, and trailing widgets such as the theme switcher.
export function findNav(html) {
  const navOpen = /<nav\b[^>]*class="[^"]*\bcockpit-nav\b[^"]*"[^>]*>/i.exec(html) ?? /<nav\b[^>]*>/i.exec(html);
  if (!navOpen) return undefined;
  const contentStart = navOpen.index + navOpen[0].length;
  const closeIdx = html.slice(contentStart).search(/<\/nav\s*>/i);
  if (closeIdx < 0) return undefined;
  const contentEnd = contentStart + closeIdx;
  const content = html.slice(contentStart, contentEnd);
  const tokens = [];
  const pattern = /<div\b[^>]*class="[^"]*\bnav-group\b[^"]*"[^>]*>[\s\S]*?<\/div>|<a\b([^>]*)>[\s\S]*?<\/a>|<form\b[\s\S]*?<\/form>|<fieldset\b[\s\S]*?<\/fieldset>/gi;
  let match;
  while ((match = pattern.exec(content))) {
    const raw = match[0];
    let type = 'other';
    if (/^<div/i.test(raw)) type = 'group';
    else if (/^<a/i.test(raw)) type = isBrandLink(raw.slice(0, raw.indexOf('>') + 1)) ? 'brand' : 'link';
    tokens.push({ type, start: match.index, end: match.index + raw.length, raw });
  }
  const items = tokens.filter((token) => token.type === 'link' || token.type === 'group');
  return { navStart: navOpen.index, contentStart, contentEnd, content, tokens, items };
}

export class NavSyncError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NavSyncError';
  }
}

export function syncNavHtml(html, items, pagePath) {
  const nav = findNav(html);
  if (!nav) throw new NavSyncError('no <nav> element');
  const prefix = pagePrefix(pagePath);
  const isRootIndex = pagePath === 'index.html';
  const hasHomeItem = items.some((item) => isHomeHref(item.href));
  let content = nav.content;
  const rendered = renderNavItems(items, pagePath, '');

  // Keep brand/home links in place but give them a depth-correct href and the
  // current marker on the root index when the manifest has no Home item.
  const fixBrand = (raw) => {
    const openEnd = raw.indexOf('>');
    let open = raw.slice(0, openEnd + 1).replace(/\s+aria-current="[^"]*"/i, '');
    open = open.replace(/\shref="[^"]*"/i, ` href="${prefix || './'}"`);
    if (isRootIndex && !hasHomeItem) open = open.replace(/>$/, ' aria-current="page">');
    return open + raw.slice(openEnd + 1);
  };

  if (nav.items.length === 0) {
    // No items yet: append after the last brand/form token, or at the start.
    const anchor = [...nav.tokens].filter((token) => token.type === 'brand' || /^<form/i.test(token.raw)).at(-1);
    const at = anchor ? anchor.end : 0;
    const indent = guessIndent(content, at) ?? '  ';
    content = `${content.slice(0, at)}\n${indent}${rendered.split('\n').join(`\n${indent}`)}${content.slice(at)}`;
  } else {
    const first = nav.items[0];
    const last = nav.items.at(-1);
    const between = nav.tokens.filter((token) => token.start >= first.start && token.end <= last.end && token.type !== 'link' && token.type !== 'group');
    if (between.length > 0) throw new NavSyncError('nav links are interleaved with other elements; fix by hand');
    let gap = content.slice(first.start, last.end);
    for (const token of [...nav.items].reverse()) gap = gap.slice(0, token.start - first.start) + gap.slice(token.end - first.start);
    if (gap.replace(/<!--[\s\S]*?-->/g, '').trim() !== '') throw new NavSyncError('unexpected text between nav links; fix by hand');
    const indent = guessIndent(content, first.start) ?? '  ';
    content = `${content.slice(0, first.start)}${rendered.split('\n').join(`\n${indent}`)}${content.slice(last.end)}`;
  }
  // Rewrite brand links (they may sit before or after the item run).
  content = content.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, (raw) => (isBrandLink(raw.slice(0, raw.indexOf('>') + 1)) ? fixBrand(raw) : raw));
  return html.slice(0, nav.contentStart) + content + html.slice(nav.contentEnd);
}

function guessIndent(content, at) {
  const lineStart = content.lastIndexOf('\n', at - 1);
  if (lineStart < 0) return undefined;
  const lead = content.slice(lineStart + 1, at);
  return /^[ \t]*$/.test(lead) ? lead : undefined;
}

// Parsed view of a page nav for lint: links with label, href, current flag, group, brand flag.
export function parseNav(html) {
  const nav = findNav(html);
  if (!nav) return undefined;
  const links = [];
  const linkPattern = /<a\s([^>]*?)>([\s\S]*?)<\/a>/gi;
  for (const token of nav.tokens) {
    if (token.type !== 'link' && token.type !== 'group' && token.type !== 'brand') continue;
    const group = token.type === 'group' ? stripTagsLite((/<span\b[^>]*class="[^"]*\bnav-group-label\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(token.raw) ?? [])[1] ?? '') : undefined;
    let match;
    linkPattern.lastIndex = 0;
    while ((match = linkPattern.exec(token.raw))) {
      links.push({
        label: stripTagsLite(match[2]),
        href: attrValue(` ${match[1]}`, 'href') ?? '',
        current: attrValue(` ${match[1]}`, 'aria-current') === 'page',
        group: group || undefined,
        brand: token.type === 'brand',
      });
    }
  }
  return { links };
}

export function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™', rarr: '→', larr: '←', times: '×', eacute: 'é', bull: '•' };
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return named[code.toLowerCase()] ?? whole;
  });
}

function stripTagsLite(value) {
  return decodeEntities(String(value ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
