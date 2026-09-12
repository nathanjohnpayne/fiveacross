#!/bin/bash
# Anchor is UTC Z to match GitHub timestamps. The previous watcher compared a
# -07:00 anchor lexically against Z values and silently counted far older
# comments, reporting a reviewer had reached this head when it had not.
cd /Users/nathanpayne/GitHub/fiveacross/.claude/worktrees/finale-podium-email-2ade33
eval "$(/opt/homebrew/bin/brew shellenv)"
eval "$(scripts/op-preflight.sh --agent claude --check)" >/dev/null 2>&1
export GH_TOKEN="$OP_PREFLIGHT_REVIEWER_PAT"
A=2026-09-12T17:32:08Z
for i in $(seq 1 40); do
  sleep 60
  ACC=$(scripts/review-feedback-accounting.sh 1207 nathanjohnpayne/fiveacross 2>&1 | grep -m1 "findings accounted")
  CX=$(python3 "/Users/nathanpayne/GitHub/fiveacross/.claude/worktrees/finale-podium-email-2ade33/.rvcount.py" codex "$A")
  CR=$(python3 "/Users/nathanpayne/GitHub/fiveacross/.claude/worktrees/finale-podium-email-2ade33/.rvcount.py" coderabbit "$A")
  echo "poll $i: ${ACC:-accounting clear} | codex=$CX coderabbit_verdict=$CR"
  case "$ACC" in *"still undispositioned"*) echo NEW_FINDINGS; break;; esac
  if [ "$CX" -gt 0 ] && [ "$CR" -gt 0 ]; then echo BOTH_REACHED_HEAD; break; fi
done
