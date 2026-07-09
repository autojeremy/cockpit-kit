# Claude Adapter

Target path:

```text
~/.claude/skills/cockpit -> /absolute/path/to/cockpit-kit/skill
```

Install with setup:

```bash
node skill/scripts/setup.mjs --cockpit-root /path/to/cockpit --adapters claude
```

Manual install:

```bash
mkdir -p ~/.claude/skills
ln -s /absolute/path/to/cockpit-kit/skill ~/.claude/skills/cockpit
```

Uninstall:

```bash
rm ~/.claude/skills/cockpit
```

Resolution order is Claude-host-specific; this adapter assumes Claude loads `SKILL.md` from `~/.claude/skills/cockpit`.

Enforcement level: advisory unless Claude Code permission rules or hooks are configured. The skill instructs the agent to scope work to `$COCKPIT_ROOT`, but natural-language policy alone is not mechanism-level enforcement.

Permission-rules example:

```json
{
  "permissions": {
    "deny": [
      "Write(**)",
      "Edit(**)",
      "MultiEdit(**)",
      "Bash(git add:*)",
      "Bash(git commit:*)"
    ],
    "allow": [
      "Read($COCKPIT_ROOT/**)",
      "Write($COCKPIT_ROOT/**)",
      "Edit($COCKPIT_ROOT/**)",
      "MultiEdit($COCKPIT_ROOT/**)",
      "Bash(git -C $COCKPIT_ROOT add:*)",
      "Bash(git -C $COCKPIT_ROOT commit:*)"
    ]
  }
}
```

Treat this as a concrete starting point, not a universal schema guarantee; adapt it to the permission-rule syntax supported by your Claude Code version. Hooks are the stronger option when available because they can inspect resolved paths and reject writes or ambient git commands at execution time.

Update hygiene: this is a live symlink to executable agent policy. Review Cockpit Kit diffs before pulling updates; prefer tagged releases once they exist.
