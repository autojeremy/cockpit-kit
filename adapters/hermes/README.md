# Hermes Adapter

Target path:

```text
<hermes-home>/skills/productivity/cockpit -> /absolute/path/to/cockpit-kit/skill
```

Hermes home resolution order:

1. `--hermes-home <path>` passed to `skill/scripts/setup.mjs`.
2. `$HERMES_HOME`.
3. `~/.hermes`.

Install with setup:

```bash
node skill/scripts/setup.mjs --cockpit-root /path/to/cockpit --adapters hermes
```

Override Hermes home:

```bash
node skill/scripts/setup.mjs --cockpit-root /path/to/cockpit --adapters hermes --hermes-home /path/to/hermes-home
```

Manual install:

```bash
mkdir -p ~/.hermes/skills/productivity
ln -s /absolute/path/to/cockpit-kit/skill ~/.hermes/skills/productivity/cockpit
```

Uninstall:

```bash
rm ~/.hermes/skills/productivity/cockpit
```

Enforcement level: advisory by default. Configure Hermes tool restrictions separately if you need mechanism-level write or command scoping.

Update hygiene: symlinked skills are live agent policy. Review Cockpit Kit diffs before pulling updates; prefer tagged releases once they exist. Do not point this adapter at private profile layouts unless you explicitly pass that location with `--hermes-home`.
