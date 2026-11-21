/**
 * MyGRACE status panel — browser half (CJS factory bundle).
 *
 * Registers a card in the `sidebar.footer.action` slot. No build step:
 * the factory uses only the seed modules provided by the DSH web shell
 * (react/jsx-runtime and the client runtime's slots service).
 */
window.__ModuleLoader__.load({
  id: "mygrace-status-panel",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var jsxRuntime = require("react/jsx-runtime");

    var inject = ["slots"];

    function MyGraceStatusCard(props) {
      var wide = !!(props && props.wide);

      // Collapsed: compact monogram.
      if (!wide) {
        return jsxRuntime.jsx(
          "div",
          {
            title: "MyGRACE",
            style: {
              width: 28,
              height: 28,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
              fontWeight: 700,
              color: "#6aa9ff",
            },
            children: "MG",
          }
        );
      }

      // Expanded: status card.
      return jsxRuntime.jsxs(
        "div",
        {
          style: {
            padding: "8px 10px",
            margin: "4px 0",
            borderRadius: 8,
            background: "var(--dsw-alias-bg-l2, #1b1f27)",
            color: "var(--dsw-alias-label-primary, #e8eaf0)",
            fontSize: 12,
            lineHeight: 1.5,
          },
          children: [
            jsxRuntime.jsx(
              "div",
              { style: { fontWeight: 600, marginBottom: 2 }, children: "MyGRACE" }
            ),
            jsxRuntime.jsx(
              "div",
              {
                style: { opacity: 0.85 },
                children: "Graph-first workflow is active in this workspace.",
              }
            ),
            jsxRuntime.jsx(
              "div",
              {
                style: { opacity: 0.6, fontSize: 11 },
                children: "Ask the \u201cmygrace-status\u201d skill or run \u201cmygrace status\u201d.",
              }
            ),
          ],
        }
      );
    }

    function apply(ctx) {
      ctx.slots.inject("sidebar.footer.action", function () {
        return ctx.slots.register(
          { name: "sidebar.footer.action", id: "mygrace-status-panel", order: 100 },
          MyGraceStatusCard
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
