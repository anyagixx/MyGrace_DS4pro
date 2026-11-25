# Prefer native semantic HTML

- Use `<button>` for actions and `<a href>` for navigation; do not attach click
  handlers to generic `<div>` elements.
- Use `<label for>` so the accessible name follows the form control.
- Prefer `<dialog>`, `<details>`, `<progress>` and native form validation before
  adding ARIA roles that duplicate built-in behaviour.
- When a native element lacks the required semantics, add the smallest ARIA
  patch and a keyboard test.
