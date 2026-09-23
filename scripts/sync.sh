#!/usr/bin/env bash
# Start of every task: pull teammates' work and show who is doing what, so two agents never build the same thing
# and nobody works on a stale base (the main source of rebase conflicts).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
  echo "✖ незаконченный rebase: доведи (git status) или git rebase --abort"; exit 1
fi
before=$(git rev-parse HEAD)
if ! git pull -q --rebase --autostash; then
  git rebase --abort 2>/dev/null
  echo "✖ sync не прошёл (конфликт или сеть) — репо не изменено. Смотри git status"; exit 1
fi
incoming=$(git diff --name-only "$before" HEAD 2>/dev/null | head -15)
if [ -n "$incoming" ]; then echo "↓ пришло от команды:"; echo "$incoming" | sed 's/^/   /'; fi

# the lead adds dependencies; without this a teammate's agent hits "module not found" after the pull
changed() { git diff --name-only "$before" HEAD 2>/dev/null | grep -qx "$1"; }
if [ -f package.json ] && { [ ! -d node_modules ] || changed pnpm-lock.yaml || changed package.json; }; then
  echo "… pnpm install (изменились зависимости)"; pnpm install --prefer-offline --silent || echo "✖ pnpm install не прошёл"
fi
if [ -f pyproject.toml ] && { [ ! -d .venv ] || changed uv.lock || changed pyproject.toml; }; then
  echo "… uv sync (изменились зависимости)"; uv sync -q || echo "✖ uv sync не прошёл"
fi

echo "Ты: $(scripts/team.sh whoami 2>/dev/null || echo 'не задано — scripts/setup.sh')"
echo "Команда сейчас:"
scripts/team.sh board | sed 's/^/  /'
scripts/msg.sh inbox 2>/dev/null | sed 's/^/  /'
