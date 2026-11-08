import fs from 'node:fs';
import path from 'node:path';
import { decodeEntities, escapeHtml, hrefSection, isHomeHref } from './nav.mjs';

export const HOME_CARDS_START = '<!-- cockpit:home-cards -->';
export const HOME_CARDS_END = '<!-- /cockpit:home-cards -->';
export const DEFAULT_GROUP_HEADING = 'Sections';

function sectionSummary(root, item) {
  const section = hrefSection(item.href);
  if (!section) return '';
  const file = item.href.endsWith('.html') ? path.join(root, item.href) : path.join(root, section, 'index.html');
  let html;
  try { html = fs.readFileSync(file, 'utf8'); } catch { return ''; }
  const meta = /<meta\s[^>]*name=["']description["'][^>]*content="([^"]*)"/i.exec(html) ?? /<meta\s[^>]*content="([^"]*)"[^>]*name=["']description["']/i.exec(html);
  if (meta?.[1]?.trim()) return decodeEntities(meta[1]).trim();
  const block = /<script\b[^>]*id=["']cockpit-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (block) {
    try {
      const data = JSON.parse(block[1]);
      if (typeof data.summary === 'string' && data.summary.trim()) return data.summary.trim();
    } catch { /* ignore */ }
  }
  return '';
}

// Cards for every nav item except Home and items with home = false.
// Card text: nav item summary, else the section index meta description, else its cockpit-data summary.
export function homeCards(root, items) {
  return items
    .filter((item) => !isHomeHref(item.href) && item.home !== false)
    .map((item) => ({
      title: item.label,
      href: item.href,
      body: item.summary ?? sectionSummary(root, item),
      tags: Array.isArray(item.tags) ? item.tags : [],
      group: item.group ?? DEFAULT_GROUP_HEADING,
    }));
}

export function renderHomeCards(cards, indent = '    ') {
  const groups = [];
  for (const card of cards) {
    let group = groups.at(-1);
    if (!group || group.name !== card.group) {
      group = { name: card.group, cards: [] };
      groups.push(group);
    }
    group.cards.push(card);
  }
  const lines = [];
  for (const group of groups) {
    lines.push(`${indent}<h2 class="section">${escapeHtml(group.name)}</h2>`);
    lines.push(`${indent}<div class="grid-list cards-3" aria-label="${escapeHtml(group.name)}">`);
    for (const card of group.cards) {
      lines.push(`${indent}  <a class="card" href="${escapeHtml(card.href)}">`);
      lines.push(`${indent}    <h3>${escapeHtml(card.title)}</h3>`);
      if (card.body) lines.push(`${indent}    <p>${escapeHtml(card.body)}</p>`);
      if (card.tags.length > 0) lines.push(`${indent}    <div class="tags">${card.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>`);
      lines.push(`${indent}  </a>`);
    }
    lines.push(`${indent}</div>`);
  }
  return lines.join('\n');
}

export function hasHomeCardMarkers(html) {
  return String(html).includes(HOME_CARDS_START) && String(html).includes(HOME_CARDS_END);
}

// Replace the marked region and the cockpit-data "cards" array. Returns the new HTML.
export function syncHomeHtml(html, cards) {
  const start = html.indexOf(HOME_CARDS_START);
  const end = html.indexOf(HOME_CARDS_END);
  if (start < 0 || end < start) throw new Error(`home page has no ${HOME_CARDS_START} ... ${HOME_CARDS_END} region`);
  const lineStart = html.lastIndexOf('\n', start) + 1;
  const indent = /^[ \t]*/.exec(html.slice(lineStart, start))[0];
  let out = `${html.slice(0, start + HOME_CARDS_START.length)}\n${renderHomeCards(cards, indent)}\n${indent}${html.slice(end)}`;
  const block = /(<script\b[^>]*id=["']cockpit-data["'][^>]*>)([\s\S]*?)(<\/script>)/i.exec(out);
  if (block) {
    let data;
    try { data = JSON.parse(block[2]); } catch { data = undefined; }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      data.cards = cards.map(({ title, href, body, tags, group }) => ({ title, href, body, tags, group }));
      data.cards_source = '.cockpit/nav.toml (home-sync.mjs)';
      const json = JSON.stringify(data, null, 2).replace(/<\//g, '<\\/');
      out = out.slice(0, block.index) + block[1] + json + block[3] + out.slice(block.index + block[0].length);
    }
  }
  return out;
}
