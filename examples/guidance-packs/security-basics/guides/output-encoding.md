# Encode untrusted output

- Prefer `textContent`/`createTextNode` when inserting user data.
- Use `innerHTML` only with sanitized HTML from a maintained, context-aware
  sanitizer.
- Encode per context: HTML text, attribute values, URLs and JavaScript strings
  have different escaping rules.
- Never build server-side HTML by concatenating untrusted strings without the
  template engine's escaping.
