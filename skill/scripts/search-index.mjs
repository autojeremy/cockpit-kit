#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { resolveRoot } from '../lib/config.mjs';
import { assertNode20 } from '../lib/paths.mjs';
import { buildSearchIndex, discoverHtmlPages, extractIndexPage, renderedAtForHtml, rootRelative } from '../lib/contract.mjs';

function usage() {
  return 'Usage: node scripts/search-index.mjs [--root <path>]\n';
}

function parseArgs(argv) {
  const options = { rootArgs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
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

function generate(root) {
  const files = discoverHtmlPages(root);
  const pages = files.map((file) => {
    const pagePath = rootRelative(root, file);
    const html = fs.readFileSync(file, 'utf8');
    return { renderedAt: renderedAtForHtml(html), record: extractIndexPage({ pagePath, html }) };
  });
  return buildSearchIndex(pages);
}

try {
  assertNode20();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  const { root } = resolveRoot({ argv: options.rootArgs, env: process.env, forWrite: true, stderr: process.stderr });
  const index = generate(root);
  const dir = path.join(root, '.cockpit');
  const target = path.join(dir, 'search-index.json');
  const temp = path.join(dir, `.search-index.${process.pid}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, target);
  process.stdout.write(`Wrote ${target} (${index.page_count} page(s))\n`);
} catch (error) {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exitCode = 1;
}
