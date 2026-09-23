#!/usr/bin/env bash
# The team repo becomes public: a leaked key gets auto-revoked and GitHub push protection
# can reject the final push at 17:55. No dependencies (BSD/GNU grep via git grep).
# Usage: scripts/secret-scan.sh [--staged|--all|--stdin]   (--stdin: checks text, e.g. a team chat message)
set -uo pipefail
mode="${1:---staged}"
cd "$(git rev-parse --show-toplevel)" || exit 1

patterns=(
  # key must start a token: "risk-scoring-…", "mask-…" or "task-…" in slugs and URLs are not keys
  '(^|[^A-Za-z0-9_-])sk-(proj-|svcacct-|admin-|ant-)?[A-Za-z0-9_-]{20,}'
  'nvapi-[A-Za-z0-9_-]{20,}'
  'sb_secret_[A-Za-z0-9_-]{10,}'
  'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
  '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----'
  'AKIA[0-9A-Z]{16}'
  'gh[pousr]_[A-Za-z0-9]{36,}'
  'github_pat_[A-Za-z0-9_]{40,}'
  'AIza[0-9A-Za-z_-]{35}'
  '(sk|rk)_live_[0-9A-Za-z]{20,}'
  'gsk_[A-Za-z0-9]{40,}'
  '(^|[^A-Za-z0-9_])hf_[A-Za-z0-9]{30,}'
  '[0-9]{8,10}:AA[A-Za-z0-9_-]{33}'
)
args=()
for p in "${patterns[@]}"; do args+=(-e "$p"); done

if [ "$mode" = "--stdin" ]; then
  if grep -E -q "${args[@]}"; then echo "✖ в тексте похоже на ключ/токен — не отправляю"; exit 1; fi
  exit 0
fi

if [ "$mode" = "--all" ]; then
  files=$(git ls-files -co --exclude-standard)
  grep_scope=(--untracked)
else
  files=$(git diff --cached --name-only --diff-filter=ACMR)
  grep_scope=(--cached)
fi
[ -z "$files" ] && exit 0

fail=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  base=$(basename "$f")
  case "$base" in
    .env.example) ;;
    .env|.env.*|*.pem|*.p12|*.jks|*.keystore|id_rsa|id_ed25519)
      echo "✖ файл с секретами не коммитим: $f"; fail=1 ;;
  esac
  if [ "$mode" = "--all" ]; then
    size=$(wc -c < "$f" 2>/dev/null || echo 0)
  else
    size=$(git cat-file -s ":$f" 2>/dev/null || echo 0)
  fi
  size=${size//[[:space:]]/}
  if [ "${size:-0}" -gt 52428800 ]; then
    echo "✖ файл больше 50 МБ (GitHub отклонит push): $f"; fail=1
  elif [ "${size:-0}" -gt 20971520 ]; then
    echo "⚠ файл больше 20 МБ, точно нужен в репо?: $f"
  fi
done <<< "$files"


# Only file:line is printed so the secret itself never lands in a terminal or an agent's context.
hits=$(git grep "${grep_scope[@]}" -I -n -E "${args[@]}" -- . ':!scripts/secret-scan.sh' 2>/dev/null | cut -d: -f1,2)
if [ -n "$hits" ]; then
  echo "✖ похоже на ключ/токен (файл:строка):"
  echo "$hits" | sed 's/^/   /'
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "→ Перенеси значения в .env.local, повтори. Ложное срабатывание — переформулируй строку."
  exit 1
fi
exit 0
