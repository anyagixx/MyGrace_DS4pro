#!/usr/bin/env bash
# GRACE Session Start Hook — injects GRACE context into the session
# Output: JSON with injected context message

set -euo pipefail

# Check if this is a GRACE project (has docs/ with GRACE XML files)
PROJECT_ROOT="${PWD}"
HAS_GRACE=false

if [ -d "$PROJECT_ROOT/docs" ]; then
  if [ -f "$PROJECT_ROOT/docs/knowledge-graph.xml" ] || \
     [ -f "$PROJECT_ROOT/docs/development-plan.xml" ] || \
     [ -f "$PROJECT_ROOT/docs/verification-plan.xml" ]; then
    HAS_GRACE=true
  fi
fi

if [ "$HAS_GRACE" = true ]; then
  echo "{\"type\": \"inform\", \"message\": \"GRACE project detected. Available skills: /grace:init, /grace:plan, /grace:execute, /grace:multiagent, /grace:refactor, /grace:refresh, /grace:reviewer, /grace:fix, /grace:status, /grace:ask, /grace:cli, /grace:explainer, /grace:verification, /grace:setup-subagents. Subagents: grace-planner, grace-implementer, grace-reviewer, grace-verifier, grace-fixer.\"}"
else
  echo "{\"type\": \"allow\"}"
fi

exit 0
