import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { parseServeConfig } from '../lib/serve-config.mjs';
import { writeConfig } from '../lib/config.mjs';
import { createServeServer } from '../scripts/serve.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeRoot() {
  const root = tempDir('cockpit-serve-root-');
  fs.mkdirSync(path.join(root, '.cockpit'), { recursive: true });
  fs.writeFileSync(path.join(root, '.cockpit', 'sources.toml'), '');
  fs.writeFileSync(path.join(root, '.cockpit', 'serve.toml'), 'host = "127.0.0.1"\nport = 18766\nauth = true\n');
  fs.writeFileSync(path.join(root, '.cockpit', 'search-index.json'), '{"kind":"cockpit-search-index","pages":[]}\n');
  fs.writeFileSync(path.join(root, '.cockpit', 'private.toml'), 'secret = "no"\n');
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>Home</h1>');
  fs.mkdirSync(path.join(root, 'folder'));
  fs.writeFileSync(path.join(root, 'folder', 'index.html'), '<h1>Folder</h1>');
  return root;
}

function cleanEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, ...extra };
  delete env.COCKPIT_HOME;
  if (!Object.hasOwn(extra, 'XDG_CONFIG_HOME')) delete env.XDG_CONFIG_HOME;
  return env;
}

async function withServer(config, fn) {
  const server = createServeServer(config, { token: 'test-token' });
  try {
    server.listen(0, config.host);
    await once(server, 'listening');
    const { port } = server.address();
    await fn({ port, token: server.cockpitToken });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function request({ port, path: requestPath = '/', host = `127.0.0.1:${port}`, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: requestPath, headers: { Host: host, ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serve config applies defaults, serve.toml, and CLI precedence', () => {
  const home = tempDir('cockpit-serve-home-');
  const root = makeRoot();
  const env = cleanEnv(home);
  writeConfig(env, { cockpit_root: root });

  const fromFile = parseServeConfig({ argv: [], env });
  assert.equal(fromFile.root, fs.realpathSync.native(root));
  assert.equal(fromFile.host, '127.0.0.1');
  assert.equal(fromFile.port, 18766);
  assert.equal(fromFile.auth, true);

  const cli = parseServeConfig({ argv: ['--host', 'localhost', '--port', '0', '--no-auth'], env });
  assert.equal(cli.host, 'localhost');
  assert.equal(cli.port, 0);
  assert.equal(cli.auth, false);

  fs.rmSync(path.join(root, '.cockpit', 'serve.toml'));
  const defaults = parseServeConfig({ argv: ['--root', root], env });
  assert.equal(defaults.host, '127.0.0.1');
  assert.equal(defaults.port, 18765);
  assert.equal(defaults.auth, true);

  const escapedRoot = parseServeConfig({ argv: ['--root', '--', root], env });
  assert.equal(escapedRoot.root, fs.realpathSync.native(root));
});

test('serve rejects Host, traversal, bad encodings, and private .cockpit paths', async () => {
  const root = makeRoot();
  const outside = path.join(tempDir('cockpit-serve-outside-'), 'secret.html');
  fs.writeFileSync(outside, 'outside');
  fs.symlinkSync(outside, path.join(root, 'outside.html'));

  await withServer({ root: fs.realpathSync.native(root), host: '127.0.0.1', port: 0, auth: false }, async ({ port }) => {
    assert.equal((await request({ port, host: `evil.example:${port}` })).status, 400);
    assert.equal((await request({ port, path: '/%2e%2e/secret' })).status, 400);
    assert.equal((await request({ port, path: '/%zz' })).status, 400);
    assert.equal((await request({ port, path: '/outside.html' })).status, 404);
    assert.equal((await request({ port, path: '/.cockpit/private.toml' })).status, 404);

    const index = await request({ port, path: '/.cockpit/search-index.json' });
    assert.equal(index.status, 200);
    assert.match(index.body, /cockpit-search-index/);
  });
});

test('serve enforces token-then-cookie flow and supports --no-auth behavior', async () => {
  const root = makeRoot();
  await withServer({ root: fs.realpathSync.native(root), host: '127.0.0.1', port: 0, auth: true }, async ({ port, token }) => {
    assert.equal((await request({ port })).status, 401);
    assert.equal((await request({ port, cookie: 'cockpit_serve=wrong' })).status, 401);
    assert.equal((await request({ port, path: '/.cockpit/search-index.json' })).status, 401);
    const withToken = await request({ port, path: `/?token=${token}` });
    assert.equal(withToken.status, 302);
    assert.equal(withToken.headers.location, '/');
    const cookie = withToken.headers['set-cookie'][0].split(';')[0];
    assert.equal(cookie, `cockpit_serve=${token}`);
    assert.equal((await request({ port, cookie })).status, 200);
    assert.equal((await request({ port, path: '/.cockpit/search-index.json', cookie })).status, 200);
  });

  await withServer({ root: fs.realpathSync.native(root), host: '127.0.0.1', port: 0, auth: false }, async ({ port }) => {
    assert.equal((await request({ port })).status, 200);
  });
});

test('serve resolves folder URLs to index.html', async () => {
  const root = makeRoot();
  await withServer({ root: fs.realpathSync.native(root), host: '127.0.0.1', port: 0, auth: false }, async ({ port }) => {
    const response = await request({ port, path: '/folder/' });
    assert.equal(response.status, 200);
    assert.match(response.body, /Folder/);
  });
});

function copyKit(target) {
  fs.cpSync(repoRoot, target, {
    recursive: true,
    filter: (src) => !path.relative(repoRoot, src).split(path.sep).includes('.git'),
  });
}

function spawnServe(script, args, env) {
  const child = spawn(process.execPath, [script, ...args], { env, cwd: path.dirname(path.dirname(script)), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  return child;
}

async function waitForServing(child) {
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for await (const chunk of child.stdout) {
    stdout += chunk;
    const match = stdout.match(/Serving: (http:\/\/[^\s]+)/);
    if (match) return match[1];
  }
  throw new Error(`serve.mjs exited before printing URL. stdout=${stdout} stderr=${stderr}`);
}

test('e2e setup, unrelated repo where, and authenticated serve', async () => {
  const home = tempDir('cockpit-e2e-home-');
  const kit = path.join(tempDir('cockpit-e2e-kit-parent-'), 'cockpit-kit');
  const root = path.join(home, 'starter-root');
  copyKit(kit);
  const env = cleanEnv(home);

  const setup = spawnSync(process.execPath, [path.join(kit, 'scripts', 'setup.mjs'), '--yes', '--cockpit-root', root, '--adapters', 'agents', '--no-git'], { cwd: kit, env, encoding: 'utf8' });
  assert.equal(setup.status, 0, setup.stderr);

  const unrelated = tempDir('cockpit-unrelated-repo-');
  assert.equal(spawnSync('git', ['init'], { cwd: unrelated, encoding: 'utf8' }).status, 0);
  const before = spawnSync('git', ['status', '--porcelain'], { cwd: unrelated, encoding: 'utf8' });
  assert.equal(before.stdout, '');

  const where = spawnSync(process.execPath, [path.join(kit, 'scripts', 'where.mjs'), '--json'], { cwd: unrelated, env, encoding: 'utf8' });
  assert.equal(where.status, 0, where.stderr);
  assert.equal(JSON.parse(where.stdout).cockpit_root, root);
  const after = spawnSync('git', ['status', '--porcelain'], { cwd: unrelated, encoding: 'utf8' });
  assert.equal(after.stdout, '');

  const child = spawnServe(path.join(kit, 'scripts', 'serve.mjs'), ['--root', root, '--port', '0'], env);
  try {
    const served = await waitForServing(child);
    const token = new URL(served).searchParams.get('token');
    const searchUrl = new URL('/search/', served);
    searchUrl.searchParams.set('token', token);
    const tokenRedirect = await fetch(searchUrl, { redirect: 'manual' });
    assert.equal(tokenRedirect.status, 302);
    const cookie = tokenRedirect.headers.get('set-cookie').split(';')[0];
    const searchPage = await fetch(new URL(tokenRedirect.headers.get('location'), served), { headers: { Cookie: cookie } });
    assert.equal(searchPage.status, 200);
    assert.match(await searchPage.text(), /cockpit-search/);
    const index = await fetch(new URL('/.cockpit/search-index.json', served), { headers: { Cookie: cookie } });
    assert.equal(index.status, 200);
    assert.equal((await index.json()).kind, 'cockpit-search-index');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'close').catch(() => {});
  }
});
