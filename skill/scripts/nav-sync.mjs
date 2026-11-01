#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { resolveRoot } from '../lib/config.mjs';
import { assertNode20 } from '../lib/paths.mjs';
import { EXIT_BUSY, LockError, assertWriteAllowed, parseDuration, validateHolder } from '../lib/lock.mjs';
import { discoverHtmlPages, rootRelative } from '../lib/contract.mjs';
import { NavSyncError, readNavManifest, syncNavHtml } from '../lib/nav.mjs';

function usage() {
  return `Usage: node scripts/nav-sync.mjs [--root <path>] [--check] [--json] [--holder <name>] [--lock-wait <duration>]

Rewrites the static <nav> links of every page from .cockpit/nav.toml:
depth-correct relative hrefs, group headings, and aria-current="page" on the
item for the page's top-level folder (the Home item on the root index.html).
Leaves the nav search form, brand link, and theme switcher in place.
Idempotent. --check reports pages that would change and exits 1 without writing.

Writes honor the cockpit write lock (see lock.mjs); inside "lock.mjs run" the
holder is taken from COCKPIT_LOCK_HOLDER.
`;
}

function parseArgs(argv) {
  const options = { rootArgs: [], check: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--root' || arg === '--cockpit-root') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a path argument`);
      options.rootArgs.push(arg, value);
      i += 1;
    } else if (arg.startsWith('--root=') || arg.startsWith('--cockpit-root=')) options.rootArgs.push(arg);
    else if (arg === '--holder' || arg === '--lock-wait') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`);
      options[arg === '--holder' ? 'holder' : 'lockWait'] = value;
      i += 1;
    } else if (arg.startsWith('--holder=')) options.holder = arg.slice('--holder='.length);
    else if (arg.startsWith('--lock-wait=')) options.lockWait = arg.slice('--lock-wait='.length);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export function planNavSync(root) {
  const nav = readNavManifest(root);
  if (!nav.present) throw new Error('No .cockpit/nav.toml in the cockpit root');
  const changed = [];
  const skipped = [];
  let unchanged = 0;
  for (const file of discoverHtmlPages(root)) {
    const pagePath = rootRelative(root, file);
    const html = fs.readFileSync(file, 'utf8');
    let next;
    try {
      next = syncNavHtml(html, nav.items, pagePath);
    } catch (error) {
      if (error instanceof NavSyncError) {
        skipped.push({ path: pagePath, reason: error.message });
        continue;
      }
      throw error;
    }
    if (next === html) unchanged += 1;
    else changed.push({ path: pagePath, file, html: next });
  }
  return { changed, skipped, unchanged };
}

try {
  assertNode20();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  const { root } = resolveRoot({ argv: options.rootArgs, env: process.env, forWrite: !options.check, stderr: process.stderr });
  if (!options.check) {
    const holder = options.holder ?? (process.env.COCKPIT_LOCK_HOLDER || undefined);
    if (holder !== undefined) validateHolder(holder);
    await assertWriteAllowed(root, { holder, waitMs: options.lockWait === undefined ? 10_000 : parseDuration(options.lockWait, '--lock-wait'), stderr: process.stderr });
  }
  const plan = planNavSync(root);
  if (!options.check) {
    for (const item of plan.changed) {
      const temp = path.join(path.dirname(item.file), `.${path.basename(item.file)}.${process.pid}.tmp`);
      fs.writeFileSync(temp, item.html, 'utf8');
      fs.renameSync(temp, item.file);
    }
  }
  const summary = { root, check: options.check, changed: plan.changed.map((item) => item.path), unchanged: plan.unchanged, skipped: plan.skipped };
  if (options.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else {
    const verb = options.check ? 'would change' : 'updated';
    process.stdout.write(`nav-sync: ${verb} ${plan.changed.length} page(s), ${plan.unchanged} unchanged, ${plan.skipped.length} skipped\n`);
    for (const item of plan.changed) process.stdout.write(`  ${verb}: ${item.path}\n`);
    for (const item of plan.skipped) process.stdout.write(`  skipped: ${item.path}: ${item.reason}\n`);
  }
  process.exitCode = (options.check && plan.changed.length > 0) || plan.skipped.length > 0 ? 1 : 0;
} catch (error) {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exitCode = error instanceof LockError && error.code === 'lock_busy' ? EXIT_BUSY : 1;
}
