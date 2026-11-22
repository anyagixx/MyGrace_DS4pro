#!/usr/bin/env bash
# MyGRACE session-start hook (Qwen Code, legacy packaging).
# Injects a short context message when the working directory is a MyGRACE project.
set -euo pipefail

PROJECT_ROOT="${PWD}"
HAS_MYGRACE=false

if [ -f "$PROJECT_ROOT/docs/graph-index.xml" ]; then
  HAS_MYGRACE=true
fi

if [ "$HAS_MYGRACE" = true ]; then
  echo "{\"type\": \"inform\", \"message\": \"MyGRACE project detected. Start with docs/graph-index.xml, then read only the entity you need. Skills: mygrace-init, mygrace-plan, mygrace-verification, mygrace-execute, mygrace-multiagent-execute, mygrace-refactor, mygrace-refresh, mygrace-reviewer, mygrace-fix, mygrace-status, mygrace-ask, mygrace-cli, mygrace-explainer, mygrace-setup-subagents, mygrace-token-budget. Gate: mygrace ci --path . (project commands are trust-gated).\"}"
else
  echo "{\"type\": \"allow\"}"
fi

exit 0
