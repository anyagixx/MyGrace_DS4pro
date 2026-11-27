---
name: mygrace-show-me
description: "Explain the current topic visually: pseudocode, call/component/file trees, Mermaid, focused diffs, and small self-contained HTML artifacts. Use only when the user explicitly asks to show/visualize/draw something."
whenToUse: "The user says 'show me', 'visualize', 'draw this', or asks for a visual explanation of code, flow, layout or a proposed change. Do not auto-invoke for ordinary Q&A."
disable-model-invocation: true
---

# Show me

Help the user understand the current topic **visually**. Skip the preamble and
keep prose brief: pick the smallest view that makes the key point clear, pair it
with one or two sentences of context, and stop.

This skill is **user-invoked**: do not generate diagrams/HTML on every answer.
If the user asked a textual question, answer textually; use this skill only when
they explicitly want to see the shape.

## First: get the facts right

Before drawing, ground the picture in the real repository:

- `mygrace inspect file show <path> --path <root>` — contracts, map and blocks;
- `mygrace trace <M-XXX>` — requirements/verification/phase links;
- `mygrace impact --files <paths>` — what a change touches;
- `mygrace status` / `mygrace next` — project health and current phase;
- `mygrace diagram --kind architecture|tree|workflow` — the **docs graph**.

For a picture of the project graph, use `mygrace diagram` (optionally
`--format html`) instead of hand-drawing it. This skill is for ad-hoc
explanations the docs graph does not already own.

Never invent a file, call, prop, state or edge. If the topic is ambiguous, inspect
the code first; if it is still unclear, say what is unknown instead of drawing a
fiction.

## Pick the smallest useful view

1. **Logic/algorithm** → pseudocode:

   ```text
   on(save)
     if content unchanged
       return cached result
     write new content
     return fresh result
   ```

2. **Runtime control flow** → call tree:

   ```text
   submitForm
     createSession
       persistPrompt
       launchAgent
     navigateToSession
   ```

3. **UI structure** → component tree, with state/module boundaries that matter:

   ```tsx
   <SessionPage> (src/routes/session.tsx)
     useSessionEvents()
     <SessionToolbar>
       <RunSkillButton> (packages/ui)
   ```

4. **File responsibility / broad refactor** → shallow file tree:

   ```text
   src/
   ├── commands/    # parses user actions
   ├── sessions/    # owns session state
   └── transport/   # sends API requests
   ```

5. **Interaction/control/data flow** → Mermaid:

   ```mermaid
   sequenceDiagram
       participant User
       participant UI
       participant CLI
       User->>UI: choose command
       UI->>CLI: expanded prompt
       CLI-->>UI: streamed result
   ```

6. **What changes** → a diff matched to the topic (component, file layout, call
   tree or state/control flow). For example:

   ```diff
    submitForm
      createSession
        persistPrompt
   +    expandSkillMention
        launchAgent
   -  navigateToSession
   +  navigateToSession
   +    subscribeToEvents
   ```

7. **Whole block** → show the full function/block when most of it is new, when
   omitted context hides ownership/order, or when the user needs a copyable
   target shape.

Use one format, or a few when they answer different parts. It is unlikely you
need all of them; do not overwhelm the user.

## Focused HTML artifacts

Only when a visual UI, layout, state comparison or dense concept is clearer than
text/Mermaid, write **one** small HTML file.

Rules:

- **Self-contained:** inline CSS (and JS only if genuinely needed). No external
  CDN, fonts, images, trackers or network requests.
- **Real content:** actual labels, file names, states and boundaries from the
  repository; escape user-provided text.
- **Accessible:** semantic landmarks, sufficient contrast, responsive desktop and
  mobile layout; no autoplay/looping animation.
- **Bounded:** keep it under ~256 KB; no secrets, tokens or private data.
- **Location:** `.mygrace/show-me/<slug>.html` (local state, gitignored) or an OS
  temp directory if the user asks for a throwaway. Do **not** write into `docs/`
  or the governed source tree unless the user explicitly asks; it is not an
  indexed artifact.
- **No blind shell open:** in DSH use the `present` tool (or a markdown file
  link). On a CLI, open only after verifying the absolute path is inside the
  project or temp dir, and only if the user asked; use the platform opener
  (`xdg-open` / `open` / `start`) argv-style, never `eval` or shell
  interpolation. If opening fails, print the absolute path.
- The HTML is an explanation artifact, not a governed deliverable: do not add it
  to `docs/graph-index.xml` or claim lint/CI covers it.

## Guidance

- Place each visual next to the text it supports; one point per visual.
- Keep only the calls/files/props/states/boundaries needed for the current
  question or decision.
- Match the project's actual naming and architecture; if you are proposing a
  change, make clear what exists vs what is proposed.
- Prefer text sketches over files: they are cheaper to review and do not clutter
  the workspace.
- If `mygrace diagram` already owns the view, call it and link the result rather
  than redrawing.

## Output

After the visual, state briefly:

```
What this shows: <one sentence>
Source: <files/commands inspected>
Artifact: <path, only if an HTML file was written>
```

If no file is needed, omit `Artifact`. Do not append a long explanation after a
self-explanatory picture.

## Anti-patterns

- Auto-showing diagrams for ordinary questions.
- Drawing invented calls, files, props or dependencies.
- Redrawing the architecture graph that `mygrace diagram` already owns.
- Massive HTML pages, external assets or secrets in an artifact.
- Opening arbitrary paths with a raw shell command.
- Dumping every possible view instead of the one that answers the question.

## License notice

Adapted from HumanLayer's `show-me` skill (MIT).

MIT License

Copyright (c) 2026 HumanLayer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
