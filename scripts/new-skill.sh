#!/usr/bin/env bash
# The agent keeps making the same mistake in one place → capture the right way once, as a local skill for everyone.
# Creates .agents/skills/<name>/SKILL.md (Codex reads it) and the .claude/skills/<name> symlink (Claude reads it).
# Usage: scripts/new-skill.sh <name-in-kebab-case> "<when the agent must use it — one sentence>"
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
name="${1:-}"; desc="${2:-}"
if ! [[ "$name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo 'Использование: scripts/new-skill.sh <name-in-kebab-case> "<когда агент должен его применять>"'; exit 1
fi
[ -n "$desc" ] || { echo "✖ нужно описание: когда агент должен применять скилл"; exit 1; }
dir=".agents/skills/$name"
[ -e "$dir" ] && { echo "✖ $dir уже есть"; exit 1; }
mkdir -p "$dir" .claude/skills
# block scalar: the description may contain colons or quotes
{
  printf -- '---\nname: %s\ndescription: >-\n  %s\n---\n\n' "$name" "$desc"
  printf '# %s\n\n<!-- Правильный способ там, где агент ошибался: коротко, по шагам, с примером и проверкой. -->\n\n' "$name"
  printf '## Шаги\n1.\n\n## Пример\n\n## Как проверить\n'
} > "$dir/SKILL.md"
ln -s "../../$dir" ".claude/skills/$name"
echo "✔ $dir/SKILL.md и .claude/skills/$name — заполни шаги, затем scripts/checkpoint.sh \"docs: skill $name\""
