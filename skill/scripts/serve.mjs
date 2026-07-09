#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseServeConfig } from '../lib/serve-config.mjs';
import { ArgumentError, RootResolutionError, CockpitRootValidationError } from '../lib/config.mjs';
import { assertNode20, isPathInside } from '../lib/paths.mjs';

const cookieName = 'cockpit_serve';
const allowedCockpitPath = '.cockpit/search-index.json';

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
]);

function usage() {
  return `Usage: node scripts/serve.mjs [options]

Options:
  --root <path>       Cockpit root to serve
  --host <host>       Host to bind (default: 127.0.0.1)
  --port <port>       Port to bind (default: 18765)
  --auth              Enable local bearer-token cookie auth (default)
  --no-auth           Disable local bearer-token cookie auth
  --help              Show this help
`;
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    cookies.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return cookies;
}

function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function hostHeaderValues(host, port) {
  const bases = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (isLoopbackHost(host)) bases.add(host === '::1' ? '[::1]' : host);
  return new Set([...bases].map((value) => `${value}:${port}`));
}

function responseText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(text);
}

function decodedPathname(rawUrl) {
  const rawPath = String(rawUrl ?? '').split(/[?#]/, 1)[0] || '/';
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }
}

function safeRelativePath(rawUrl) {
  const pathname = decodedPathname(rawUrl);
  if (pathname === undefined || pathname.includes('\0')) return undefined;
  if (pathname.split('/').includes('..')) return undefined;
  const normalized = path.posix.normalize(pathname);
  const relative = normalized.replace(/^\/+/, '');
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return undefined;
  return relative === '' ? 'index.html' : relative;
}

function isCockpitPrivatePath(relative) {
  return relative === '.cockpit' || relative.startsWith('.cockpit/');
}

function resolveServedFile(root, rawUrl) {
  const relative = safeRelativePath(rawUrl);
  if (relative === undefined) return { status: 400 };
  const normalized = relative.endsWith('/') ? `${relative}index.html` : relative;
  if (isCockpitPrivatePath(normalized) && normalized !== allowedCockpitPath) return { status: 404 };

  const candidate = path.join(root, ...normalized.split('/'));
  let stat = fs.statSync(candidate, { throwIfNoEntry: false });
  let file = candidate;
  if (stat?.isDirectory()) {
    file = path.join(candidate, 'index.html');
    stat = fs.statSync(file, { throwIfNoEntry: false });
  }
  if (!stat || !stat.isFile()) return { status: 404 };

  const real = fs.realpathSync.native(file);
  if (!isPathInside(real, root)) return { status: 404 };
  return { status: 200, file: real, size: stat.size };
}

function requestHasAuth(req, token) {
  return timingSafeEqual(parseCookies(req.headers.cookie).get(cookieName) ?? '', token);
}

function requestToken(req) {
  try {
    return new URL(req.url, 'http://localhost').searchParams.get('token');
  } catch {
    return null;
  }
}

export function createServeServer(config, { token = crypto.randomBytes(32).toString('hex') } = {}) {
  const server = http.createServer((req, res) => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    const allowedHosts = hostHeaderValues(config.host, port);
    if (!allowedHosts.has(req.headers.host ?? '')) return responseText(res, 400, 'Bad Host header\n');

    if (config.auth) {
      const urlToken = requestToken(req);
      if (urlToken && timingSafeEqual(urlToken, token)) {
        // Set the cookie and redirect to the token-free URL so the secret
        // does not linger in the address bar, history, or same-origin Referer.
        res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`);
        res.writeHead(302, { Location: String(req.url ?? '/').split('?')[0] || '/' });
        return res.end();
      }
      if (!requestHasAuth(req, token)) {
        return responseText(res, 401, 'Authentication required\n');
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return responseText(res, 405, 'Method not allowed\n');
    const resolved = resolveServedFile(config.root, req.url);
    if (resolved.status !== 200) return responseText(res, resolved.status, resolved.status === 400 ? 'Bad path\n' : 'Not found\n');

    let stream;
    if (req.method !== 'HEAD') {
      stream = fs.createReadStream(resolved.file);
      stream.on('error', (error) => {
        if (!res.headersSent) responseText(res, 500, 'File read error\n');
        else res.destroy(error);
      });
    }
    res.writeHead(200, {
      'Content-Type': contentTypes.get(path.extname(resolved.file).toLowerCase()) ?? 'application/octet-stream',
      'Content-Length': String(resolved.size),
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else stream.pipe(res);
  });
  server.cockpitToken = token;
  return server;
}

export function servedUrl(config, token = undefined) {
  const host = config.host === '::1' ? '[::1]' : config.host;
  const url = new URL(`http://${host}:${config.port}/`);
  if (config.auth && token) url.searchParams.set('token', token);
  return url.href;
}

async function main() {
  assertNode20();
  const config = parseServeConfig({ argv: process.argv.slice(2), env: process.env, stderr: process.stderr });
  if (config.help) {
    process.stdout.write(usage());
    return;
  }
  const server = createServeServer(config);
  server.on('error', (error) => {
    process.stderr.write(`serve.mjs failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
  // getaddrinfo can't resolve the bracketed literal [::1]; only bare ::1 binds.
  const bindHost = config.host === '[::1]' ? '::1' : config.host;
  server.listen(config.port, bindHost, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    const boundConfig = { ...config, port };
    process.stdout.write(`Cockpit root: ${config.root}\n`);
    process.stdout.write(`Serving: ${servedUrl(boundConfig, server.cockpitToken)}\n`);
  });
}

function isCliEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isCliEntrypoint()) {
  main().catch((error) => {
    const expected = error instanceof ArgumentError || error instanceof RootResolutionError || error instanceof CockpitRootValidationError;
    process.stderr.write(`${expected ? error.message : `${error.name}: ${error.message}`}\n`);
    process.exitCode = 1;
  });
}
