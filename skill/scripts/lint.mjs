#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { resolveRoot, validateCockpitRoot } from '../lib/config.mjs';
import { assertNode20 } from '../lib/paths.mjs';
import { parseToml } from '../lib/toml.mjs';
import { checkPage, checkSearchIndex, cssFixedWidthFindings, discoverHtmlPages, renderedAtForHtml, rootRelative } from '../lib/contract.mjs';

function usage() {
  return 'Usage: node scripts/lint.mjs [--root <path>] [--strict] [--json]\n';
}

function parseArgs(argv) {
  const options = { strict: false, json: false, rootArgs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--root' || arg === '--cockpit-root') {
      let value = argv[i + 1];
      if (value === '--') {
        value = argv[i + 2];
        if (!value) throw new Error(`${arg} requires a path argument`);
        options.rootArgs.push(`${arg}=${value}`);
        i += 2;
      } else {
        if (!value || value.startsWith('-')) throw new Error(`${arg} requires a path argument`);
        options.rootArgs.push(arg, value);
        i += 1;
      }
    } else if (arg.startsWith('--root=') || arg.startsWith('--cockpit-root=')) options.rootArgs.push(arg);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function readNav(root) {
  const file = path.join(root, '.cockpit', 'nav.toml');
  if (!fs.existsSync(file)) return { present: false, items: [] };
  const parsed = parseToml(fs.readFileSync(file, 'utf8'));
  const items = Array.isArray(parsed.nav) ? parsed.nav.filter((item) => typeof item.label === 'string' && typeof item.href === 'string').map((item) => ({ label: item.label, href: item.href })) : [];
  return { present: true, items };
}

function readSources(root) {
  const parsed = parseToml(fs.readFileSync(path.join(root, '.cockpit', 'sources.toml'), 'utf8'));
  return new Set(Object.keys(parsed.sources ?? {}));
}

function prefixFindings(kind, page, findings) {
  return findings.map((item) => ({ severity: kind, path: page, ...item }));
}

function lintRoot(root) {
  validateCockpitRoot(root);
  const nav = readNav(root);
  const sourceIds = readSources(root);
  const stylesheet = fs.existsSync(path.join(root, 'cockpit.css')) ? fs.readFileSync(path.join(root, 'cockpit.css'), 'utf8') : '';
  const files = discoverHtmlPages(root);
  const findings = [];
  findings.push(...prefixFindings('error', 'cockpit.css', cssFixedWidthFindings(stylesheet, 'cockpit.css')));
  const pagePaths = [];
  const renderedAts = [];
  for (const file of files) {
    const pagePath = rootRelative(root, file);
    pagePaths.push(pagePath);
    const html = fs.readFileSync(file, 'utf8');
    renderedAts.push(renderedAtForHtml(html));
    const result = checkPage({ pagePath, html, navItems: nav.items, navManifestPresent: nav.present, sourceIds });
    findings.push(...prefixFindings('error', pagePath, result.errors));
    findings.push(...prefixFindings('warning', pagePath, result.warnings));
  }

  const indexPath = path.join(root, '.cockpit', 'search-index.json');
  if (files.length > 0 && !fs.existsSync(indexPath)) findings.push({ severity: 'warning', path: '.cockpit/search-index.json', code: 'missing-search-index', message: 'HTML pages exist but search-index.json is missing' });
  else if (fs.existsSync(indexPath)) {
    try {
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      const result = checkSearchIndex({ index, pagePaths, renderedAts });
      findings.push(...prefixFindings('warning', '.cockpit/search-index.json', result.warnings));
    } catch {
      findings.push({ severity: 'warning', path: '.cockpit/search-index.json', code: 'invalid-search-index', message: 'Search index is not valid JSON' });
    }
  }

  return { root, page_count: files.length, findings };
}

function printHuman(result) {
  if (result.findings.length === 0) {
    process.stdout.write(`Lint passed: ${result.page_count} page(s), 0 findings\n`);
    return;
  }
  for (const finding of result.findings) process.stdout.write(`${finding.severity}: ${finding.path}: ${finding.code}: ${finding.message}\n`);
}

try {
  assertNode20();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  const { root } = resolveRoot({ argv: options.rootArgs, env: process.env, forWrite: false, stderr: process.stderr });
  const result = lintRoot(root);
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else printHuman(result);
  const hasErrors = result.findings.some((item) => item.severity === 'error');
  const hasWarnings = result.findings.some((item) => item.severity === 'warning');
  process.exitCode = hasErrors || (options.strict && hasWarnings) ? 1 : 0;
} catch (error) {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exitCode = 1;
}
