/**
 * MyGRACE status-panel — browser half (LIVE status card).
 *
 * Registers a live card in the DSH web sidebar (`sidebar.footer.action` slot).
 * The card fetches `api/mygrace.status` (document-relative, same convention as
 * DSH's own client plugins) on mount, every 30 s, and when the tab becomes
 * visible again. It renders module/phase/verification counts, lint badges, the
 * ADR-1 trust verdict and a freshness timestamp; any failure (host route
 * missing/404, non-JSON, `{ok:false,...}`) becomes a compact
 * "MyGRACE: not connected — <reason>" line instead of breaking the GUI.
 *
 * No build step and no package dependencies: the factory uses only the seed
 * modules provided by the DSH web shell (`react`, `react/jsx-runtime`) and the
 * client runtime's `slots` service. The bundle format and slot registration
 * follow DSH's own client plugins (`window.__ModuleLoader__.load` /
 * `ctx.slots.inject` + `ctx.slots.register`), see
 * `dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/`.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Render live MyGRACE health in the DSH web sidebar and keep it fresh without user action.
//   SCOPE: One sidebar card; fetch/poll/visibility lifecycle; no writes, no host imports.
//   DEPENDS: DSH web shell seeds (react, react/jsx-runtime), `slots` client service, host route /api/mygrace.status
//   LINKS: ROADMAP.md (Wave 4.1), lib/status-payload.js (payload schema), lib/index.js (route)
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   STATUS_ROUTE       — document-relative fetch URL ("api/mygrace.status")
//   REFRESH_MS         — 30 s background refresh
//   useLiveStatus()    — mount/interval/visibility fetch lifecycle (cleanup on unmount)
//   LiveStatusCard     — collapsed monogram + expanded live card
//   apply()            — registers the card in sidebar.footer.action
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   v1.3 (Wave 4.1): static decorative text replaced with the live card:
//   real data, polling, trust/lint badges, freshness and a safe error state.
// END_CHANGE_SUMMARY

window.__ModuleLoader__.load({
  id: "mygrace-status-panel",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var jsxRuntime = require("react/jsx-runtime");

    var inject = ["slots"];

    /**
     * Document-relative URL: DSH serves API routes relative to the document
     * (`/api/...` in code becomes `api/...` in the browser bundle — the same
     * conversion as `dsh-client-ui-deliverables/lib/client.js`).
     */
    var STATUS_ROUTE = "/api/mygrace.status".slice(1);
    var REFRESH_MS = 30000;
    var COLORS = {
      text: "var(--dsw-alias-label-primary, #e8eaf0)",
      dim: "var(--dsw-alias-label-secondary, #9aa3b2)",
      bg: "var(--dsw-alias-bg-l2, #1b1f27)",
      ok: "#3fb950",
      warn: "#d29922",
      error: "#f85149",
      accent: "#6aa9ff",
    };

    /** @param {unknown} value @returns {string} */
    function messageOf(value) {
      return value instanceof Error ? value.message : String(value);
    }

    /** HH:MM:SS for an ISO timestamp, or "" when unparsable. */
    function formatClock(iso) {
      if (typeof iso !== "string") return "";
      var date = new Date(iso);
      if (isNaN(date.getTime())) return "";
      try {
        return date.toLocaleTimeString();
      } catch (error) {
        return date.toISOString().slice(11, 19);
      }
    }

    /** Compact "N modules · M phases · K verif" line. */
    function countsLine(payload) {
      var modules = payload && payload.modules ? payload.modules.total : 0;
      var phases = payload && payload.phases ? payload.phases.total : 0;
      var verifications = payload && payload.verifications ? payload.verifications.total : 0;
      return String(modules) + " modules \u00b7 " + String(phases) + " phases \u00b7 " + String(verifications) + " verif";
    }

    /** "done 3 · wip 1" for the module status breakdown (top 3 groups). */
    function moduleStatusLine(payload) {
      var byStatus = payload && payload.modules && payload.modules.byStatus ? payload.modules.byStatus : {};
      var keys = Object.keys(byStatus);
      if (keys.length === 0) return "";
      keys.sort();
      return keys.slice(0, 3).map(function (key) {
        return key + " " + String(byStatus[key]);
      }).join(" \u00b7 ");
    }

    /** Title/tooltip text shown on the collapsed monogram and the card. */
    function summaryTitle(state) {
      if (state.phase === "error") return "MyGRACE: not connected \u2014 " + (state.error || "unknown error");
      if (!state.payload) return "MyGRACE: loading\u2026";
      var payload = state.payload;
      var lint = payload.lint || { errors: 0, warnings: 0 };
      return "MyGRACE \u2014 " + countsLine(payload) + ", " + String(lint.errors) + " lint errors, " + String(lint.warnings) + " warnings";
    }

    /** Colour of the small status dot. */
    function dotColor(state) {
      if (state.phase === "error") return COLORS.error;
      if (!state.payload) return COLORS.warn;
      var lint = state.payload.lint || { errors: 0, warnings: 0 };
      if (lint.errors > 0) return COLORS.error;
      if (lint.warnings > 0) return COLORS.warn;
      return COLORS.ok;
    }

    /**
     * Fetch/poll/visibility lifecycle.
     *
     * - fetch on mount;
     * - every 30 s while mounted;
     * - immediately when the tab becomes visible again;
     * - in-flight responses after unmount are ignored;
     * - a failure updates the error state but never throws.
     *
     * @returns {{phase:"loading"|"refreshing"|"ok"|"error", payload:any|null, error:string|null, at:Date|null}}
     */
    function useLiveStatus() {
      var statePair = React.useState({ phase: "loading", payload: null, error: null, at: null });
      var state = statePair[0];
      var setState = statePair[1];
      var aliveRef = React.useRef(true);
      var generationRef = React.useRef(0);

      var load = React.useCallback(function () {
        var generation = generationRef.current + 1;
        generationRef.current = generation;
        setState(function (previous) {
          return {
            phase: previous.payload ? "refreshing" : "loading",
            payload: previous.payload,
            error: null,
            at: previous.at,
          };
        });
        if (typeof fetch !== "function") {
          setState({ phase: "error", payload: null, error: "fetch is unavailable in this shell.", at: new Date() });
          return function () {};
        }
        fetch(STATUS_ROUTE, { cache: "no-store" })
          .then(function (response) {
            if (!response.ok) {
              var hint = response.status === 404 ? " (host route missing \u2014 reinstall with `mygrace setup install --panel`)" : "";
              throw new Error("HTTP " + String(response.status) + hint);
            }
            return response.json();
          })
          .then(function (payload) {
            if (!aliveRef.current || generationRef.current !== generation) return;
            if (!payload || payload.ok !== true) {
              setState({
                phase: "error",
                payload: null,
                error: (payload && typeof payload.error === "string" && payload.error) || "MyGRACE backend reported an error.",
                at: new Date(),
              });
              return;
            }
            setState({ phase: "ok", payload: payload, error: null, at: new Date() });
          })
          .catch(function (error) {
            if (!aliveRef.current || generationRef.current !== generation) return;
            setState({ phase: "error", payload: null, error: messageOf(error), at: new Date() });
          });
        return function () {
          generationRef.current += 1;
        };
      }, []);

      React.useEffect(function () {
        aliveRef.current = true;
        var cancel = load();
        var timer = setInterval(function () {
          cancel();
          cancel = load();
        }, REFRESH_MS);
        function onVisibilityChange() {
          if (typeof document !== "undefined" && document.visibilityState === "visible") {
            cancel();
            cancel = load();
          }
        }
        if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibilityChange);
        return function () {
          aliveRef.current = false;
          clearInterval(timer);
          if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibilityChange);
          cancel();
        };
      }, [load]);

      return state;
    }

    /** Small inline badge. */
    function Badge(props) {
      return jsxRuntime.jsx(
        "span",
        {
          title: props.title,
          style: {
            display: "inline-block",
            padding: "0 5px",
            borderRadius: 4,
            fontSize: 10,
            lineHeight: "16px",
            fontWeight: 600,
            marginRight: 4,
            color: props.color,
            background: props.background,
            whiteSpace: "nowrap",
          },
          children: props.children,
        }
      );
    }

    /** The card: compact monogram when the sidebar is collapsed, live data when wide. */
    function LiveStatusCard(props) {
      var wide = !!(props && props.wide);
      var state = useLiveStatus();
      var title = summaryTitle(state);
      var dot = dotColor(state);

      if (!wide) {
        return jsxRuntime.jsx(
          "div",
          {
            title: title,
            "aria-label": title,
            style: {
              position: "relative",
              width: 28,
              height: 28,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
              fontWeight: 700,
              color: COLORS.accent,
            },
            children: [
              jsxRuntime.jsx("span", { key: "monogram", children: "MG" }),
              jsxRuntime.jsx("span", {
                key: "dot",
                style: {
                  position: "absolute",
                  right: 2,
                  bottom: 2,
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: dot,
                },
              }),
            ],
          }
        );
      }

      var payload = state.payload;
      var lint = payload && payload.lint ? payload.lint : { errors: 0, warnings: 0 };
      var trust = payload ? payload.trust : null;
      var freshness = payload ? formatClock(payload.generatedAt) : "";
      var statusLine = payload ? moduleStatusLine(payload) : "";
      var errorText = state.phase === "error" ? state.error || "unknown error" : null;

      var children = [
        jsxRuntime.jsxs(
          "div",
          {
            key: "header",
            style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2 },
            children: [
              jsxRuntime.jsxs("div", {
                style: { fontWeight: 600, display: "flex", alignItems: "center", gap: 5 },
                children: [
                  jsxRuntime.jsx("span", { key: "dot", style: { width: 7, height: 7, borderRadius: "50%", background: dot, display: "inline-block" } }),
                  jsxRuntime.jsx("span", { key: "label", children: "MyGRACE" }),
                ],
              }),
              jsxRuntime.jsx("div", {
                key: "freshness",
                title: payload ? "generated at " + String(payload.generatedAt) : "",
                style: { fontSize: 10, color: COLORS.dim },
                children: state.phase === "loading" ? "loading\u2026" : freshness ? "updated " + freshness : "",
              }),
            ],
          }
        ),
        jsxRuntime.jsx("div", {
          key: "counts",
          style: { color: COLORS.text, opacity: 0.9 },
          children: payload ? countsLine(payload) : "waiting for the host route\u2026",
        }),
      ];

      if (statusLine) {
        children.push(jsxRuntime.jsx("div", { key: "status-line", style: { color: COLORS.dim, fontSize: 11 }, children: statusLine }));
      }

      var badges = [];
      if (payload) {
        badges.push(
          jsxRuntime.jsx(
            Badge,
            {
              key: "lint-errors",
              title: "lint errors reported by `mygrace status`",
              color: lint.errors > 0 ? COLORS.error : COLORS.ok,
              background: "rgba(255,255,255,0.06)",
              children: lint.errors > 0 ? String(lint.errors) + " lint errors" : "lint clean",
            }
          )
        );
        if (lint.warnings > 0) {
          badges.push(
            jsxRuntime.jsx(Badge, {
              key: "lint-warnings",
              title: "lint warnings reported by `mygrace status`",
              color: COLORS.warn,
              background: "rgba(255,255,255,0.06)",
              children: String(lint.warnings) + " warnings",
            })
          );
        }
        if (trust) {
          badges.push(
            jsxRuntime.jsx(Badge, {
              key: "trust",
              title: trust.authorized ? "project commands may run (" + (trust.via || "trust") + ")" : "project commands are refused until `mygrace trust`",
              color: trust.authorized ? COLORS.ok : COLORS.warn,
              background: "rgba(255,255,255,0.06)",
              children: trust.authorized ? "trusted" : "untrusted",
            })
          );
        }
      }
      children.push(jsxRuntime.jsx("div", { key: "badges", style: { marginTop: 3 }, children: badges }));

      if (errorText !== null) {
        children.push(
          jsxRuntime.jsx("div", {
            key: "error",
            title: errorText,
            style: {
              marginTop: 3,
              fontSize: 11,
              color: COLORS.error,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            },
            children: "MyGRACE: not connected \u2014 " + errorText,
          })
        );
      }

      return jsxRuntime.jsx(
        "div",
        {
          title: title,
          style: {
            padding: "8px 10px",
            margin: "4px 0",
            borderRadius: 8,
            background: COLORS.bg,
            color: COLORS.text,
            fontSize: 12,
            lineHeight: 1.5,
            overflow: "hidden",
          },
          children: children,
        }
      );
    }

    function apply(ctx) {
      ctx.slots.inject("sidebar.footer.action", function () {
        return ctx.slots.register(
          { name: "sidebar.footer.action", id: "mygrace-status-panel", order: 100 },
          LiveStatusCard
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
