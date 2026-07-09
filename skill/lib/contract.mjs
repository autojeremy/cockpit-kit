import fs from 'node:fs';
import path from 'node:path';
import { isPathInside } from './paths.mjs';

export const SEARCH_INDEX_SENTINEL = '1970-01-01T00:00:00Z';
export const INDEX_TEXT_LIMIT = 12000;

const excludedDirs = new Set(['.git', '.cockpit', '.agents', '.claude', 'node_modules', 'attachments']);
const externalUrlPattern = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function finding(code, message, extra = {}) {
  return { code, message, ...extra };
}

function normalizeSlash(value) {
  return value.split(path.sep).join('/');
}

export function rootRelative(root, file) {
  try {
    return normalizeSlash(path.relative(fs.realpathSync.native(path.resolve(root)), fs.realpathSync.native(path.resolve(file))));
  } catch {
    return normalizeSlash(path.relative(path.resolve(root), path.resolve(file)));
  }
}

export function discoverHtmlPages(root) {
  const resolvedRoot = fs.realpathSync.native(path.resolve(root));
  const pages = [];
  const seenDirs = new Set();
  function walk(dir) {
    const realDir = fs.realpathSync.native(dir);
    if (seenDirs.has(realDir)) return;
    seenDirs.add(realDir);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (excludedDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let real;
        try {
          real = fs.realpathSync.native(full);
        } catch {
          continue;
        }
        const stat = fs.statSync(real);
        if (stat.isDirectory()) {
          if (isPathInside(real, resolvedRoot)) walk(real);
          continue;
        }
        if (stat.isFile() && entry.name.endsWith('.html') && isPathInside(real, resolvedRoot)) pages.push(full);
        continue;
      }
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.html')) pages.push(full);
    }
  }
  walk(resolvedRoot);
  return pages.map((file) => path.resolve(file)).sort((a, b) => rootRelative(resolvedRoot, a).localeCompare(rootRelative(resolvedRoot, b)));
}

function parseAttrs(raw = '') {
  const attrs = {};
  const attrPattern = /([A-Za-z_:][A-Za-z0-9_:.-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = attrPattern.exec(raw))) {
    attrs[match[1].toLowerCase()] = match[3] ?? match[4] ?? match[5] ?? '';
  }
  return attrs;
}

