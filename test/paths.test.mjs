import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expandHome, configPath, kitRoot, isPathInside, assertNode20 } from '../skill/lib/paths.mjs';

test('expandHome and configPath honor explicit env', () => {
  assert.equal(expandHome('~/cockpit', { HOME: '/home/test' }), '/home/test/cockpit');
  assert.equal(configPath({ HOME: '/home/test' }), '/home/test/.config/cockpit/config.toml');
  assert.equal(configPath({ HOME: '/home/test', XDG_CONFIG_HOME: '/tmp/xdg' }), '/tmp/xdg/cockpit/config.toml');
});

test('kitRoot resolves from script and lib import URLs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-kit-root-'));
  fs.mkdirSync(path.join(tmp, 'scripts'));
  fs.mkdirSync(path.join(tmp, 'lib'));
  fs.writeFileSync(path.join(tmp, 'scripts', 'where.mjs'), '');
  fs.writeFileSync(path.join(tmp, 'lib', 'paths.mjs'), '');
  assert.equal(kitRoot(pathToFileURL(path.join(tmp, 'scripts', 'where.mjs')).href), fs.realpathSync.native(tmp));
  assert.equal(kitRoot(pathToFileURL(path.join(tmp, 'lib', 'paths.mjs')).href), fs.realpathSync.native(tmp));
});

test('isPathInside handles dot-dot, absolute paths, and symlink escapes', { skip: process.platform === 'win32' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-paths-'));
  const root = path.join(tmp, 'root');
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'file.txt'), 'ok');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
  fs.symlinkSync(outside, path.join(root, 'escape'), 'dir');
  assert.equal(isPathInside(path.join(root, 'file.txt'), root), true);
  assert.equal(isPathInside(path.join(root, '..', 'outside', 'secret.txt'), root), false);
  assert.equal(isPathInside(path.join(root, 'escape', 'secret.txt'), root), false);
  assert.equal(isPathInside(path.join(root, 'new', 'page.html'), root), true);
});

test('assertNode20 enforces the runtime floor', () => {
  assert.doesNotThrow(() => assertNode20('20.0.0'));
  assert.doesNotThrow(() => assertNode20('22.1.0'));
  assert.throws(() => assertNode20('19.9.0'), /requires Node.js 20/);
});
