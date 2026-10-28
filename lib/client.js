window.__ModuleLoader__.load({
  id: "dsh-decay-memory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require("react");
    const h = react.createElement;

    // 面板本身用 iframe 嵌 host 提供的 /decay-memory：
    // 页面逻辑只有一份（lib/page.js），DOM 与数据接口都同源，不再维护第二套 UI。
    function DecayMemoryPanel() {
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 8, padding: "2px 2px 8px" } },
        h("iframe", {
          src: "/decay-memory",
          title: "会淡忘的记忆",
          style: {
            width: "100%",
            height: "calc(100vh - 240px)",
            minHeight: "420px",
            border: "0",
            borderRadius: "12px",
            background: "#0f1216",
            colorScheme: "dark"
          }
        })
      );
    }

    exports.name = "dsh-decay-memory";
    exports.inject = ["slots"];

    exports.apply = function apply(ctx) {
      const registerSection = () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "decay-memory",
            order: 60,
            label: () => "会淡忘的记忆"
          },
          () => h(DecayMemoryPanel, {})
        );

      if (typeof ctx.slots.inject === "function") {
        ctx.slots.inject("settings.section", () => {
          const off = registerSection();
          return typeof off === "function" ? off : undefined;
        });
      } else {
        registerSection();
      }
    };

    return module.exports;
  }
});
