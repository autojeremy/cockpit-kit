#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { resolveRoot } from '../lib/config.mjs';
import { assertNode20 } from '../lib/paths.mjs';
import { EXIT_BUSY, LockError, assertWriteAllowed, parseDuration, validateHolder } from '../lib/lock.mjs';
import { readNavManifest } from '../lib/nav.mjs';
import { HOME_CARDS_END, HOME_CARDS_START, hasHomeCardMarkers, homeCards, syncHomeHtml } from '../lib/home.mjs';

function usage() {
  return `Usage: node scripts/home-sync.mjs [--root <path>] [--check] [--holder <name>] [--lock-wait <duration>]

Regenerates the home page section cards from .cockpit/nav.toml, so a new nav
section shows up on the home page automatically. Cards are grouped under the
nav groups; the card text is the nav item's summary, else the section index's
meta description, else its cockpit-data summary. Items with home = false are
skipped. Only the region between ${HOME_CARDS_START} and
${HOME_CARDS_END} in index.html and the cockpit-data "cards" array change.
--check reports drift and exits 1 without writing.
`;
}

function parseArgs(argv) {
  const options = { rootArgs: [], check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--check') options.check = true;
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
  const nav = readNavManifest(root);
  if (!nav.present) throw new Error('No .cockpit/nav.toml in the cockpit root');
  const file = path.join(root, 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  if (!hasHomeCardMarkers(html)) throw new Error(`index.html has no ${HOME_CARDS_START} ... ${HOME_CARDS_END} region; add the markers where the cards go`);
  const next = syncHomeHtml(html, homeCards(root, nav.items));
  if (next === html) {
    process.stdout.write('home-sync: index.html is up to date\n');
  } else if (options.check) {
    process.stdout.write('home-sync: index.html would change\n');
    process.exitCode = 1;
  } else {
    const temp = path.join(root, `.index.html.${process.pid}.tmp`);
    fs.writeFileSync(temp, next, 'utf8');
    fs.renameSync(temp, file);
    process.stdout.write('home-sync: updated index.html\n');
  }
} catch (error) {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exitCode = error instanceof LockError && error.code === 'lock_busy' ? EXIT_BUSY : 1;
}
