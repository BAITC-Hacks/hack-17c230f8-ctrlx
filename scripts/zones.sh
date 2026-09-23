#!/usr/bin/env bash
# Conflicts come from two people editing the same file. Each teammate may modify or delete only files in their
# zone (docs/ZONES.md, written by /kickoff once the task is known); creating new files is free.
# Unassigned files (configs, lockfile) belong to the LEAD. Agreed cross-zone edit: ZONE_OK=1 scripts/checkpoint.sh "..."
# Usage: scripts/zones.sh            — check staged changes (pre-commit, checkpoint)
#        scripts/zones.sh --owner F  — print who owns file F
set -uo pipefail
set -f   # zone prefixes are plain paths, never globs
cd "$(git rev-parse --show-toplevel)" || exit 1
zones=docs/ZONES.md

line_of() { [ -f "$zones" ] && grep -E "^$1:" "$zones" | head -1 | cut -d: -f2-; }
team=$( [ -f "$zones" ] && grep -E '^MEMBER:' "$zones" | awk '{print $2}' | tr '\n' ' ' )
lead=$(line_of LEAD | tr -d ' ')
[ -z "$lead" ] && lead=$(echo $team | cut -d' ' -f1)

in_paths() {
  local f="$1" p; shift
  for p in "$@"; do case "$f" in "$p"|"$p"*) return 0 ;; esac; done
  return 1
}
owner_of() {
  local m
  case "$1" in docs/tasks/*.md)
    m=$(basename "$1" .md)
    for t in $team; do [ "$t" = "$m" ] && { echo "$m"; return; }; done ;;
  esac
  for m in $team; do
    # shellcheck disable=SC2046
    in_paths "$1" $(line_of "$m") && { echo "$m"; return; }
  done
  echo "${lead:-?}"
}
zones_defined() { local m; for m in $team; do [ -n "$(line_of "$m")" ] && return 0; done; return 1; }

if [ "${1:-}" = "--owner" ]; then owner_of "${2:-}"; exit 0; fi
[ "${ZONE_OK:-0}" = "1" ] && exit 0
zones_defined || exit 0   # zones appear at kickoff; before that there is nothing to check
role=$(git config ctrlx.role 2>/dev/null || true)
if [ -z "$role" ]; then
  echo "⚠ не задано, кто ты — зоны не проверены. Один раз: scripts/setup.sh <$(echo $team | tr ' ' '|')>"
  exit 0
fi

own=$(line_of "$role"); shared=$(line_of ALL)
bad=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ "$f" = "docs/tasks/$role.md" ] && continue
  # shellcheck disable=SC2086
  in_paths "$f" $own $shared && continue
  o=$(owner_of "$f")
  [ "$o" = "$role" ] && continue
  bad="$bad   $f → зона $o\n"
done < <(git diff --cached --name-only --diff-filter=MDR)

if [ -n "$bad" ]; then
  printf '✖ [%s] меняешь файлы чужой зоны — так и рождаются конфликты:\n%b' "$role" "$bad"
  echo "→ Нужна правка там: запиши в docs/tasks/$role.md → «Нужно от других» и скажи владельцу."
  echo "→ Уже согласовано с владельцем: ZONE_OK=1 scripts/checkpoint.sh \"...\""
  exit 1
fi
exit 0
