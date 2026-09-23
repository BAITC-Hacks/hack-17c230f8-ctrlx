#!/usr/bin/env bash
# Safety net for the hourly result (5.4.8). Start once after 13:00 in a spare terminal tab and forget about it.
# :35 — macOS notification; :45 (17:35 in the last hour) — if you have unpushed work and your own last push
# is older than 25 min, runs scripts/checkpoint.sh "wip: auto checkpoint" (tests take up to 2 min, so the push
# still lands before :50). 17:40 — final push reminder. Stops at 17:45. Costs zero tokens.
# Usage: scripts/autopush.sh [--once]
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
# an empty email would make --author match everyone, so the team's pushes would count as yours
[ -n "$(git config user.email)" ] || { echo "✖ user.email пуст — сначала scripts/setup.sh"; exit 1; }

notify() {
  osascript -e "display notification \"$1\" with title \"CtrlX\" sound name \"Glass\"" >/dev/null 2>&1 ||
    powershell.exe -NoProfile -Command "[console]::beep(880,400)" >/dev/null 2>&1 || true  # Windows (Git Bash): sound only
  echo "$(date +%H:%M) $1"
}
my_push_age() {
  local t
  t=$(git log -1 --format=%ct --author="$(git config user.email)" '@{u}' 2>/dev/null)
  if [ -n "$t" ]; then echo $(( ($(date +%s) - t) / 60 )); else echo 999; fi
}
has_work() {
  [ -n "$(git status --porcelain)" ] || [ "$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)" != "0" ]
}
min_age="${AUTOPUSH_MIN_AGE:-25}"
tick() {
  local age; age=$(my_push_age)
  if has_work && [ "$age" -ge "$min_age" ]; then
    notify "авто-checkpoint: твой последний push ${age}м назад"
    scripts/checkpoint.sh "wip: auto checkpoint $(date +%H:%M)" || notify "авто-checkpoint НЕ прошёл — смотри терминал"
  else
    echo "$(date +%H:%M) ок: твой push ${age}м назад, срочного нет"
  fi
}

if [ "${1:-}" = "--once" ]; then tick; exit 0; fi
echo "autopush: уведомление в :35, авто-checkpoint в :45 (17:35), 17:40 — финальный push, стоп в 17:45. Выход — Ctrl-C."
last=""
while :; do
  hm=$(date +%H:%M)
  if [[ "$hm" > "17:45" ]]; then echo "17:45 — autopush остановлен"; exit 0; fi
  if [ "$hm" != "$last" ]; then
    last=$hm
    case "$hm" in
      13:35|14:35|15:35|16:35|17:25) notify "через 10 минут checkpoint: scripts/checkpoint.sh \"...\"" ;;
      13:45|14:45|15:45|16:45|17:35) tick ;;
      17:40) notify "ФИНАЛЬНЫЙ push сейчас: scripts/checkpoint.sh \"...\"" ;;
    esac
  fi
  sleep 20
done
