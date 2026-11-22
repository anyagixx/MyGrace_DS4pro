/**
 * MyGRACE status-panel — host half (LIVE status route).
 *
 * ROADMAP Wave 4.1. The panel package registers ONE authenticated extract-style
 * route on DSH's shared API channel:
 *
 *   GET /api/mygrace.status[?path=<absolute project root>]
 *   → 200 { ok, project, modules, phases, verifications, lint, trust,
 *           generatedAt, durationMs, error? }
 *     headers: cache-control: no-store
 *
 * Data is computed FRESH per request by `buildStatusPayload()`
 * (`lib/status-payload.js`), which spawns `mygrace status --format json`
 * through a PATH-free CLI resolution (MYGRACE_BIN → the launcher written by
 * `mygrace install-dsh`). The route is disposed when the plugin is disposed.
 *
 * This half is deliberately dependency-free beyond node builtins and the
 * sibling data module, so DSH can load it from a profile-installed package
 * (no @deepseek-ai imports, no build step). The browser half ships through
 * `exports["./client"]` / the package's `dsh.client` declaration.
 *
 * The route's API shape is the DSH 0.2.x `connection.fetch.register`
 * contract: `{ path, methods, requestBody, fetch(request) => Promise<Response> }`
 * (`@deepseek-ai/dsh-client-connection/lib/types/rpc.d.ts`, and
 * `dsh-client-ui-deliverables/lib/index.js` for the reference registration and
 * disposal pattern).
 */

// START_MODULE_CONTRACT
//   PURPOSE: Register and own the live /api/mygrace.status host route that backs the sidebar card.
//   SCOPE: One GET route; delegates all data work to status-payload.buildStatusPayload(); no caching, no writes.
//   DEPENDS: ./status-payload.js, DSH `connection` service (ctx.connection.fetch.register), ctx.effect for disposal
//   LINKS: ROADMAP.md (Wave 4.1), status-payload.js, dsh-client-connection types (fetch routes)
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   name/inject                 — cordis plugin identity + required services (connection)
//   createPanelHandler()        — request handler factory (test seam: runCli/env/cwd/now injection)
//   registerPanelRoute()        — registers the exact GET route and disposes it with the plugin
//   apply()                     — cordis entry point
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   v1.3 (Wave 4.1): replaced the no-op host half with the live route; the
//   handler never throws, always answers 200 JSON, and sets cache-control
//   no-store; disposal is wired through ctx.effect.
// END_CHANGE_SUMMARY

import {
  PANEL_ROUTE_PATH,
  PANEL_TIMEOUT_MS,
  buildStatusPayload,
  createCliRunner,
} from "./status-payload.js";

/** Cordis plugin name (loader diagnostics + row identity). */
export const name = "mygrace-status-panel";

/** The host route needs DSH's shared API channel. */
export const inject = ["connection"];

/** Failure payload used when even the payload builder cannot run. */
function failurePayload(error) {
  return {
    ok: false,
    project: null,
    trust: null,
    generatedAt: new Date().toISOString(),
    error,
  };
}

/**
 * JSON response with the mandatory no-store caching policy.
 *
 * MyGRACE status is live data; a cached response would show stale health and
 * hide new lint errors, so every response (success and failure) is no-store.
 *
 * @param {unknown} payload
 * @returns {Response}
 */
function jsonResponse(payload) {
  return Response.json(payload, { headers: { "cache-control": "no-store" } });
}

/**
 * Create the route handler.
 *
 * All options are test seams: production calls it with defaults only.
 *
 * @param {{
 *   runCli?: (command:string, args:string[], options?: {signal?:AbortSignal, cwd?:string}) => Promise<any>,
 *   env?: Record<string,string|undefined>,
 *   cwd?: string,
 *   dshHome?: string,
 *   now?: () => Date,
 *   timeoutMs?: number,
 * }} [options]
 * @returns {(request: Request) => Promise<Response>}
 */
export function createPanelHandler(options = {}) {
  const runCli = typeof options.runCli === "function" ? options.runCli : createCliRunner({ timeoutMs: options.timeoutMs ?? PANEL_TIMEOUT_MS });
  return async function handlePanelRequest(request) {
    try {
      if (request.signal?.aborted === true) {
        return jsonResponse(failurePayload("The status request was aborted."));
      }
      let queryPath = null;
      try {
        queryPath = new URL(request.url).searchParams.get("path");
      } catch {
        queryPath = null;
      }
      const payload = await buildStatusPayload({
        queryPath,
        env: options.env ?? process.env,
        cwd: options.cwd ?? process.cwd(),
        dshHome: options.dshHome,
        runCli,
        signal: request.signal,
        timeoutMs: options.timeoutMs ?? PANEL_TIMEOUT_MS,
        ...(typeof options.now === "function" ? { now: options.now } : {}),
      });
      return jsonResponse(payload);
    } catch (error) {
      // Containment: the route must never reject or take the host down.
      return jsonResponse(failurePayload(`Unexpected panel error: ${error instanceof Error ? error.message : String(error)}`));
    }
  };
}

/**
 * Register the live status route on the DSH connection service.
 *
 * - returns `null` (and logs one warning) when the `connection` service or its
 *   fetch registry is unavailable, so the plugin never breaks a non-web host;
 * - disposal goes through `ctx.effect` exactly like DSH's own plugins.
 *
 * @param {any} ctx cordis plugin context (must expose `connection` and `effect`)
 * @param {Parameters<typeof createPanelHandler>[0]} [options]
 * @returns {(() => Promise<void>) | null} the route disposer, when registered
 */
export function registerPanelRoute(ctx, options = {}) {
  try {
    const connection = ctx?.connection;
    if (connection === undefined || connection === null || connection === undefined || connection.fetch === undefined || typeof connection.fetch.register !== "function") {
      ctx?.logger?.warn?.("mygrace-status-panel: connection service unavailable — /api/mygrace.status was not registered");
      return null;
    }
    const handler = createPanelHandler(options);
    const dispose = connection.fetch.register({
      path: PANEL_ROUTE_PATH,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: handler,
    });
    if (typeof ctx.effect === "function") {
      ctx.effect(() => async () => {
        try {
          await dispose();
        } catch (error) {
          ctx?.logger?.warn?.(`mygrace-status-panel: route disposal failed — ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }
    return typeof dispose === "function" ? dispose : null;
  } catch (error) {
    // Registration must never break the host profile boot.
    ctx?.logger?.warn?.(`mygrace-status-panel: route registration failed — ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Cordis entry point: register the live route (disposed with the plugin).
 *
 * @param {any} ctx
 */
export function apply(ctx) {
  registerPanelRoute(ctx);
}
