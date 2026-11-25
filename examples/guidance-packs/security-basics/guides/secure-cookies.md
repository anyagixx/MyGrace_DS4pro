# Secure session cookies

- Set `HttpOnly` so JavaScript cannot read session cookies.
- Set `Secure` so cookies are only sent over HTTPS.
- Set `SameSite=Lax` (or `Strict` where compatible) to reduce cross-site
  request risk; use `None; Secure` only when a third-party context is required.
- Restrict `Path` and `Domain`; rotate session identifiers on privilege changes.
