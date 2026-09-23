#!/usr/bin/env bash
# A missed hourly result is grounds for disqualification (5.4.8), and three people push to one main.
# One command: secret scan + zone check (hard stops) → quick tests (recorded, never block) → PROGRESS line →
# commit tagged with your role → rebase onto the team's work → push with retries.
# On a rebase conflict it aborts cleanly: your commit stays local, the repo is never left half-rebased.
# Usage: scripts/checkpoint.sh "what was done"      (ZONE_OK=1 … for an agreed edit in someone else's zone)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
msg="$*"
if [ -z "$msg" ]; then echo 'Использование: scripts/checkpoint.sh "what was done"'; exit 1; fi
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
  echo "✖ Незаконченный rebase: git status → поправь → git add → git rebase --continue (или git rebase --abort)"
  exit 1
fi
now=$(date '+%H:%M')
who=$(git config user.name || echo unknown)
role=$(git config ctrlx.role 2>/dev/null || true)
tag=""; [ -n "$role" ] && tag="[$role] "

# `timeout` is not on stock macOS; perl alarm is.
with_timeout() { perl -e 'alarm shift; exec @ARGV' "$@"; }
log="${TMPDIR:-/tmp}/ctrlx-checkpoint-tests.log"
tests="n/a"
if [ -f package.json ] && grep -q '"test"' package.json; then
  if with_timeout 120 pnpm -s test >"$log" 2>&1; then tests="pass"; else tests="FAIL"; fi
elif [ -f pyproject.toml ]; then
  if with_timeout 120 uv run pytest -q >"$log" 2>&1; then tests="pass"; else tests="FAIL"; fi
fi
[ "$tests" = "FAIL" ] && echo "⚠ тесты упали (push всё равно делаем), лог: $log"

git add -A || { echo "✖ Не удалось подготовить файлы: проверь активный git-процесс и повтори checkpoint."; exit 1; }
if ! scripts/secret-scan.sh --staged; then
  git reset -q; echo "✖ Checkpoint отменён: в изменениях секрет. Убери его и повтори."; exit 1
fi
if ! scripts/zones.sh; then
  git reset -q; echo "✖ Checkpoint отменён: правка чужой зоны (см. выше)."; exit 1
fi

mkdir -p docs
[ -f docs/PROGRESS.md ] || printf '# Прогресс по часам (п. 5.4.8)\n\n' > docs/PROGRESS.md
printf -- '- %s · %s · %s · %s · тесты: %s\n' "$now" "${role:-?}" "$who" "$msg" "$tests" >> docs/PROGRESS.md
git add docs/PROGRESS.md || { echo "✖ Не удалось подготовить журнал прогресса."; exit 1; }
git commit -q -m "${tag}checkpoint $now: $msg" || { echo "✖ commit не прошёл (см. выше)"; exit 1; }

for attempt in 1 2 3 4 5; do
  if ! git pull -q --rebase --autostash 2>/dev/null; then
    conflicts=$(git diff --name-only --diff-filter=U 2>/dev/null)
    git rebase --abort 2>/dev/null
    echo "✖ Конфликт с изменениями команды. Твой коммит сохранён локально, репо в чистом состоянии."
    for f in $conflicts; do echo "   $f → зона $(scripts/zones.sh --owner "$f")"; done
    echo "→ Файл твоей зоны: git pull --rebase → поправь → git add <файл> → git rebase --continue → scripts/checkpoint.sh \"merge fix\""
    echo "→ Файл чужой зоны: возьми версию команды — git pull --rebase → git checkout --ours <файл> → git add <файл> → GIT_EDITOR=true git rebase --continue (коммит стал пустым — git rebase --skip) → scripts/checkpoint.sh \"...\"; свою правку опиши владельцу"
    exit 1
  fi
  if git push -q 2>/dev/null; then
    echo "✔ $now · ${tag}$(git rev-parse --short HEAD) · тесты: $tests"
    exit 0
  fi
  # someone pushed in the same second: back off a random 1–4 s so three laptops don't collide again
  sleep $(( (RANDOM % 4) + 1 ))
done
echo "✖ push не прошёл 5 раз — проверь сеть и права (gh auth status). Коммит сохранён локально."
exit 1
