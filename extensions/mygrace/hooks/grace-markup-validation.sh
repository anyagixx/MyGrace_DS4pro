#!/usr/bin/env bash
# GRACE Markup Validation Hook — PostToolUse for write_file/edit (Qwen Code).
# Validates semantic block pairing after source file modifications.
# Input: JSON via stdin from the Qwen Code hook system.
# Output: JSON via stdout.
#
# Dependencies: bash + grep only (no python3).

set -euo pipefail

INPUT=$(cat)

# Extract toolInput.path without python3: first "path":"..." occurrence.
FILE_PATH=$(printf '%s' "$INPUT" | sed -n 's/.*"path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)

if [ -z "$FILE_PATH" ]; then
  echo '{"type": "allow"}'
  exit 0
fi

# Only source files carry semantic markup.
case "$FILE_PATH" in
  *.ts|*.js|*.py|*.go|*.java|*.rs|*.rb) ;;
  *) echo '{"type": "allow"}'; exit 0 ;;
esac

if [ ! -f "$FILE_PATH" ]; then
  echo '{"type": "allow"}'
  exit 0
fi

# grep -c prints "0" and exits 1 when nothing matches — `|| true` keeps the
# printed count without appending a second value.
START_BLOCKS=$(grep -c "START_BLOCK_" "$FILE_PATH" 2>/dev/null || true)
END_BLOCKS=$(grep -c "END_BLOCK_" "$FILE_PATH" 2>/dev/null || true)

if [ "$START_BLOCKS" != "0" ] && [ "$START_BLOCKS" != "$END_BLOCKS" ]; then
  printf '{"type": "inform", "message": "GRACE hook: unpaired semantic blocks: %s START vs %s END"}\n' \
    "$START_BLOCKS" "$END_BLOCKS"
else
  echo '{"type": "allow"}'
fi

exit 0