function stripTags(value) {
  return decodeEntities(String(value ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Minimal tolerant scanner for the page contract. It recognizes normal start tags,
// quoted/unquoted attributes, and paired content for the handful of elements the
// contract needs. It is not an HTML validator and does not model malformed nesting.
export function scanHtml(html) {
  const text = String(html ?? '');
  const tags = [];
  const tagPattern = /<([A-Za-z][A-Za-z0-9:-]*)(\s[^<>]*?)?>/g;
  let match;
  while ((match = tagPattern.exec(text))) {
    const name = match[1].toLowerCase();
    if (match[0].startsWith('</')) continue;
    const start = match.index;
    const openEnd = tagPattern.lastIndex;
    const closePattern = new RegExp(`</${name}\\s*>`, 'i');
    const closeMatch = closePattern.exec(text.slice(openEnd));
    const end = closeMatch ? openEnd + closeMatch.index + closeMatch[0].length : openEnd;
    const content = closeMatch ? text.slice(openEnd, openEnd + closeMatch.index) : '';
    tags.push({ name, attrs: parseAttrs(match[2] ?? ''), content, start, end, raw: match[0] });
  }
  return { html: text, tags };
}

export function metaContent(scanned, name) {
  return scanned.tags.find((tag) => tag.name === 'meta' && tag.attrs.name === name)?.attrs.content;
}

export function validIsoTimestamp(value) {
  return typeof value === 'string' && isoDatePattern.test(value) && !Number.isNaN(Date.parse(value));
}

export function parseDataBlocks(scanned) {
  return scanned.tags.filter((tag) => tag.name === 'script' && tag.attrs.id === 'cockpit-data' && tag.attrs.type === 'application/json');
}

function parseNavLinks(scanned) {
  const nav = scanned.tags.find((tag) => tag.name === 'nav');
  if (!nav) return undefined;
  const links = [];
  const linkPattern = /<a\s([^>]*?)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkPattern.exec(nav.content))) {
    const attrs = parseAttrs(match[1]);
    links.push({ label: stripTags(match[2]), href: attrs.href ?? '', current: attrs['aria-current'] === 'page' });
  }
  return links;
}

function normalizeManifestHref(href) {
  const normalized = String(href ?? '').replace(/^\.\//, '').replace(/^\//, '');
  return normalized === '' ? '' : normalized.replace(/\/+$/, '');
}

function resolvePageHref(href, pagePath) {
  const value = String(href ?? '').split('#')[0].split('?')[0];
  if (externalUrlPattern.test(value) || value.startsWith('mailto:') || value.startsWith('tel:')) return value;
  if (value.startsWith('/')) return normalizeManifestHref(value);
  const pageDir = path.posix.dirname(pagePath);
  const base = pageDir === '.' ? '' : `${pageDir}/`;
  return normalizeManifestHref(path.posix.normalize(`${base}${value}`)).replace(/^\.\//, '');
}

function pageDepth(pagePath) {
  const dir = path.posix.dirname(pagePath);
  return dir === '.' ? 0 : dir.split('/').length;
}

function expectedForPage(navItems, pagePath) {
  const prefix = pageDepth(pagePath) === 0 ? '' : '../'.repeat(pageDepth(pagePath));
  return navItems.map((item) => ({ label: item.label, href: `${prefix}${item.href}` }));
}

export function cssFixedWidthFindings(css, source) {
  const out = [];
  const pattern = /(^|[;{\s])width\s*:\s*(\d+)px\b/gi;
  let match;
  while ((match = pattern.exec(css))) {
    const width = Number.parseInt(match[2], 10);
    if (width > 320) out.push(finding('fixed-pixel-width', `Fixed width ${width}px exceeds 320px in ${source}`));
  }
  return out;
}

export function checkPage({ pagePath, html, navItems, navManifestPresent = false, sourceIds = new Set() }) {
  const scanned = scanHtml(html);
  const errors = [];
  const warnings = [];

  for (const tag of scanned.tags) {
    if (tag.name === 'link' && tag.attrs.rel?.split(/\s+/).includes('stylesheet') && externalUrlPattern.test(tag.attrs.href ?? '')) errors.push(finding('external-stylesheet', `Cross-origin stylesheet: ${tag.attrs.href}`));
    if (tag.name === 'script' && tag.attrs.src && externalUrlPattern.test(tag.attrs.src)) errors.push(finding('external-script', `Cross-origin script: ${tag.attrs.src}`));
  }

  const source = metaContent(scanned, 'cockpit:source');
  if (!source) errors.push(finding('missing-source-meta', 'Missing cockpit:source meta tag'));
  else if (source !== 'self' && !source.startsWith('upstream:')) errors.push(finding('invalid-source-value', `Invalid cockpit:source value: ${source}`));
  else if (source.startsWith('upstream:')) {
    const id = source.slice('upstream:'.length);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) errors.push(finding('invalid-upstream-source', `Invalid upstream source id: ${id}`));
    else if (!sourceIds.has(id)) errors.push(finding('unknown-upstream-source', `Unknown upstream source id: ${id}`));
  }

  const blocks = parseDataBlocks(scanned);
  if (blocks.length > 1) errors.push(finding('multiple-data-blocks', 'Multiple cockpit-data blocks found'));
  if (source === 'self' && blocks.length === 0) errors.push(finding('missing-data-block', 'Self-sourced page is missing cockpit-data'));
  if (blocks.length > 0) {
    try {
      const data = JSON.parse(blocks[0].content);
      if (!data || typeof data !== 'object' || Array.isArray(data)) errors.push(finding('data-block-not-object', 'cockpit-data must be a JSON object'));
      else {
        if (typeof data.kind !== 'string' || data.kind.trim() === '') errors.push(finding('data-block-missing-kind', 'cockpit-data.kind must be a non-empty string'));
        if (!Number.isInteger(data.schema_version) || data.schema_version < 1) errors.push(finding('data-block-missing-schema-version', 'cockpit-data.schema_version must be an integer >= 1'));
      }
    } catch {
      errors.push(finding('invalid-data-block-json', 'cockpit-data is not valid JSON'));
    }
  }

  const renderedAt = metaContent(scanned, 'cockpit:rendered-at');
  if (!renderedAt) errors.push(finding('missing-rendered-at', 'Missing cockpit:rendered-at meta tag'));
  else if (!validIsoTimestamp(renderedAt)) errors.push(finding('invalid-rendered-at', `Invalid cockpit:rendered-at value: ${renderedAt}`));

  const viewport = metaContent(scanned, 'viewport');
  if (!viewport) errors.push(finding('missing-viewport', 'Missing viewport meta tag'));
  else if (!/(^|,)\s*width\s*=\s*device-width\s*(,|$)/.test(viewport) || !/(^|,)\s*initial-scale\s*=\s*1(?:\.0+)?\s*(,|$)/.test(viewport)) errors.push(finding('invalid-viewport', 'Viewport must include width=device-width and initial-scale=1'));

  const navLinks = parseNavLinks(scanned);
  if (!navLinks) errors.push(finding('missing-nav', 'Missing nav element'));
  else if (navLinks.length === 0) errors.push(finding('empty-nav', 'Nav contains no links'));
  else {
    const currentCount = navLinks.filter((link) => link.current).length;
    if (currentCount === 0) warnings.push(finding('no-aria-current', 'No nav link has aria-current="page"'));
    if (currentCount > 1) warnings.push(finding('multiple-aria-current', 'More than one nav link has aria-current="page"'));
    if (!navManifestPresent) warnings.push(finding('no-nav-manifest', 'No readable .cockpit/nav.toml for nav comparison'));
    else {
      const actual = navLinks.filter((link) => link.label !== 'Cockpit').map((link) => ({ label: link.label, href: resolvePageHref(link.href, pagePath) }));
      const expected = navItems.map((item) => ({ label: item.label, href: normalizeManifestHref(item.href) }));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) warnings.push(finding('stale-nav', `Nav does not match manifest; expected ${JSON.stringify(expectedForPage(navItems, pagePath))}`));
    }
  }

  const styleText = scanned.tags.filter((tag) => tag.name === 'style').map((tag) => tag.content).join('\n');
  errors.push(...cssFixedWidthFindings(styleText, pagePath));
  return { errors, warnings, scanned };
}

export function renderedAtForHtml(html) {
  const value = metaContent(scanHtml(html), 'cockpit:rendered-at');
  return validIsoTimestamp(value) ? value : undefined;
}

function textFromData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
  const values = [];
  for (const [key, value] of Object.entries(data)) {
    if (['markdown', 'html', 'content'].includes(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') values.push(String(value));
  }
  return values.join(' ');
}

export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/\b(?:sk|pk|ghp|gho|github_pat|xox[baprs])-?[A-Za-z0-9_=-]{12,}\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9_]*(?:token|secret|api[_-]?key|password)[A-Za-z0-9_]*\s*[:=]\s*['"]?[^\s'"<]{8,}/gi, '[REDACTED]');
}

export function pageHref(pagePath) {
  if (pagePath === 'index.html') return '/';
  if (pagePath.endsWith('/index.html')) return `/${pagePath.slice(0, -'index.html'.length)}`;
  return `/${pagePath}`;
}

export function extractIndexPage({ pagePath, html }) {
  const scanned = scanHtml(html);
  const title = stripTags(scanned.tags.find((tag) => tag.name === 'title')?.content) || stripTags(scanned.tags.find((tag) => tag.name === 'h1')?.content) || pagePath;
  const headings = scanned.tags
    .filter((tag) => /^h[1-6]$/.test(tag.name))
    .map((tag) => ({ level: tag.name, text: stripTags(tag.content) }))
    .filter((heading) => heading.text);
  let data = {};
  const block = parseDataBlocks(scanned)[0];
  if (block) {
    try { data = JSON.parse(block.content); } catch { data = {}; }
  }
  const summary = typeof data.summary === 'string' ? data.summary : typeof data.description === 'string' ? data.description : '';
  const section = headings[0]?.text ?? title;
  const withoutSkipped = scanned.html.replace(/<(script|style|nav|footer)\b[\s\S]*?<\/\1>/gi, ' ');
  const visible = stripTags(withoutSkipped);
  const text = redactSecrets(`${title} ${section} ${headings.map((h) => h.text).join(' ')} ${summary} ${textFromData(data)} ${visible}`).replace(/\s+/g, ' ').trim().slice(0, INDEX_TEXT_LIMIT);
  return { title, href: pageHref(pagePath), path: pagePath, section, headings, summary, text };
}

export function buildSearchIndex(pages) {
  const validDates = pages.map((page) => page.renderedAt).filter(validIsoTimestamp).sort();
  return {
    kind: 'cockpit-search-index',
    schema_version: 1,
    generated_at: validDates.at(-1) ?? SEARCH_INDEX_SENTINEL,
    page_count: pages.length,
    pages: pages.map((page) => page.record),
  };
}

export function checkSearchIndex({ index, pagePaths, renderedAts }) {
  const warnings = [];
  if (!index || typeof index !== 'object' || Array.isArray(index) || index.kind !== 'cockpit-search-index' || !Number.isInteger(index.schema_version) || index.schema_version < 1 || !validIsoTimestamp(index.generated_at) || !Array.isArray(index.pages) || index.page_count !== index.pages.length) {
    warnings.push(finding('invalid-search-index', 'Search index is missing required top-level fields'));
    return { errors: [], warnings };
  }
  const indexedPaths = index.pages.map((page) => page?.path).filter((value) => typeof value === 'string').sort();
  const discovered = [...pagePaths].sort();
  if (JSON.stringify(indexedPaths) !== JSON.stringify(discovered)) warnings.push(finding('stale-search-index', 'Search index page set differs from discovered HTML pages'));
  const generated = Date.parse(index.generated_at);
  if (renderedAts.some((value) => validIsoTimestamp(value) && Date.parse(value) > generated)) warnings.push(finding('stale-search-index', 'Search index is older than at least one rendered page'));
  return { errors: [], warnings };
}
