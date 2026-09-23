#!/usr/bin/env bash
# Independent "expert" pass: Codex on a fresh clone follows the README literally and scores it against the rubric.
# A different model family, sees only what is pushed, spends Codex quota instead of Claude's. 3–6 min; fine in background.
set -uo pipefail
root=$(git rev-parse --show-toplevel) || exit 1
url=$(git -C "$root" remote get-url origin)
model="${JUDGE_MODEL:-gpt-5.6-terra}"
work=$(mktemp -d "${TMPDIR:-/tmp}/ctrlx-judge.XXXXXX")
git clone -q --depth 1 "$url" "$work/repo" || { echo "✖ clone"; exit 1; }

# package caches live outside the clone; the sandbox must be able to write to them
extra=()
for d in "$HOME/Library/pnpm/store" "$HOME/.cache/uv"; do [ -d "$d" ] && extra+=(--add-dir "$d"); done

prompt='Ты — технический эксперт хакатона HackAlem и видишь этот репозиторий впервые.
1. Прочитай README.md, затем docs/TASK.md и docs/REQUIREMENTS.md (если есть).
2. Выполни установку и запуск СТРОГО по README, ничего не додумывая. Для каждого шага: команда → ок/ошибка (одна строка).
3. Проверь основной сценарий из README: фактический результат против ожидаемого.
4. Оцени по критериям из docs/REQUIREMENTS.md («Карта баллов»); если их нет — соответствие кейсу 20, техническая реализация 25, README 20, воспроизводимость 20, надёжность 15. По каждому: балл и одно предложение почему.
5. Перечисли заявленное в README или REQUIREMENTS, но не подтверждённое кодом или запуском.
6. Топ-5 исправлений по убыванию влияния на баллы: файл → что именно поменять.
Не меняй файлы репозитория (кроме артефактов сборки). Ответ — на русском, кратко, markdown.'

echo "→ Codex ($model) проверяет свежий clone: $work/repo (3–6 мин)…"
codex exec -C "$work/repo" -m "$model" -s workspace-write \
  -c sandbox_workspace_write.network_access=true -c model_reasoning_effort=medium \
  ${extra[@]+"${extra[@]}"} --ephemeral -o "$work/report.md" "$prompt" >"$work/codex.log" 2>&1
status=$?
if [ -s "$work/report.md" ]; then
  cat "$work/report.md"; echo; echo "(отчёт: $work/report.md)"
else
  echo "✖ codex exec не дал отчёт (код $status). Лог: $work/codex.log"; exit 1
fi
