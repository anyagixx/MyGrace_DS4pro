# Accessible modal dialog

- Prefer `<dialog>` with `showModal()`; the browser provides focus containment,
  Escape handling and top-layer rendering.
- Give the dialog an accessible name with `aria-labelledby` pointing at its
  heading, or `aria-label` when no visible heading exists.
- Add one explicit close button; do not rely only on a backdrop click.
- Restore focus to the element that opened the dialog after it closes
  (`showModal()` usually restores it automatically; verify in your browser).
- Animate with CSS `@starting-style`/`::backdrop` and respect
  `prefers-reduced-motion`.
