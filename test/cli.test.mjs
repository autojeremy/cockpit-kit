import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readConfig, writeConfig } from '../lib/config.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const whereScript = path.join(repoRoot, 'scripts', 'where.mjs');
const linkScript = path.join(repoRoot, 'scripts', 'link.mjs');

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-cli-home-'));
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-cli-root-'));
  fs.mkdirSync(path.join(root, '.cockpit'));
  fs.writeFileSync(path.join(root, '.cockpit', 'sources.toml'), '');
  return root;
}

function cleanEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, ...extra };
  if (!Object.hasOwn(extra, 'COCKPIT_HOME')) delete env.COCKPIT_HOME;
  if (!Object.hasOwn(extra, 'XDG_CONFIG_HOME')) delete env.XDG_CONFIG_HOME;
  return env;
}

function run(script, args, env) {
  return spawnSyncNode([script, ...args], env);
}

function spawnSyncNode(args, env) {
  return spawnSync(process.execPath, args, { cwd: repoRoot, env, encoding: 'utf8' });
}

test('where.mjs emits JSON shape and warns on stale config skill_root', () => {
  const home = makeHome();
  const env = cleanEnv(home);
  const root = makeRoot();
  writeConfig(env, { cockpit_root: root, skill_root: '/tmp/stale-cockpit-kit' });

  const result = run(whereScript, ['--json'], env);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.cockpit_root, root);
  assert.equal(payload.skill_root, repoRoot);
  assert.equal(payload.source, 'config');
  assert.match(result.stderr, /config skill_root .* differs from inferred kit root/);
});

test('where.mjs reports remediation and nonzero exit when unresolved', () => {
  const env = cleanEnv(makeHome());
  const result = run(whereScript, ['--json'], env);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /scripts\/link\.mjs <path>/);
});

test('where.mjs exposes arg, env, and config precedence through the CLI', () => {
  const home = makeHome();
  const configRoot = makeRoot();
  const envRoot = makeRoot();
  const argRoot = makeRoot();
  const baseEnv = cleanEnv(home);
  writeConfig(baseEnv, { cockpit_root: configRoot });

  const configResult = run(whereScript, ['--json'], baseEnv);
  assert.equal(JSON.parse(configResult.stdout).cockpit_root, configRoot);
  assert.equal(JSON.parse(configResult.stdout).source, 'config');

  const envResult = run(whereScript, ['--json'], cleanEnv(home, { COCKPIT_HOME: envRoot }));
  const envPayload = JSON.parse(envResult.stdout);
  assert.equal(envPayload.cockpit_root, envRoot);
  assert.equal(envPayload.source, 'env');
  assert.match(envResult.stderr, /COCKPIT_HOME/);

  const argResult = run(whereScript, ['--json', '--root', argRoot], cleanEnv(home, { COCKPIT_HOME: envRoot }));
  const argPayload = JSON.parse(argResult.stdout);
  assert.equal(argPayload.cockpit_root, argRoot);
  assert.equal(argPayload.source, 'arg');
});

test('where.mjs rejects root flags without values', () => {
  const result = run(whereScript, ['--root', '--json'], cleanEnv(makeHome()));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--root requires a path argument/);
});

test('link.mjs covers help, create, valid config write, and invalid root refusal', () => {
  const home = makeHome();
  const env = cleanEnv(home);
  const root = makeRoot();

  const help = run(linkScript, ['--help'], env);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: node scripts\/link\.mjs/);

  const createdRoot = path.join(home, 'new-root');
  const create = run(linkScript, ['--create', '--no-git', createdRoot], env);
  assert.equal(create.status, 0, create.stderr);
  assert.equal(fs.existsSync(path.join(createdRoot, 'search', 'index.html')), true);
  assert.equal(fs.existsSync(path.join(createdRoot, '.cockpit', 'search-index.json')), true);
  assert.equal(readConfig(env).cockpitRoot, createdRoot);

  const typo = run(linkScript, ['--cretae', path.join(home, 'typo-root')], env);
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /Unknown option: --cretae/);

  const dashRoot = path.join(home, '-dash-root');
  const dash = run(linkScript, ['--create', '--no-git', '--', dashRoot], env);
  assert.equal(dash.status, 0, dash.stderr);
  assert.equal(readConfig(env).cockpitRoot, dashRoot);

  const fileRoot = path.join(home, 'not-a-directory');
  fs.writeFileSync(fileRoot, 'not a directory', 'utf8');
  const fileCreate = run(linkScript, ['--create', '--no-git', fileRoot], env);
  assert.equal(fileCreate.status, 1);
  assert.match(fileCreate.stderr, /not a directory/);

  const invalid = run(linkScript, [path.join(home, 'missing-root')], env);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Cockpit root does not exist/);

  const linked = run(linkScript, [root], env);
  assert.equal(linked.status, 0, linked.stderr);
  assert.match(linked.stdout, /Linked Cockpit root/);
  const config = readConfig(env);
  assert.equal(config.cockpitRoot, root);
  assert.equal(config.skillRoot, repoRoot);
});
