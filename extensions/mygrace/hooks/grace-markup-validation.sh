#!/usr/bin/env bash
# GRACE Markup Validation Hook — PostToolUse for write_file/edit
# Validates basic GRACE markup integrity after file modifications.
# Input: JSON via stdin from Qwen Code hook system
# Output: JSON via stdout

set -euo pipefail

# Read hook input from stdin
INPUT=$(cat)

# Extract file path from hook input
FILE_PATH=$(echo "$INPUT" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('toolInput', {}).get('path', ''))" 2>/dev/null || echo "")

if [ -z "$FILE_PATH" ]; then
  echo '{"type": "allow"}'
  exit 0
fi

# Only check source files (not XML docs, configs, etc.)
case "$FILE_PATH" in
  *.ts|*.js|*.py|*.go|*.java|*.rs|*.rb) ;;
  *) echo '{"type": "allow"}'; exit 0 ;;
esac

# Check if file exists
if [ ! -f "$FILE_PATH" ]; then
  echo '{"type": "allow"}'
  exit 0
fi

ISSUES=""

# Check for MODULE_CONTRACT presence in governed source files
if ! grep -q "START_MODULE_CONTRACT\|START_MODULE_CONTRACT\|START_MODULE_CONTRACT" "$FILE_PATH" 2>/dev/null; then
  # Not necessarily an issue — only flag if it should be governed
  :
fi

# Check for paired START_BLOCK/END_BLOCK
START_BLOCKS=$(grep -c "START_BLOCK_" "$FILE_PATH" 2>/dev/null || echo "0")
END_BLOCKS=$(grep -c "END_BLOCK_" "$FILE_PATH" 2>/dev/null || echo "0")

if [ "$START_BLOCKS" != "$END_BLOCKS" ] && [ "$START_BLOCKS" != "0" ]; then
  ISSUES="Unpaired semantic blocks: ${START_BLOCKS} START vs ${END_BLOCKS} END"
fi

# Check for CHANGE_SUMMARY
if ! grep -q "START_CHANGE_SUMMARY\|START_CHANGE_SUMMARY" "$FILE_PATH" 2>/dev/null; then
  :
fi

# Output result
if [ -n "$ISSUES" ]; then
  echo "{\"type\": \"inform\", \"message\": \"GRACE hook: $ISSUES\"}"
else
  echo '{"type": "allow"}'
fi

exit 0
