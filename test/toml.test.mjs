import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToml, stringifyToml, TomlParseError } from '../skill/lib/toml.mjs';

test('parses the Phase 0 TOML subset', () => {
  const data = parseToml(`# comment\n[[nav]]\nlabel = "Inbox"\nhref = "inbox/"\n\n[sources.example-notes]\nkind = "file"\npath = "~/notes/example"\n\n[serve]\nhost = "127.0.0.1"\nport = 18765\nauth = true\nnames = ["a", "b\\nt"]\n`);
  assert.equal(data.nav[0].label, 'Inbox');
  assert.equal(data.sources['example-notes'].kind, 'file');
  assert.equal(data.serve.port, 18765);
  assert.equal(data.serve.auth, true);
  assert.deepEqual(data.serve.names, ['a', 'b\nt']);
});

test('rejects unsupported constructs with line-numbered errors', () => {
  const cases = [
    ['dotted key', 'a.b = "c"', /line 1: dotted keys/],
    ['inline table', 'a = { b = "c" }', /line 1: inline tables/],
    ['literal string', "a = 'b'", /line 1: literal strings/],
    ['float', 'a = 1.5', /line 1: floats/],
    ['date', 'a = 2026-07-05', /line 1: dates/],
    ['nested array', 'a = [["b"]]', /line 1: nested arrays/],
    ['deep table', '[a.b.c]\nx = "y"', /line 1: table headers deeper/],
    ['dotted array table', '[[a.b]]\nx = "y"', /line 1: arrays of tables with dotted names/],
    ['duplicate scalar', 'a = "b"\na = "c"', /line 2: duplicate key/],
    ['scalar to table', 'a = "b"\n[a]\nx = "y"', /line 2: type change/],
  ];
  for (const [name, input, pattern] of cases) {
    assert.throws(() => parseToml(input), (error) => {
      assert.ok(error instanceof TomlParseError, name);
      assert.match(error.message, pattern, name);
      return true;
    });
  }
});

test('stringify round-trips config and preserves unknown top-level keys', () => {
  const original = parseToml('cockpit_root = "/tmp/old"\nunknown_key = "keep"\ncount = 2\n');
  const rendered = stringifyToml({ ...original, cockpit_root: '/tmp/new' });
  const reparsed = parseToml(rendered);
  assert.equal(reparsed.cockpit_root, '/tmp/new');
  assert.equal(reparsed.unknown_key, 'keep');
  assert.equal(reparsed.count, 2);
  assert.match(rendered, /Comments may be rewritten/);
});

test('stringify rejects unsupported nested structures instead of dropping them', () => {
  assert.throws(
    () => stringifyToml({ top: { items: [{ a: 1 }] } }),
    /unsupported nested TOML structure under top\.items/,
  );
});
