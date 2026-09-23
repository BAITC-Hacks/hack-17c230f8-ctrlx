#!/usr/bin/env bash
# Experts clone the repo and follow the README; if it doesn't start, the team is out with no fixes accepted (5.4.16).
# This checks exactly what is ON GITHUB: fresh clone → install → test → start → health → main scenario.
# /ship keeps SMOKE_PATH / SMOKE_BODY in sync with the README's main scenario.
set -uo pipefail
# Main scenario is a GET: the forecast issue the README tells the expert to open.
SMOKE_PATH="${SMOKE_PATH:-/api/forecast/2026-01-31}"
SMOKE_METHOD="${SMOKE_METHOD:-GET}"
SMOKE_BODY="${SMOKE_BODY:-}"

root=$(git rev-parse --show-toplevel) || exit 1
url=$(git -C "$root" remote get-url origin)
ahead=$(git -C "$root" rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
[ "$ahead" != "0" ] && echo "⚠ не запушено коммитов: $ahead — проверяется только то, что на GitHub"
[ -n "$(git -C "$root" status --porcelain)" ] && echo "⚠ есть незакоммиченные изменения — они не проверяются"

work=$(mktemp -d "${TMPDIR:-/tmp}/ctrlx-smoke.XXXXXX")
passed=""; failed=""
step() {
  name="$1"; shift
  if "$@" >"$work/$name.log" 2>&1; then passed="$passed $name"; echo "✔ $name"
  else failed="$failed $name"; echo "✖ $name (лог: $work/$name.log)"; fi
}

echo "→ clone $url"
git clone -q --depth 1 "$url" "$work/repo" || { echo "✖ clone"; exit 1; }
cd "$work/repo" || exit 1

port=""; server_pid=""
cleanup() {
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null
  if [ -n "$port" ]; then
    pids=$(lsof -ti "tcp:$port" 2>/dev/null)
    [ -n "$pids" ] && kill $pids 2>/dev/null
  fi
}
trap cleanup EXIT

if [ -f package.json ]; then
  port=3199
  step install pnpm install --frozen-lockfile --prefer-offline
  step test pnpm -s test
  step build pnpm -s build
  pnpm start -p "$port" >"$work/server.log" 2>&1 &
  server_pid=$!
elif [ -f pyproject.toml ]; then
  port=8199
  step install uv sync --frozen
  step test uv run pytest -q
  step lint uv run ruff check .
  uv run uvicorn app.main:app --port "$port" >"$work/server.log" 2>&1 &
  server_pid=$!
else
  echo "✖ нет package.json или pyproject.toml — стартер ещё не добавлен?"; exit 1
fi

up=0
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:$port/api/health" >/dev/null 2>&1; then up=1; break; fi
  sleep 1
done
if [ "$up" = 1 ]; then
  passed="$passed start"; echo "✔ start: $(curl -s "http://localhost:$port/api/health")"
  if [ "$SMOKE_METHOD" = "GET" ]; then
    code=$(curl -s -o "$work/scenario.json" -w '%{http_code}' "http://localhost:$port$SMOKE_PATH")
  else
    code=$(curl -s -o "$work/scenario.json" -w '%{http_code}' -X "$SMOKE_METHOD" "http://localhost:$port$SMOKE_PATH" \
      -H 'content-type: application/json' -d "$SMOKE_BODY")
  fi
  if [ "$code" = "200" ]; then
    passed="$passed scenario"; echo "✔ scenario $SMOKE_PATH → $(head -c 300 "$work/scenario.json")"
  else
    failed="$failed scenario"; echo "✖ scenario $SMOKE_PATH → HTTP $code ($work/scenario.json)"
  fi
else
  failed="$failed start"; echo "✖ start (лог: $work/server.log)"
fi

echo
if [ -z "$failed" ]; then echo "SMOKE PASS:$passed"; else echo "SMOKE FAIL:$failed"; exit 1; fi
