#!/usr/bin/env bash
# Checks the team Supabase with the keys from .env.local and never prints them, so an agent can run it
# while the secrets stay out of its context. Usage: scripts/db-check.sh
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
[ -f .env.local ] || { echo "✖ нет .env.local — запусти scripts/setup.sh"; exit 1; }
set -a; . ./.env.local; set +a
url="${SUPABASE_URL:-}"; url="${url%/}"
[ -n "$url" ] || { echo "✖ SUPABASE_URL пуст в .env.local — ключи команды подтягивает scripts/setup.sh"; exit 1; }

code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$url/auth/v1/health"); rc=$?
if [ "$rc" = 60 ]; then
  alive=$(curl -sk -o /dev/null -m 10 -w '%{http_code}' "$url/auth/v1/health")
  echo "✖ TLS: сертификат $url недействителен (истёк?) — приложение и Vercel не подключатся. Сервер при этом отвечает: $alive. Сообщи организаторам."
  exit 1
fi
[ "$code" = 200 ] || { echo "✖ $url недоступен: auth health → $code (curl $rc)"; exit 1; }
echo "✔ сервер отвечает: auth health 200"

fail=0
for k in SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY; do
  v="${!k:-}"
  if [ -z "$v" ]; then echo "– $k не задан"; continue; fi
  resp=$(curl -s -m 10 -w $'\n%{http_code}' "$url/rest/v1/" -H "apikey: $v" -H "Authorization: Bearer $v")
  code="${resp##*$'\n'}"
  if [ "$code" = 200 ]; then echo "✔ $k: REST API 200"
  else echo "✖ $k: REST API $code — $(printf '%s' "${resp%$'\n'*}" | head -c 160)"; fail=1; fi
done
exit "$fail"
