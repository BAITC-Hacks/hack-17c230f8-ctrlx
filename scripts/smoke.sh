#!/usr/bin/env bash
# R6: fresh clone -> install -> verify inputs -> train -> backtest -> tests -> HTTP.
# The working copy and its model/results are never changed.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
source=$(git -C "$root" remote get-url origin)
# Optional local repository lets reviewers validate an unpushed COMMIT, not dirty files.
if [ "${1:-}" = "--local" ]; then source="$root"; fi
work=$(mktemp -d "${TMPDIR:-/tmp}/ctrlx-smoke.XXXXXX")
server_pid=""
trap '[ -z "$server_pid" ] || kill "$server_pid" 2>/dev/null || true' EXIT
step() {
  local name="$1"; shift
  if "$@" >"$work/$name.log" 2>&1; then
    echo "✔ $name"
  else
    echo "✖ $name — $work/$name.log"
    tail -n 20 "$work/$name.log"
    exit 1
  fi
}
echo "Логи и отдельный клон: $work"
if [ -n "$(git -C "$root" status --porcelain)" ]; then
  echo "Внимание: незакоммиченные правки не входят в проверку."
fi
step clone git clone --quiet --no-hardlinks "$source" "$work/repo"
cd "$work/repo"
{
  git rev-parse HEAD
  uname -srm
  date -u '+%Y-%m-%dT%H:%M:%SZ'
} > "$work/environment.txt"
step install uv sync --frozen
export DEMO_MODE=1
uv run python --version >> "$work/environment.txt"
step inputs uv run python - <<'PY'
import hashlib
import json
from pathlib import Path
expected = {
    'turbine1.csv': 'd82def7e56c0a1eed3f2f68eb29fd66e4299999921c9703720a880a5cf7d6703',
    'turbine2.csv': '16a844db949562290c96a86efa20178a71540ff6252275c003db4715edb9434a',
}
for name, digest in expected.items():
    assert hashlib.sha256((Path('data/raw') / name).read_bytes()).hexdigest() == digest, name
meta = json.loads(Path('data/weather_cache/meta.json').read_text())
for name in ('best_match', 'gfs_seamless'):
    path = Path('data/weather_cache') / f'prev_runs_{name}.json'
    assert hashlib.sha256(path.read_bytes()).hexdigest() == meta['models'][name]['sha256'], name
print('Raw data and weather cache hashes OK')
PY
# Remove only generated artifacts in the isolated clone: stale files cannot pass this check.
step clean uv run python - <<'PY'
from pathlib import Path
import shutil
for name in ('outputs/forecasts', 'runs', 'models', 'data/processed'):
    path = Path(name)
    if path.exists():
        shutil.rmtree(path)
PY
step train uv run python -m app.cli train
step backtest uv run python -m app.cli backtest
step artifacts uv run pytest -q tests/test_cli.py::test_complete_february_artifacts
step tests uv run pytest -q
step lint uv run ruff check .
# Let the OS assign a free port; never kill a process just because it owns a fixed port.
uv run python - "$work/port" >"$work/server.log" 2>&1 <<'PY' &
import socket
import sys
from pathlib import Path
import uvicorn
sock = socket.socket()
sock.bind(('127.0.0.1', 0))
Path(sys.argv[1]).write_text(str(sock.getsockname()[1]))
uvicorn.Server(uvicorn.Config('app.main:app', log_level='warning')).run(sockets=[sock])
PY
server_pid=$!
up=0
for _ in $(seq 1 60); do
  if [ -s "$work/port" ]; then
    port=$(cat "$work/port")
    if curl -fsS "http://127.0.0.1:$port/api/health" >"$work/health.json" 2>/dev/null; then
      up=1; break
    fi
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then break; fi
  sleep 1
done
if [ "$up" != 1 ]; then echo "✖ server — $work/server.log"; exit 1; fi
step http uv run python - "$port" <<'PY'
import json
import sys
from urllib.request import urlopen
base = f'http://127.0.0.1:{sys.argv[1]}'
def get(path):
    with urlopen(base + path, timeout=15) as response:
        return json.load(response)
assert get('/api/health')['ok']
issues = get('/api/issues')
assert len(issues) == 28
for item in issues:
    issue = get('/api/forecast/' + item['issue_date'])
    assert len([r for r in issue['rows'] if r['revision'] == 0]) == 48
    assert get('/api/runs/' + issue['run_id'] + '/log')
with urlopen(base, timeout=15) as response:
    assert 'WindCast' in response.read().decode('utf-8')
print('28 newly calculated issues, logs and homepage: OK')
PY
printf 'SMOKE PASS: inputs train backtest artifacts tests lint http\n' | tee "$work/result.txt"
echo "Отчёт: $work/result.txt; окружение: $work/environment.txt"
