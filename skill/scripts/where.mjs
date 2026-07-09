#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { kitRoot, assertNode20, expandHome } from '../lib/paths.mjs';
import { resolveRoot, RootResolutionError } from '../lib/config.mjs';

function comparablePath(input, env) {
  const resolved = path.resolve(expandHome(input, env));
  return fs.existsSync(resolved) ? fs.realpathSync.native(resolved) : resolved;
}

try {
  assertNode20();
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const resolved = resolveRoot({ argv, env: process.env, stderr: process.stderr });
  const inferredSkillRoot = kitRoot(import.meta.url);
  if (resolved.skillRoot && comparablePath(resolved.skillRoot, process.env) !== inferredSkillRoot) {
    process.stderr.write(`Warning: config skill_root (${path.resolve(expandHome(resolved.skillRoot, process.env))}) differs from inferred kit root (${inferredSkillRoot}); using inferred kit root.\n`);
  }
  const payload = {
    cockpit_root: resolved.root,
    skill_root: inferredSkillRoot,
    config_path: resolved.configPath,
    source: resolved.source,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`Cockpit root: ${payload.cockpit_root}\n`);
    process.stdout.write(`Source: ${payload.source}\n`);
    process.stdout.write(`Config: ${payload.config_path}\n`);
    process.stdout.write(`Kit root: ${payload.skill_root}\n`);
  }
} catch (error) {
  const message = error instanceof RootResolutionError ? error.message : `${error.name}: ${error.message}`;
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
