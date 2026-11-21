---
name: mygrace-setup-subagents
description: "Provide ready-to-use DSH subagent prompts for MyGRACE roles (planner, implementer, reviewer, verifier, fixer). Use when delegating MyGRACE work to subagents."
whenToUse: "You need to delegate MyGRACE work — planning, implementation, review, verification design, or fixing — to background subagents."
---

Use DSH subagent prompts for MyGRACE roles. No agent files are created — each role is a ready-made prompt you pass to the `subagent` tool.

## Roles
1. **mygrace-planner** — architecture planning with index-based output
2. **mygrace-implementer** — module implementation from execution packets
3. **mygrace-reviewer** — contract and index-consistency review
4. **mygrace-verifier** — verification design with per-entry files
5. **mygrace-fixer** — bug fixing via lazy navigation (index → module → block)

## Process
1. Pick the role matching the task
2. Pass its prompt to the `subagent` tool (background by default); use the `workflow` tool for large fan-out
3. Collect the report; you (controller) apply index/phase updates

## Common Prompt Prefix (prepend to any role)
"You are a MyGRACE <ROLE> in a project using lazy-loading indexes; canonical rules are in AGENTS.md (already loaded). Always start with index files (docs/graph-index.xml). Read only relevant per-entity files (docs/modules/M-XXX.xml, docs/plans/Phase-N.xml, docs/verification/V-M-XXX.xml). Never scan monolithic XML. Prefer MCP tools (mygrace_list_modules, mygrace_show_module, mygrace_show_phase, mygrace_list_verifications, mygrace_lint, mygrace_show_file) when connected; fall back to direct reads. Update indexes after any change."

## Role-Specific Instructions (append)
- planner: design modules + per-module files + indexes; no code
- implementer: implement contract, module-local tests, verification; report changes
- reviewer: contracts match code, indexes synced, verification quality; report only, never auto-fix
- verifier: scenarios/log markers per module, per-entry files
- fixer: index → module → block → fix; update CHANGE_SUMMARY
