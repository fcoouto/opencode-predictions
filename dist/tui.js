// src/tui.ts
import { Plugin } from "@opencode/plugin/tui";

// src/adapters/terminal.ts
function createTerminalAdapter(renderer) {
  let painted;
  let original;
  let ghost;
  const editor = () => {
    const value = renderer.currentFocusedEditor;
    if (!value || typeof value.plainText !== "string" || typeof value.insertText !== "function" || !("placeholder" in value)) return;
    const traits = value.traits;
    if (traits?.owner !== "opencode" || traits.role !== "prompt" || traits.status || traits.capture?.length !== 1 || traits.capture[0] !== "tab") return;
    return value;
  };
  const clear = () => {
    if (painted && painted.placeholder === ghost) painted.placeholder = original;
    painted = void 0;
    ghost = void 0;
  };
  return {
    eligible: () => editor()?.plainText === "",
    read: () => editor()?.plainText ?? "",
    paint(text) {
      const current = editor();
      if (!text || !current || current.plainText !== "") {
        clear();
        return false;
      }
      if (painted !== current) {
        clear();
        painted = current;
        original = current.placeholder;
      }
      ghost = text;
      if (current.placeholder !== text) current.placeholder = text;
      return true;
    },
    insert(text) {
      const current = editor();
      if (!current || current.plainText !== "") return false;
      clear();
      current.insertText(text);
      return true;
    },
    dispose: clear
  };
}

// src/controller.ts
function createController(io) {
  let current = { eligible: false, draft: "" };
  let pending;
  let result;
  let visible = false;
  let disposed = false;
  const attempted = /* @__PURE__ */ new Set();
  const remember = (key) => {
    attempted.add(key);
    if (attempted.size > 128) attempted.delete(attempted.values().next().value);
  };
  const paint = () => {
    visible = io.paint(!disposed && current.eligible && !current.draft && result?.key === current.key ? result?.text : void 0);
  };
  const clear = () => {
    pending?.abort();
    pending = void 0;
    result = void 0;
    visible = false;
    io.paint(void 0);
  };
  return {
    update(snapshot) {
      if (disposed) return;
      if (snapshot.key !== current.key || snapshot.draft) clear();
      current = snapshot;
      if (snapshot.key && snapshot.draft) remember(snapshot.key);
      paint();
    },
    async request(manual = false) {
      const key = current.key;
      if (disposed || !key || !current.eligible || current.draft || pending || !manual && attempted.has(key)) return;
      remember(key);
      const request = new AbortController();
      pending = request;
      try {
        const reply = await io.predict(request.signal);
        if (!disposed && !request.signal.aborted && current.key === key && !current.draft && reply.text) result = { key, text: reply.text };
      } catch {
      } finally {
        if (pending === request) pending = void 0;
        paint();
      }
    },
    dismiss() {
      const shown = visible;
      if (current.key) remember(current.key);
      clear();
      return shown;
    },
    accept() {
      if (disposed || !visible || !current.eligible || current.draft || !result || result.key !== current.key) return false;
      const text = result.text;
      clear();
      return io.insert(text);
    },
    preview() {
      return result?.key === current.key ? result?.text : void 0;
    },
    dispose() {
      disposed = true;
      clear();
      attempted.clear();
    }
  };
}

// src/log.ts
var prefix = "[opencode-predictions]";
function log(show, message) {
  show(message.startsWith(prefix) ? message : `${prefix} ${message}`);
}

// src/client.ts
function startClient(host) {
  const show = (message) => log((message2) => host.show(message2), message);
  let current;
  let cache;
  let scope;
  let checked = 0;
  let loading;
  let disposed = false;
  let manual;
  let error = "";
  const controller = createController({
    paint: host.paint,
    insert: host.insert,
    predict: async (signal) => {
      const state = current;
      const id = crypto.randomUUID();
      let reply;
      try {
        reply = await host.predict(state, id, signal, (message) => {
          if (!signal.aborted && host.state()?.key === state.key) show(message);
        });
      } catch {
        if (!signal.aborted && host.state()?.key === state.key) {
          error = "Prediction service unavailable";
          show(error);
        }
        return { reason: "service_unavailable" };
      } finally {
        tick();
      }
      if (reply.reason && !["no_suggestion", "cancelled", "stale"].includes(reply.reason)) error = reply.reason;
      return reply;
    }
  });
  const load = async (state) => {
    const request = new AbortController();
    loading = request;
    try {
      const value = await host.status(state, request.signal);
      if (!disposed && !request.signal.aborted && host.state()?.key === state.key) {
        cache = value;
        error = value.reason ?? "";
        checked = Date.now();
      }
    } catch {
      if (!request.signal.aborted) {
        cache = void 0;
        error = "Prediction service unavailable";
        checked = Date.now();
      }
    } finally {
      if (loading === request) loading = void 0;
      if (!disposed && !request.signal.aborted) tick();
    }
  };
  const tick = () => {
    if (disposed) return;
    current = host.state();
    if (current?.key !== scope) {
      if (manual !== current?.key) manual = void 0;
      loading?.abort();
      loading = void 0;
      cache = void 0;
      checked = 0;
      scope = current?.key;
    }
    if (current && !loading && Date.now() - checked >= 2e3) void load(current);
    controller.update({ key: current && cache ? current.key + "/" + cache.version : void 0, eligible: !!current?.eligible && !!cache?.enabled, draft: current?.draft ?? "" });
    if (cache?.enabled && current?.eligible && !current.draft && (cache.automatic || manual === current.key)) {
      const requested = manual === current.key;
      manual = void 0;
      void controller.request(requested).catch(() => {
        error = "Prediction service unavailable";
      });
    }
  };
  const interval = setInterval(tick, 100);
  tick();
  return {
    accept() {
      tick();
      return controller.accept();
    },
    dismiss() {
      tick();
      return controller.dismiss();
    },
    request() {
      manual = host.state()?.key;
      host.focus();
      tick();
    },
    async status() {
      const preview = controller.preview();
      const state = host.state();
      if (state) {
        loading?.abort();
        await load(state);
      }
      show(JSON.stringify({ ...host.diagnostics?.(), ...cache, ...!cache ? { reason: error || "No completed session" } : {}, ...preview ? { suggestion: preview } : {}, ...error ? { lastNotice: error } : {} }, null, 2));
    },
    invalidate() {
      loading?.abort();
      loading = void 0;
      cache = void 0;
      checked = 0;
      controller.update({ eligible: false, draft: "" });
      tick();
    },
    dispose() {
      disposed = true;
      clearInterval(interval);
      loading?.abort();
      controller.dispose();
    }
  };
}

// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
var Predictions = Rpc.define({
  id: "fcoouto.predictions",
  methods: {
    predict: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string", minLength: 5 }, completion: { type: "number", minimum: 0 }, requestID: { type: "string", minLength: 1 } },
        required: ["sessionID", "completion", "requestID"],
        additionalProperties: false
      },
      output: { type: "object", properties: { text: { type: "string" }, reason: { type: "string" } }, additionalProperties: false }
    },
    status: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object" }
    }
  },
  events: {
    progress: {
      schema: { type: "object", properties: { requestID: { type: "string" }, sessionID: { type: "string" }, message: { type: "string" } }, required: ["requestID", "sessionID", "message"], additionalProperties: false }
    }
  }
});

// src/tui.ts
var tui_default = Plugin.define({
  id: "opencode-predictions.tui",
  setup(ctx) {
    const adapter = createTerminalAdapter(ctx.renderer);
    const session = () => {
      const route = ctx.ui.router.current();
      return route.type === "session" ? ctx.data.session.get(route.sessionID) : void 0;
    };
    const client = startClient({
      state: () => {
        const value = session();
        if (!value || value.parentID || !value.time.idle || ctx.data.session.status(value.id) !== "idle" || value.outcome === "interrupted") return;
        const eligible = adapter.eligible() && !ctx.data.session.pending.list(value.id).length && !ctx.data.session.permission.list(value.id)?.length && !ctx.data.session.form.list(value.id, value.location)?.length;
        return { key: value.id + "/" + value.location.directory + "/" + value.time.idle, sessionID: value.id, completion: value.time.idle, eligible, draft: adapter.read() };
      },
      status: async (state, signal) => {
        const value = session();
        if (!value || value.id !== state.sessionID) throw new Error("Session changed");
        return await ctx.client.rpc(Predictions).status({}, { location: value.location, signal });
      },
      predict: async (state, requestID, signal, notice) => {
        const value = session();
        if (!value || value.id !== state.sessionID) return { reason: "stale" };
        const rpc = ctx.client.rpc(Predictions);
        const stop = rpc.events.on("progress", (event) => {
          if (event.data.requestID === requestID && event.data.sessionID === state.sessionID) notice(String(event.data.message));
        });
        try {
          return await rpc.predict({ sessionID: state.sessionID, completion: state.completion, requestID }, { location: value.location, signal });
        } finally {
          stop();
        }
      },
      paint: adapter.paint,
      insert: adapter.insert,
      focus: () => ctx.renderer.currentFocusedEditor?.focus(),
      show: (message) => {
        ctx.ui.toast.show({ title: "Prompt predictions", message, duration: 8e3 });
      },
      diagnostics: () => ({ host: "CLI", hostVersion: ctx.app.version, composerEligible: adapter.eligible() })
    });
    ctx.keymap.layer(() => ({ priority: 20, commands: [
      { id: "predictions.accept", bind: "tab", run: () => client.accept() ? void 0 : false },
      { id: "predictions.dismiss", bind: "escape", run: () => client.dismiss() ? void 0 : false },
      { id: "predictions.request", title: "Predict next prompt", group: "Predictions", palette: true, run: () => client.request() },
      { id: "predictions.status", title: "Prediction status and preview", group: "Predictions", palette: true, run: () => client.status() }
    ] }));
    const stopConfig = ctx.data.on("config.updated", () => client.invalidate());
    const stopPlugin = ctx.data.on("plugin.updated", () => client.invalidate());
    return () => {
      stopConfig();
      stopPlugin();
      client.dispose();
      adapter.dispose();
    };
  }
});
export {
  tui_default as default
};
//# sourceMappingURL=tui.js.map
