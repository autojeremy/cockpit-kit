# Hermes Adapter

Target path:

```text
<hermes-home>/skills/productivity/cockpit -> /absolute/path/to/cockpit-kit
```

Hermes home resolution order:

1. `--hermes-home <path>` passed to `scripts/setup.mjs`.
2. `$HERMES_HOME`.
3. `~/.hermes`.

Install with setup:

```bash
node scripts/setup.mjs --cockpit-root /path/to/cockpit --adapters hermes
```

Override Hermes home:

```bash
node scripts/setup.mjs --cockpit-root /path/to/cockpit --adapters hermes --hermes-home /path/to/hermes-home
```

Manual install:

```bash
mkdir -p ~/.hermes/skills/productivity
ln -s /absolute/path/to/cockpit-kit ~/.hermes/skills/productivity/cockpit
```

Uninstall:

```bash
rm ~/.hermes/skills/productivity/cockpit
```

Enforcement level: advisory by default. Configure Hermes tool restrictions separately if you need mechanism-level write or command scoping.

Update hygiene: symlinked skills are live agent policy. Review Cockpit Kit diffs before pulling updates; prefer tagged releases once they exist. Do not point this adapter at private profile layouts unless you explicitly pass that location with `--hermes-home`.
