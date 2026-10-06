// mimo-indicator — browser half (home-level plugin).
//
// 会话标题栏右侧的状态灯：每 1.2s 轮询 /mimo-indicator/status（家级 host 半经
// webServer 暴露的 HTTP 路由），按项目（工作目录 cwd）分别渲染一盏灯。
//
//   running  → 蓝色呼吸圆点, "⟳ MIMO [×N]"
//   ok       → 绿色圆点, "✓ MIMO"
//   failed   → 红色圆点, "✗ MIMO"
//   fallback → 琥珀色圆点, "↩ MIMO"
//   idle     → 灰色圆点, "MIMO"
//
// 【关键契约】__ModuleLoader__.load 的模块 id 必须 === npm 包名
// "mimo-first-bridge"。client-modules 按 loader 行解析到的 package.json 的
// name 生成 graph 行 id；若 bundle 已加载却没注册同名模块，arrive() 抛
//   'bundle ... loaded without registering "<name>"'，
// combo 机制下单模块失败会糊掉整屏插件页。切勿改回 "mimo-indicator"。

window.__ModuleLoader__.load({
  id: "mimo-first-bridge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");

    const CSS = [
      ".mimo-ind{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:1;color:var(--dsw-alias-label-secondary);white-space:nowrap;user-select:none}",
      ".mimo-ind:hover{border-color:var(--dsw-alias-border-l2);cursor:pointer}",
      ".mimo-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-label-secondary)}",
      ".mimo-ind b{font-weight:600}",
      ".mimo-run .mimo-dot{background:var(--dsw-static-blue-500,#3b82f6);animation:mimo-pulse 1s ease-in-out infinite}",
      ".mimo-ok .mimo-dot{background:var(--dsw-static-green-500,#22c55e)}",
      ".mimo-fail .mimo-dot{background:var(--dsw-alias-state-error-primary)}",
      ".mimo-fb .mimo-dot{background:var(--dsw-alias-state-warn-primary)}",
      ".mimo-run{color:var(--dsw-static-blue-500,#3b82f6);border-color:var(--dsw-static-blue-500,#3b82f6)}",
      ".mimo-ok{color:var(--dsw-static-green-500,#22c55e);border-color:var(--dsw-static-green-500,#22c55e)}",
      ".mimo-fb{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}",
      "@keyframes mimo-pulse{0%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.72)}100%{opacity:1;transform:scale(1)}}",
      ".mimo-pop-overlay{position:fixed;inset:0;background:rgba(0,0,0,.32);z-index:10000;display:flex;align-items:center;justify-content:center}",
      ".mimo-pop-panel{width:520px;max-width:92vw;max-height:76vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.35);font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow:hidden}",
      ".mimo-pop-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);font-weight:600}",
      ".mimo-pop-close{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;width:22px;height:22px;line-height:1;font-size:13px;cursor:pointer}",
      ".mimo-pop-body{overflow:auto;padding:12px 14px}",
      ".mimo-pop-empty{color:var(--dsw-alias-label-secondary);text-align:center;padding:18px 0}",
      ".mimo-pop-proj{margin-bottom:12px;padding-bottom:12px;border-bottom:1px dashed var(--dsw-alias-border-l1)}",
      ".mimo-pop-proj:last-child{border-bottom:none}"
    ].join("");

    let styleEl = null;
    function ensureStyle() {
      if (styleEl && document.head.contains(styleEl)) return;
      styleEl = document.createElement("style");
      styleEl.textContent = CSS;
      document.head.appendChild(styleEl);
    }

    function classFor(state, running) {
      if (running > 0) return "mimo-run";
      if (state === "ok") return "mimo-ok";
      if (state === "failed") return "mimo-fail";
      if (state === "fallback") return "mimo-fb";
      return "mimo-idle";
    }

    function labelFor(p) {
      if (p.running > 0) return "⟳ MIMO" + (p.running > 1 ? " ×" + p.running : "");
      if (p.state === "ok") return "✓ MIMO";
      if (p.state === "failed") return "✗ MIMO";
      if (p.state === "fallback") return "↩ MIMO";
      return "MIMO";
    }

    function tooltipFor(p) {
      const bits = [p.name || p.cwd || "project", "state=" + p.state, "running=" + p.running];
      if (p.current && p.current.label) bits.push("step: " + p.current.label);
      if (p.lastStatus) bits.push("last=" + p.lastStatus);
      if (p.lastSessionId) bits.push("session=" + p.lastSessionId);
      return bits.join("\n");
    }

    function DetailPanel(props) {
      const projects = props.projects || [];
      return react.createElement(
        "div",
        {
          className: "mimo-pop-overlay",
          onClick: (e) => { if (e.target === e.currentTarget) props.onClose(); }
        },
        react.createElement(
          "div",
          { className: "mimo-pop-panel" },
          react.createElement(
            "div",
            { className: "mimo-pop-head" },
            react.createElement("span", null, "MiMo 活动详情"),
            react.createElement("button", { className: "mimo-pop-close", onClick: props.onClose }, "×")
          ),
          react.createElement(
            "div",
            { className: "mimo-pop-body" },
            projects.length === 0
              ? react.createElement("div", { className: "mimo-pop-empty" }, "暂无项目活动")
              : projects.map((p) =>
                  react.createElement(
                    "div",
                    { key: p.cwd, className: "mimo-pop-proj" },
                    react.createElement("div", null, react.createElement("b", null, p.name || p.cwd), " · ", p.state, " · running=", String(p.running)),
                    p.current && p.current.label
                      ? react.createElement("div", null, "step: ", p.current.label)
                      : null,
                    (p.trail || []).slice(-6).map((e, i) =>
                      react.createElement("div", { key: i }, "· ", e.label || "")
                    ),
                    p.lastStatus
                      ? react.createElement("div", null, "last=", p.lastStatus, p.lastSessionId ? " session=" + p.lastSessionId : "")
                      : null
                  )
                )
          )
        )
      );
    }

    // per-session preset 判定（对齐 agy-indicator / codebuddy-indicator 的既有修复）：
    // 家级 host 的 presetActive 是**全局租约** —— 任何一个 mimo preset 会话在线并
    // 每 30s 心跳续期（TTL 75s），都会把 presetActive 持续刷成 true。普通会话若只看
    // presetActive，就会误以为自己是 mimo 模式而**常驻一盏灯**（实测症状：MiMo 预设
    // 会话关掉后灯依然常亮不消失）。真正的常驻资格是「本会话的 agentPreset 就是
    // mimo preset」。两条读取通道：
    //   a) 框架标准 props（DSH ≥ 0.3.14 / dsh 0.1.2-alpha.5）：sessionId 与
    //      useSessions 选择器钩子由会话作用域槽位框架注入，读
    //      byId[sessionId].projectionValues.agentPreset（alpha.5 起 preset 字段移入投影值）；
    //   b) 旧式注入（更早版本）：inject(sessionId) 收到会话 id + sessions 服务的
    //      list 快照（byId[sessionId].agentPreset，旧 summary 字段）。
    // 都不可用 → UNKNOWN → 回退端点的全局心跳租约（host 半）。
    // UNKNOWN 哨兵必须是稳定原始值（getSnapshot 契约）。
    // 「刚刚出过结果」的窗口：与 host 半 PROJECT_TTL_MS 同一量级。超出即视为
    // 历史残留，不再单独点亮状态灯（详情面板仍可回看）。
    const RECENT_MS = 10 * 60 * 1000;
    const PRESET_UNKNOWN = "\u0000unknown";
    // mimo 优先 preset 的 id（roster 目录名）。默认 mimo-first；兼容可能的别名。
    function isMimoPreset(id) {
      return id === "mimo-first" || id === "cordis-mimo" || id === "cordis-mimo-first";
    }
    function subscribeNoop() { return function () { }; }
    function presetOfSummary(sum) {
      if (!sum) return PRESET_UNKNOWN;
      if (sum.projectionValues && typeof sum.projectionValues.agentPreset === "string") return sum.projectionValues.agentPreset;
      if (typeof sum.agentPreset === "string") return sum.agentPreset;
      return PRESET_UNKNOWN;
    }
    function presetOfState(state, sessionId) {
      try {
        if (!state || !sessionId || !state.byId) return PRESET_UNKNOWN;
        return presetOfSummary(state.byId[sessionId]);
      } catch (e) { return PRESET_UNKNOWN; }
    }

    function Indicator(props) {
      const p = props || {};
      // 标准属性（新框架）优先；老框架经 inject(sessionId) 提供 injectedSessionId。
      const sessionId = (typeof p.sessionId === "string" && p.sessionId)
        || (typeof p.injectedSessionId === "string" && p.injectedSessionId) || undefined;
      const useSess = typeof p.useSessions === "function" ? p.useSessions : null;
      const sessionsSvc = p.sessionsSvc;
      const [snap, setSnap] = react.useState({ state: "idle", running: 0, projects: [], presetActive: false });
      const [open, setOpen] = react.useState(false);
      const timerRef = react.useRef(null);

      // 本会话的 agent preset（三态：已知 mimo / 已知其他 / UNKNOWN）。
      // 恰好一条钩子通道；useSessions 的有无在同一挂载期内恒定，满足 hooks 规则。
      let myPreset;
      if (useSess) {
        myPreset = useSess(function (state) { return presetOfState(state, sessionId); });
      } else {
        myPreset = react.useSyncExternalStore(
          (sessionsSvc && sessionsSvc.list) ? sessionsSvc.list.subscribe : subscribeNoop,
          function () {
            try {
              if (!sessionsSvc || !sessionsSvc.list) return PRESET_UNKNOWN;
              return presetOfState(sessionsSvc.list.getSnapshot(), sessionId);
            } catch (e) { return PRESET_UNKNOWN; }
          });
      }
      const presetKnown = myPreset !== PRESET_UNKNOWN;
      const iAmMimo = presetKnown ? isMimoPreset(myPreset) : null;

      react.useEffect(() => {
        ensureStyle();
        let cancelled = false;
        async function tick() {
          try {
            const r = await fetch("/mimo-indicator/status", { cache: "no-store" });
            if (!r.ok) return;
            const data = await r.json();
            if (cancelled) return;
            setSnap(data || { state: "idle", projects: [] });
          } catch (e) { /* DSH not ready / route missing */ }
        }
        tick();
        timerRef.current = setInterval(tick, 1200);
        return () => {
          cancelled = true;
          if (timerRef.current) clearInterval(timerRef.current);
        };
      }, []);

      react.useEffect(() => {
        function onKey(e) { if (e.key === "Escape") setOpen(false); }
        if (open) window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [open]);

      // 活跃项目 = 正在运行 / 回退中 / 刚刚（RECENT_MS 内）出过结果的项目。
      // 对齐设计文档「普通会话 → 仅在有运行中/回退/短时 ok/failed 项目时显示」：
      // 旧实现只判 projects.length>0 && state∈{ok,failed}，没有「短时」约束，
      // 于是一条几十小时前的历史记录会把灯永久点亮 —— 这正是「状态灯长时间
      // 不消失」的直接原因。host 半对超期记录打了 stale 标记；这里再按
      // updatedAt 兜底，兼容尚未升级的旧版 host。
      const now = Date.now();
      const allProjects = snap.projects || [];
      const projects = allProjects.filter((x) => {
        if (!x) return false;
        if (x.running > 0) return true;
        if (x.stale === true) return false;
        if (x.state === "fallback" || x.fallbackActive === true) return true;
        const at = Number(x.updatedAt) || Number(x.lastAt) || 0;
        if (!at) return false;
        return (now - at) < RECENT_MS;
      });
      // 空转「就绪」占位灯的资格：本会话确实是 mimo preset。判定不可用
      // （UNKNOWN）时回退全局租约 presetActive —— 但那只给短暂占位，快照就绪
      // 后立即收敛到本会话的真实资格，避免其他会话开着 preset 时本会话常驻灯。
      const readyShow = iAmMimo === true || (iAmMimo === null && !!snap.presetActive);
      // 既无活跃项目、又不是 mimo preset 会话 → 标题栏不留灯。
      if (projects.length === 0 && !readyShow) return null;
      const top = projects.slice(0, 4);

      return react.createElement(
        react.Fragment,
        null,
        react.createElement(
          "span",
          { style: { display: "inline-flex", gap: 6, alignItems: "center" } },
          top.length === 0
            ? react.createElement(
                "span",
                {
                  className: "mimo-ind " + classFor(snap.state || "idle", snap.running || 0),
                  title: "MiMo 就绪",
                  onClick: () => setOpen(true)
                },
                react.createElement("span", { className: "mimo-dot" }),
                react.createElement("b", null, "MIMO")
              )
            : top.map((p) =>
                react.createElement(
                  "span",
                  {
                    key: p.cwd,
                    className: "mimo-ind " + classFor(p.state, p.running),
                    title: tooltipFor(p),
                    onClick: () => setOpen(true)
                  },
                  react.createElement("span", { className: "mimo-dot" }),
                  react.createElement("b", null, labelFor(p))
                )
              )
        ),
        open ? react.createElement(DetailPanel, { projects: projects, onClose: () => setOpen(false) }) : null
      );
    }

    function apply(ctx) {
      if (typeof ctx.inject !== "function") return;
      ctx.inject(["slots"], function (scope) {
        const slots = scope.get ? scope.get("slots") : scope.slots;
        if (!slots) return;
        const slotsSvc = scope.slots || slots;
        if (typeof slotsSvc.inject !== "function") return;
        slotsSvc.inject("conversation.session.header.utilities", function () {
          // inject 兼容两层：新框架（≥0.3.14）以零参调用本函数、标准 props 由框架
          // 合入（sessionId + useSessions）；旧框架以 sessionId 调用——改名
          // injectedSessionId 避免与标准 props 冲突。sessionsSvc 两代通用。
          return slots.register(
            {
              name: "conversation.session.header.utilities",
              id: "mimo-indicator-home",
              order: 50,
              inject: function (injectedSessionId) {
                return { injectedSessionId: injectedSessionId, sessionsSvc: scope.get("sessions") };
              }
            },
            function (props) {
              return react.createElement(Indicator, props);
            }
          );
        });
      });
    }

    exports.default = { apply: apply, inject: ["slots"], name: "mimo-first-bridge" };
    exports.apply = apply;
    exports.inject = ["slots"];
    exports.name = "mimo-first-bridge";
    return module.exports;
  }
});

