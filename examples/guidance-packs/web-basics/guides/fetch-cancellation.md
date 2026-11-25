# Cancel stale fetch requests

- Create one `AbortController` per logical request; call `controller.abort()`
  when a newer request replaces it or the view unmounts.
- Pass `signal` to `fetch()` and handle `AbortError` separately from network
  failures.
- Do not use a boolean "latest response" check as the only guard: the network
  and JSON parsing still consume resources.
- In frameworks, abort in the effect cleanup instead of leaving requests alive
  after navigation.
