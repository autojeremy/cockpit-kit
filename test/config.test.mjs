import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig, writeConfig, resolveRoot, parseRootArg, validateCockpitRoot, ArgumentError, RootResolutionError, CockpitRootValidationError } from '../skill/lib/config.mjs';

function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-config-home-'));
  return { HOME: home };
}

function makeRoot({ nav = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-root-'));
  fs.mkdirSync(path.join(root, '.cockpit'));
  fs.writeFileSync(path.join(root, '.cockpit', 'sources.toml'), '');
  if (nav) fs.writeFileSync(path.join(root, '.cockpit', 'nav.toml'), '');
  return root;
}

test('readConfig reports missing config without throwing', () => {
  const env = makeEnv();
  const config = readConfig(env);
  assert.equal(config.ok, false);
  assert.equal(config.reason, 'missing_config');
  assert.match(config.configPath, /\.config\/cockpit\/config\.toml$/);
});

test('config helpers require explicit env objects', () => {
  assert.throws(() => readConfig(), /readConfig requires an explicit env object/);
  assert.throws(() => writeConfig(undefined, { cockpit_root: '/tmp/root' }), /writeConfig requires an explicit env object/);
});

test('writeConfig preserves unknown top-level keys', () => {
  const env = makeEnv();
  writeConfig(env, { cockpit_root: '/tmp/old', custom_key: 'keep' });
  writeConfig(env, { cockpit_root: '/tmp/new' });
  const config = readConfig(env);
  assert.equal(config.cockpitRoot, '/tmp/new');
  assert.equal(config.values.custom_key, 'keep');
});

test('parseRootArg errors when a root flag has no path value', () => {
  assert.throws(() => parseRootArg(['--root']), ArgumentError);
  assert.throws(() => parseRootArg(['--cockpit-root']), /requires a path argument/);
  assert.throws(() => parseRootArg(['--root', '--json']), /requires a path argument/);
  assert.throws(() => parseRootArg(['--cockpit-root=']), /requires a path argument/);
  assert.equal(parseRootArg(['--root=/tmp/cockpit']), '/tmp/cockpit');
});

test('resolveRoot precedence is arg, env, config with mismatch warning', () => {
  const env = makeEnv();
  const configRoot = makeRoot();
  const envRoot = makeRoot();
  const argRoot = makeRoot();
  writeConfig(env, { cockpit_root: configRoot });
  const stderr = { text: '', write(chunk) { this.text += chunk; } };
  assert.equal(resolveRoot({ argv: ['--root', argRoot], env, stderr }).root, argRoot);
  assert.equal(stderr.text, '');
  const envWithHome = { ...env, COCKPIT_HOME: envRoot };
  const fromEnv = resolveRoot({ argv: [], env: envWithHome, stderr });
  assert.equal(fromEnv.root, envRoot);
  assert.equal(fromEnv.source, 'env');
  assert.match(stderr.text, /COCKPIT_HOME/);
  const fromConfig = resolveRoot({ argv: [], env, stderr });
  assert.equal(fromConfig.root, configRoot);
  assert.equal(fromConfig.source, 'config');
});

test('resolveRoot gives remediation when no source exists', () => {
  const env = makeEnv();
  assert.throws(() => resolveRoot({ argv: [], env }), (error) => {
    assert.ok(error instanceof RootResolutionError);
    assert.match(error.message, /scripts\/link\.mjs <path>/);
    return true;
  });
});

test('validateCockpitRoot requires marker directory and sources manifest, with nav optional', () => {
  const validWithoutNav = makeRoot({ nav: false });
  assert.equal(validateCockpitRoot(validWithoutNav).root, validWithoutNav);
  assert.throws(() => validateCockpitRoot(path.join(validWithoutNav, 'missing')), CockpitRootValidationError);
  const fileRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-file-root-')), 'file');
  fs.writeFileSync(fileRoot, 'not dir');
  assert.throws(() => validateCockpitRoot(fileRoot), /not a directory/);
  const noMarker = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-no-marker-'));
  assert.throws(() => validateCockpitRoot(noMarker), /missing \.cockpit/);
  const noSources = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-no-sources-'));
  fs.mkdirSync(path.join(noSources, '.cockpit'));
  assert.throws(() => validateCockpitRoot(noSources), /sources\.toml/);
});

test('resolveRoot validates roots for write operations', () => {
  const env = makeEnv();
  const root = makeRoot();
  writeConfig(env, { cockpit_root: root });
  assert.equal(resolveRoot({ env, forWrite: true }).root, root);
  writeConfig(env, { cockpit_root: path.join(root, 'missing') });
  assert.throws(() => resolveRoot({ env, forWrite: true }), CockpitRootValidationError);
});
