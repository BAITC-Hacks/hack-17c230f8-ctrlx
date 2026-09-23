#!/usr/bin/env bash
# The organizers' org can't be connected to Vercel Git, so deploys go through the CLI.
# Production deploy — only when A asks. The commit hash in the footer proves the demo matches the repo.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
[ -f package.json ] || { echo "deploy.sh — только для web-стека (py запускается локально/Docker по README)"; exit 1; }
command -v vercel >/dev/null || { echo "✖ нет vercel CLI"; exit 1; }
project="${VERCEL_PROJECT:-ctrlx-hackalem}"
[ -f .vercel/project.json ] || vercel link --yes --project "$project"
[ -n "$(git status --porcelain)" ] && echo "⚠ есть незакоммиченные изменения — деплой будет отличаться от репо"
commit=$(git rev-parse --short HEAD)
log="${TMPDIR:-/tmp}/ctrlx-deploy.log"

echo "→ deploy $commit"
if ! url=$(vercel deploy --prod --yes --build-env NEXT_PUBLIC_COMMIT="$commit" 2>"$log"); then
  echo "… сборка на Vercel упала (лог: $log), собираю локально"
  vercel pull --yes --environment=production >/dev/null
  NEXT_PUBLIC_COMMIT="$commit" vercel build --prod
  url=$(vercel deploy --prebuilt --prod --yes)
fi
echo "✔ деплой: $url"
aliases=$(vercel inspect "$url" 2>&1 | grep -Eo 'https://[A-Za-z0-9.-]+\.vercel\.app' | sort -u | tr '\n' ' ' || true)
echo "Публичные адреса: ${aliases:-см. vercel inspect $url}"
echo "→ В README ставь адрес проекта (не одноразовый адрес деплоя) и открой его в инкогнито: должен работать без логина Vercel."
