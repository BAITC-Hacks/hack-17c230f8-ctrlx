#!/usr/bin/env bash
# Claude Code status line, two lines:
#   [id] model · ctx % · 5h limit % · ✎ uncommitted files · ↑ not pushed · ↓ team commits not pulled yet · last push age
#   · 💬 unread team-channel messages
#   💬 your last prompt — helps when three terminals are open
input=$(cat)
model=""; ctx=""; five=""; transcript=""
if command -v jq >/dev/null 2>&1; then
  field() { printf '%s' "$input" | jq -r "$1" 2>/dev/null; }
  model=$(field '.model.display_name // empty')
  ctx=$(field '.context_window.used_percentage // empty | floor')
  five=$(field '.rate_limits.five_hour.used_percentage // empty | floor')
  transcript=$(field '.transcript_path // empty')
  dir=$(field '.workspace.project_dir // .cwd // empty')
  [ -n "$dir" ] && cd "$dir" 2>/dev/null
fi

role=$(git config ctrlx.role 2>/dev/null || true)
out="${role:+[$role] }${model:-Claude}"
[ -n "$ctx" ] && out="$out · ctx ${ctx}%"
[ -n "$five" ] && out="$out · 5h ${five}%"
if git rev-parse --git-dir >/dev/null 2>&1; then
  dirty=$(git --no-optional-locks status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  [ "$dirty" != "0" ] && out="$out · ✎$dirty"
  if t=$(git log -1 --format=%ct '@{u}' 2>/dev/null); then
    ahead=$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
    # counted against the last pull/fetch — no network here
    behind=$(git rev-list --count 'HEAD..@{u}' 2>/dev/null || echo 0)
    [ "$ahead" != "0" ] && out="$out · ↑$ahead"
    [ "$behind" != "0" ] && out="$out · ↓$behind → sync.sh"
    out="$out · push $(( ($(date +%s) - t) / 60 ))м назад"
  fi
  root=$(git rev-parse --show-toplevel)
  if [ -x "$root/scripts/msg.sh" ]; then
    unread=$("$root/scripts/msg.sh" count 2>/dev/null)
    [ "${unread:-0}" -gt 0 ] 2>/dev/null && out="$out · 💬$unread → msg.sh inbox"
  fi
fi
printf '%s\n' "$out"

if [ -n "$transcript" ] && [ -f "$transcript" ] && command -v jq >/dev/null 2>&1; then
  # only the tail: transcripts grow to megabytes and this runs on every refresh
  last=$(tail -n 400 "$transcript" | jq -rs '
    [ .[] | select(.type == "user") | .message.content
      | if type == "string" then . else ([ .[]? | select(.type == "text") | .text ] | join(" ")) end
      | gsub("\\s+"; " ")
      | select(length > 0 and (startswith("<") | not) and (startswith("[Request") | not)) ]
    | last // empty
    | if length > 90 then .[0:89] + "…" else . end' 2>/dev/null)
  [ -n "$last" ] && printf '💬 %s\n' "$last"
fi
