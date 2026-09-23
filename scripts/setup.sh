#!/usr/bin/env bash
# One-time setup for each teammate right after `git clone`: who you are (auto-detected from your GitHub login),
# commit identity, hooks, local env, deps.
# Usage: scripts/setup.sh [id]   (ids — строки MEMBER в docs/ZONES.md: mustafa, amirkhan, ansar)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
team=$(scripts/team.sh ids)
# who is at this keyboard: the GitHub account gh is logged into, else the noreply commit email
login=$(gh api user --jq .login 2>/dev/null || true)
[ -z "$login" ] && login=$(git config user.email 2>/dev/null | sed -n 's/^[0-9]*+\([^@]*\)@users\.noreply\.github\.com$/\1/p')
detected=""; [ -n "$login" ] && detected=$(scripts/team.sh whois "$login")
role="${1:-${detected:-$(git config ctrlx.role 2>/dev/null || true)}}"
known=0; for t in $team; do [ "$t" = "$role" ] && known=1; done
if [ "$known" != 1 ]; then
  if [ -n "${1:-}" ]; then why="нет такого id: $1"
  elif [ -n "$login" ]; then why="GitHub @$login нет в docs/ZONES.md (строки MEMBER)"
  else why="gh не залогинен, id не указан"; fi
  echo "✖ не понял, кто ты ($why). Укажи: scripts/setup.sh <$(echo $team | tr ' ' '|')>"; exit 1
fi
if [ -n "$detected" ] && [ "$detected" != "$role" ]; then
  echo "⚠ gh залогинен как @$login ($detected), а выбран $role (@$(scripts/team.sh login "$role")) — проверь, что это твой ноутбук"
fi
git config ctrlx.role "$role"
git config user.name "$(scripts/team.sh name "$role")"
email=$(scripts/team.sh email "$role"); [ -n "$email" ] && git config user.email "$email"
echo "✔ ты: $(scripts/team.sh whoami)"
echo "✔ коммиты: $(git config user.name) <$(git config user.email)> — засчитываются аккаунту @$(scripts/team.sh login "$role")"
git config core.hooksPath .githooks
git config pull.rebase true
git config rebase.autoStash true
chmod +x .githooks/* scripts/*.sh 2>/dev/null || true
echo "✔ pre-commit: проверка секретов и зон включена; git pull всегда с rebase"
# every participant can read this repo, so the team channel goes through the private toolkit cloned next to it
chat_url=$(git -C ../toolkit remote get-url origin 2>/dev/null || true)
if [ -n "$chat_url" ]; then
  git remote get-url teamchat >/dev/null 2>&1 || git remote add teamchat "$chat_url"
  git remote set-url teamchat "$chat_url"
  git config ctrlx.chatRemote teamchat
  git fetch -q teamchat +refs/heads/team-chat:refs/remotes/teamchat/team-chat 2>/dev/null || true
  git config ctrlx.chatSeen >/dev/null 2>&1 ||
    git config ctrlx.chatSeen "$(git show refs/remotes/teamchat/team-chat:CHAT.md 2>/dev/null | grep -c '^- ')"
  echo "✔ канал команды приватный: идёт через тулкит, в этом репо его не видно"
else
  echo "⚠ рядом нет ../toolkit — канал команды пойдёт в этот репо, а его читают все участники. Склонируй тулкит рядом и повтори scripts/setup.sh"
fi

if [ -z "$login" ]; then echo "⚠ gh не залогинен: push пойдёт через твой обычный git-логин. Проверь: git push --dry-run"; fi

if [ ! -f .env.local ] && [ -f .env.example ]; then
  cp .env.example .env.local && echo "✔ создан .env.local (ключи пустые → DEMO-режим)"
fi
# Team keys (Supabase etc.) never enter this public repo: they come from the private toolkit cloned next to it
# or from a file sent in the team chat (TEAM_ENV=path). Values are copied, never printed; a value already set wins.
team_env="${TEAM_ENV:-../toolkit/local/team.env}"
if [ -f "$team_env" ]; then
  touch .env.local; chmod 600 .env.local
  added=0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && [ -n "$val" ] || continue
    grep -q "^$key=." .env.local && continue
    grep -v "^$key=" .env.local > .env.local.tmp; mv .env.local.tmp .env.local
    printf '%s\n' "$line" >> .env.local; added=$((added + 1))
  done < "$team_env"
  echo "✔ ключи команды: добавлено в .env.local — $added (из $team_env, значения не печатаю)"
  grep -q '^SUPABASE_URL=.' .env.local && echo "  проверка Supabase: scripts/db-check.sh"
fi
[ -f package.json ] && pnpm install --prefer-offline
[ -f pyproject.toml ] && uv sync
for t in codex claude; do
  command -v "$t" >/dev/null 2>&1 && echo "✔ $t $("$t" --version 2>/dev/null | head -1)"
done
echo "Codex: при первом запуске в этой папке выбери «Trust» — подхватится .codex/config.toml (сеть в песочнице)."
echo "Дальше: открой агента в этой папке и дай ему первое сообщение из PLAYBOOK («Старт агента»)."
