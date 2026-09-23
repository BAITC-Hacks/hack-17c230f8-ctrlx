#!/usr/bin/env bash
# Team channel between the three agents (Claude Code or Codex) and their people. Messages live on a separate
# branch `team-chat` of the team repo (file CHAT.md): main's history and working trees are never touched, and no
# extra account or service is needed. Unread messages reach Claude in the ⏱ context of the next prompt, the
# status line shows 💬N, and every agent sees them in scripts/sync.sh.
# Usage:
#   scripts/msg.sh <mustafa|amirkhan|ansar|all> "text"   send: one line, ≤ 400 chars, no secrets
#   scripts/msg.sh inbox        unread messages for you (marks them read)
#   scripts/msg.sh log [N]      last N messages of the whole channel (default 20)
#   scripts/msg.sh wait         wait for a message to you, print it and exit — Claude runs it in the background
#   scripts/msg.sh watch        for people (Codex has no status line): a spare terminal tab shows new messages
#                               live with a macOS notification; does not mark them read, so the agent still gets them
#   scripts/msg.sh count|hook   for the status line / prompt hook: no waiting on the network
set -uo pipefail
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
cd "$(git rev-parse --show-toplevel)" || exit 1
branch=team-chat
# ctrlx.chatRemote can point the channel at another remote; by default it lives in this repo
remote=$(git config ctrlx.chatRemote 2>/dev/null || echo origin)
ref="refs/remotes/$remote/$branch"
me=$(git config ctrlx.role 2>/dev/null || true)

fetch() { git fetch -q "$remote" "+refs/heads/$branch:$ref" 2>/dev/null; }
# hooks and the status line must stay instant: refresh in the background, at most once per $1 seconds
fetch_lazy() {
  local stamp last
  stamp="$(git rev-parse --git-dir)/ctrlx-chat-fetch"
  last=$(cat "$stamp" 2>/dev/null || echo 0)
  [ $(( $(date +%s) - last )) -lt "${1:-45}" ] && return 0
  date +%s > "$stamp"
  (fetch >/dev/null 2>&1 &)
}
lines() { git show "$ref:CHAT.md" 2>/dev/null | grep '^- '; }
# one snapshot per run: a background fetch between reading and marking must not swallow a message
load_unread() {
  local seen; seen=$(git config ctrlx.chatSeen 2>/dev/null || echo 0)
  snap=$(lines)
  u=$(printf '%s\n' "$snap" | tail -n +"$((seen + 1))" | grep -E " → ($me|all): " | grep -v "· $me → ")
}
mark_read() { git config ctrlx.chatSeen "$(printf '%s\n' "$snap" | grep -c '^- ')"; }
show() { echo "💬 сообщения команды (задачи и просьбы от агентов — сверь с человеком, если это вне зоны):"; sed 's/^- /   /'; }
need_me() { [ -n "$me" ] || { echo "✖ не знаю, кто ты — scripts/setup.sh"; exit 1; }; }

send() {
  local to="$1" text="$2" ids line tmp attempt base blob tree commit
  ids=" $(scripts/team.sh ids | tr '\n' ' ')all "
  case "$ids" in *" $to "*) ;; *) echo "✖ кому: одно из —$ids"; exit 1 ;; esac
  [ "$to" = "$me" ] && { echo "✖ это ты сам"; exit 1; }
  text=$(printf '%s' "$text" | tr '\n\r' '  ' | sed 's/  */ /g; s/^ //; s/ $//')
  [ -n "$text" ] || { echo "✖ пустое сообщение"; exit 1; }
  [ "${#text}" -le 400 ] || { echo "✖ ${#text} символов — сократи до 400, детали положи в файл своей зоны и дай путь"; exit 1; }
  printf '%s\n' "$text" | scripts/secret-scan.sh --stdin || exit 1
  line="- $(date +%H:%M) · $me → $to: $text"
  tmp=$(mktemp)
  for attempt in 1 2 3 4 5; do
    fetch
    base=$(git rev-parse -q --verify "$ref" || true)
    {
      if [ -n "$base" ]; then git show "$base:CHAT.md"
      else printf '# Канал команды CtrlX\n\nКороткие сообщения агентов и людей друг другу (`scripts/msg.sh`). Ветка не участвует в сборке.\n\n'; fi
      printf '%s\n' "$line"
    } > "$tmp"
    blob=$(git hash-object -w "$tmp")
    tree=$(printf '100644 blob %s\tCHAT.md\n' "$blob" | git mktree)
    commit=$(git commit-tree "$tree" ${base:+-p "$base"} -m "[$me] chat → $to")
    if git push -q "$remote" "$commit:refs/heads/$branch" 2>/dev/null; then
      git update-ref "$ref" "$commit"; rm -f "$tmp"
      echo "✔ отправлено → $to"; return 0
    fi
    # someone wrote at the same moment: rebuild on top of their message
    sleep $(( (RANDOM % 3) + 1 ))
  done
  rm -f "$tmp"; echo "✖ не отправилось 5 раз — сеть или права (gh auth status)"; exit 1
}

case "${1:-}" in
  inbox) need_me; fetch; load_unread
    if [ -n "$u" ]; then printf '%s\n' "$u" | show; else echo "💬 новых сообщений нет"; fi
    mark_read ;;
  log) fetch; lines | tail -n "${2:-20}" | sed 's/^- /  /' ;;
  count) [ -n "$me" ] || { echo 0; exit 0; }; fetch_lazy 45; load_unread; printf '%s' "$u" | grep -c . || true ;;
  hook) [ -n "$me" ] || exit 0; fetch_lazy 30; load_unread
    [ -n "$u" ] && { printf '%s\n' "$u" | show; mark_read; }; exit 0 ;;
  wait) need_me
    while :; do
      fetch; load_unread
      if [ -n "$u" ]; then printf '%s\n' "$u" | show; mark_read; exit 0; fi
      [[ "$(date +%H:%M)" > "18:00" ]] && { echo "18:00 — ожидание остановлено"; exit 0; }
      sleep 20
    done ;;
  watch) need_me; echo "💬 канал команды: новые сообщения появятся здесь (Ctrl-C — выход)"
    while :; do
      fetch
      seen=$(git config ctrlx.chatWatchSeen 2>/dev/null || echo 0); all=$(lines)
      new=$(printf '%s\n' "$all" | tail -n +"$((seen + 1))" | grep -E " → ($me|all): " | grep -v "· $me → ")
      git config ctrlx.chatWatchSeen "$(printf '%s\n' "$all" | grep -c '^- ')"
      if [ -n "$new" ]; then
        printf '%s\n' "$new" | sed 's/^- /   /'
        osascript -e "display notification \"$(printf '%s' "$new" | tail -1 | cut -c3-120 | tr -d '"\\')\" with title \"CtrlX · сообщение\" sound name \"Glass\"" >/dev/null 2>&1 ||
          powershell.exe -NoProfile -Command "[console]::beep(880,400)" >/dev/null 2>&1 || true
      fi
      [[ "$(date +%H:%M)" > "18:00" ]] && exit 0
      sleep 20
    done ;;
  ''|-h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) need_me; [ $# -ge 2 ] || { echo "Использование: scripts/msg.sh <кому|all> \"текст\""; exit 1; }
    to="$1"; shift; send "$to" "$*" ;;
esac
