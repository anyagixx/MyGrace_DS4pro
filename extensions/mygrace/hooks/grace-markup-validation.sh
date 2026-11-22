#!/usr/bin/env bash
# MyGRACE markup validation hook — PostToolUse for write_file/edit (Qwen Code).
# Reports unpaired START_BLOCK_/END_BLOCK_ markers after source edits.
# Input: JSON via stdin from the hook system. Output: JSON via stdout.
# Dependencies: bash + grep only.
set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(printf '%s' "$INPUT" | sed -n 's/.*"path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)

if [ -z "$FILE_PATH" ] || [ ! -f "$FILE_PATH" ]; then
  echo '{"type": "allow"}'
  exit 0
fi

case "$FILE_PATH" in
  *.ts|*.js|*.py|*.go|*.java|*.rs|*.rb) ;;
  *) echo '{"type": "allow"}'; exit 0 ;;
esac

START_BLOCKS=$(grep -c "START_BLOCK_" "$FILE_PATH" 2>/dev/null || true)
END_BLOCKS=$(grep -c "END_BLOCK_" "$FILE_PATH" 2>/dev/null || true)

if [ "$START_BLOCKS" != "0" ] && [ "$START_BLOCKS" != "$END_BLOCKS" ]; then
  printf '{"type": "inform", "message": "MyGRACE hook: unpaired semantic blocks: %s START vs %s END"}\n' \
    "$START_BLOCKS" "$END_BLOCKS"
else
  echo '{"type": "allow"}'
fi

exit 0
