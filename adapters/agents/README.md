# Generic Agents Adapter

Target path:

```text
~/.agents/skills/cockpit -> /absolute/path/to/cockpit-kit
```

Discovery order is host-specific, but generic agents should load skills from:

```text
~/.agents/skills/*/SKILL.md
```

Install with setup:

```bash
node scripts/setup.mjs --cockpit-root /path/to/cockpit --adapters agents
```

Manual install:

```bash
mkdir -p ~/.agents/skills
ln -s /absolute/path/to/cockpit-kit ~/.agents/skills/cockpit
```

Uninstall:

```bash
rm ~/.agents/skills/cockpit
```

Enforcement level: advisory. The host reads `SKILL.md`, but this adapter does not technically restrict filesystem writes or git commands.

Update hygiene: this is a live symlink to executable agent policy. Review Cockpit Kit diffs before pulling updates; prefer tagged releases once they exist.
