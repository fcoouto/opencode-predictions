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
  const results = /* @__PURE__ */ new Map();
  let visible = false;
  let disposed = false;
  const attempted = /* @__PURE__ */ new Set();
  const remember = (key) => {
    attempted.add(key);
    if (attempted.size > 128) {
      const oldest = attempted.values().next().value;
      attempted.delete(oldest);
      results.delete(oldest);
    }
  };
  const paint = () => {
    visible = io.paint(!disposed && current.eligible && !current.draft && current.key ? results.get(current.key)?.text : void 0);
  };
  const clear = () => {
    pending?.abort();
    pending = void 0;
    visible = false;
    io.paint(void 0);
  };
  return {
    update(snapshot) {
      if (disposed) return;
      if (snapshot.key !== current.key || snapshot.draft) clear();
      current = snapshot;
      if (snapshot.draft) {
        const contextKey = snapshot.contextKey ?? snapshot.key;
        for (const [key, result] of results) if (result.contextKey === contextKey && !result.accepted) results.delete(key);
        if (snapshot.key) remember(snapshot.key);
      }
      paint();
    },
    async request(manual = false) {
      const key = current.key;
      if (disposed || !key || !current.eligible || current.draft || pending || !manual && attempted.has(key)) return;
      const contextKey = current.contextKey ?? key;
      remember(key);
      const request = new AbortController();
      pending = request;
      try {
        const reply = await io.predict(request.signal);
        if (!disposed && !request.signal.aborted && current.key === key && !current.draft && reply.text) results.set(key, { text: reply.text, contextKey });
      } catch {
      } finally {
        if (pending === request) pending = void 0;
        paint();
      }
    },
    dismiss() {
      const shown = visible;
      if (current.key) {
        results.delete(current.key);
        remember(current.key);
      }
      ;
      clear();
      return shown;
    },
    accept() {
      const result = current.key ? results.get(current.key) : void 0;
      if (disposed || !visible || !current.eligible || current.draft || !result) return false;
      clear();
      if (!io.insert(result.text)) return false;
      result.accepted = true;
      return true;
    },
    preview() {
      return current.key ? results.get(current.key)?.text : void 0;
    },
    dispose() {
      disposed = true;
      clear();
      results.clear();
      attempted.clear();
    }
  };
}

// src/log.ts
var prefix = "[opencode-predictions]";
function log(show, message) {
  show(message.startsWith(prefix) ? message : `${prefix} ${message}`);
}

// package.json
var package_default = {
  name: "opencode-predictions",
  version: "0.1.0",
  description: "Next-prompt predictions for OpenCode Desktop and CLI",
  type: "module",
  license: "MIT",
  repository: { type: "git", url: "https://github.com/fcoouto/opencode-predictions.git" },
  engines: { node: ">=26.4.0" },
  files: ["dist", "README.md", "LICENSE"],
  exports: {
    ".": "./dist/index.js",
    "./tui": "./dist/tui.js",
    "./gui-experimental": "./dist/gui-experimental.cjs",
    "./rpc": "./dist/rpc.js"
  },
  bin: { "opencode-predictions-pilot": "./dist/pilot.js" },
  scripts: {
    test: "node --test tests/*.test.ts",
    typecheck: "tsc --noEmit",
    bundle: "node scripts/build.mjs",
    pilot: "node src/pilot.ts",
    "test:host:server": "node --test tests/host/server.test.ts",
    "test:host:desktop": "node --test tests/host/desktop.test.ts",
    "test:host:terminal": "node --test tests/host/terminal.test.ts",
    "test:host:git": "node --test tests/host/git.test.ts",
    "test:package": "node --test tests/package.test.mjs",
    "test:installed": "node scripts/test-installed.mjs",
    check: "npm test && npm run typecheck && npm run bundle"
  },
  dependencies: { "@opencode/plugin": "2.2.6", "@opencode/client": "2.2.6" },
  devDependencies: {
    "@opentui/core": "0.8.4",
    "@types/node": "26.6.6",
    esbuild: "0.27.0",
    playwright: "1.65.0",
    "solid-js": "1.9.19",
    typescript: "5.9.3",
    vite: "7.3.1",
    "vite-plugin-solid": "2.11.16"
  }
};

// src/feedback.ts
var pluginVersion = package_default.version;
var feedbackRevision = 1;
function reasonNotice(reason) {
  if (!reason || ["cancelled", "stale"].includes(reason)) return;
  const info = {
    disabled: ["Predictions are turned off", "Set enabled to true in this plugin's configuration to request predictions."],
    no_suggestion: ["No suggestion for this response", "Continue typing your next prompt."],
    context_unavailable: ["No completed response to predict from", "Finish an assistant response with usable conversation text, then request a prediction."],
    composer_unavailable: ["The prompt is not ready for a prediction", "Clear the prompt and close menus or pending input, then request a prediction."],
    location_unavailable: ["No prediction location selected", "Open a project or session, then open Prediction status and preview again."]
  };
  if (info[reason]) return { code: reason, severity: "info", title: info[reason][0], message: info[reason][1] };
  if (reason === "models_required") return { code: reason, severity: "error", title: "Predictions need a model", message: "Set models to a provider/model selector in this plugin's OpenCode configuration.", persistent: true };
  if (reason === "model_unavailable") return { code: reason, severity: "error", title: "No prediction models match", message: "Check the provider, model pattern, and requested variant in Prediction status and preview. No model was called.", persistent: true };
  if (reason === "wrong_location") return { code: reason, severity: "error", title: "Prediction location changed", message: "Open the intended project and request a prediction again." };
  if (reason === "timeout") return { code: reason, severity: "error", title: "Prediction timed out", message: "The model did not respond within the configured timeout. Check model availability in Prediction status and preview before requesting again." };
  return { code: "service_unavailable", severity: "error", title: "Prediction service unavailable", message: "Predictions could not complete. Check the OpenCode service connection, then request a prediction again. Open Prediction status and preview for details." };
}
function statusNotice(status) {
  if (status.reason === "no_models_eligible") {
    const candidates = status.candidates ?? [];
    const retryAt = candidates.filter((model) => model.state === "cooling" && Number.isFinite(model.retryAt)).map((model) => model.retryAt);
    const causes = [...new Set(candidates.map((model) => model.reason).filter(Boolean))].slice(0, 3).join(" ");
    const recovery = retryAt.length ? `Earliest retry eligibility: ${new Date(Math.min(...retryAt)).toISOString()}. A new prediction request can try again afterward.` : "Check your provider connection, model access, and configuration. Blocked models remain blocked until the server plugin reloads.";
    return { code: "models_unavailable", severity: "error", title: retryAt.length ? "Prediction models are temporarily paused" : "Prediction models are blocked", message: [causes, recovery].filter(Boolean).join(" "), persistent: !retryAt.length };
  }
  if (status.reason && status.reason !== "disabled") {
    if (["models_required", "model_unavailable", "service_unavailable"].includes(status.reason)) return reasonNotice(status.reason);
    const validation = /^(Plugin options|enabled|automatic|debug|timeoutMs|contextTurns|models|each models group) must /.test(status.reason) ? status.reason : "The service rejected these settings.";
    return { code: "invalid_options", severity: "error", title: "Prediction settings are invalid", message: `${validation}. Correct this plugin's options in your OpenCode configuration.`, persistent: true };
  }
  if (status.warnings.length) return { code: "options_warning", severity: "warning", title: "Some prediction settings were ignored", message: `${status.warnings.join(". ")}. Remove or correct these options in your OpenCode configuration.` };
}
function formatStatus(status, details) {
  const notice2 = status?.reason === "disabled" ? reasonNotice("disabled") : details.currentNotice ?? (status && (statusNotice(status) ?? (!status.enabled ? reasonNotice("disabled") : void 0)));
  const lines = ["Prediction status snapshot \u2014 reopen to refresh.", "", `State: ${notice2?.title ?? (status ? "Ready" : "Unavailable")}`];
  if (notice2) lines.push(notice2.message);
  if (status) {
    lines.push("", `Mode: ${status.automatic ? "Automatic" : "Manual only"}`, `Models: ${status.models ?? "Not configured"}`);
    const groups = status.groups ?? (status.candidates ? [{ selectors: status.models ?? "", candidates: status.candidates }] : []);
    for (const [index, group] of groups.entries()) {
      lines.push(`Group ${index + 1}: ${group.selectors}`);
      if (!group.candidates.length) lines.push("  No matching models.");
      for (const model of group.candidates) lines.push(`  ${model.providerID}/${model.id}${model.variant ? "#" + model.variant : ""}: ${model.state}${model.reason ? " \u2014 " + model.reason : ""}${model.retryAt ? " Eligible after " + new Date(model.retryAt).toISOString() : ""}`);
    }
    if (status.warnings.length) lines.push("", "Settings warnings:", ...status.warnings);
  }
  if (details.lastNotice) {
    lines.push("", `Last failure: ${details.lastNotice.title}`);
    if (details.lastNotice.message !== notice2?.message) lines.push(details.lastNotice.message);
  }
  if (details.suggestion) lines.push("", "Current suggestion:", details.suggestion);
  const technical = [
    `Service plugin: ${status?.pluginVersion ?? "unknown (legacy metadata)"}`,
    `Service feedback revision: ${status?.feedbackRevision ?? "unknown (legacy metadata)"}`,
    `Last outcome: ${status?.lastOutcome ?? "None"}`,
    `Last latency: ${status?.lastLatencyMs === void 0 ? "Unknown" : status.lastLatencyMs + " ms"}`,
    `Timeout: ${status?.timeoutMs ?? "Unknown"} ms`,
    `Context turns: ${status?.contextTurns ?? "Unknown"}`,
    `Debug: ${status?.debug ?? "Unknown"}`,
    ...Object.entries(details.diagnostics ?? {}).map(([key, value]) => `${key}: ${String(value)}`)
  ];
  if (status && status.feedbackRevision !== feedbackRevision) technical.push("Feedback capabilities differ or are unknown. Check the installed client and server plugin versions to confirm compatibility.");
  return { summary: lines.join("\n"), details: technical.join("\n") };
}

// src/client.ts
function startClient(host) {
  const locations = /* @__PURE__ */ new Map();
  let scope;
  let current;
  let cache;
  let checked = -Infinity;
  let epoch = 0;
  let loading;
  let disposed = false;
  let manual;
  let requestingManual = false;
  let predicting;
  const activePrediction = () => predicting && !predicting.signal.aborted && predicting.scope === scope && predicting.epoch === epoch ? predicting : void 0;
  const fingerprint = (notice2) => JSON.stringify([notice2.code, notice2.severity, notice2.title, notice2.message, !!notice2.persistent]);
  const record = () => locations.get(scope);
  const activeNotice = () => {
    const value = scope && locations.get(scope);
    return value ? value.health?.severity === "error" ? value.health : value.requestFailure ?? value.health : void 0;
  };
  const announce = (notice2, explicit = false) => {
    if (disposed) return;
    const value = scope ? record() : void 0;
    if (value && notice2.severity === "error") value.lastNotice = notice2;
    if (!explicit && value?.announced === fingerprint(notice2)) return;
    if (notice2.severity !== "info" && value) {
      host.clearNotice?.();
      value.announced = fingerprint(notice2);
    }
    host.show(notice2);
  };
  const health = (notice2, recoveredModels = false) => {
    const value = record();
    const previous = value.health;
    value.health = notice2;
    if (previous && notice2?.code !== previous.code && value.requestFailure?.code === previous.code || recoveredModels && value.requestFailure?.code === "models_unavailable") {
      value.requestFailure = void 0;
      value.announced = void 0;
      host.clearNotice?.();
    }
    if (!activeNotice()) {
      value.announced = void 0;
      host.clearNotice?.();
    } else if (!manual && !activePrediction()?.explicit) announce(activeNotice());
  };
  const sync = () => {
    const next = host.scope();
    if (next !== scope) {
      loading?.abort.abort();
      loading = void 0;
      cache = void 0;
      checked = -Infinity;
      epoch++;
      manual = void 0;
      host.clearNotice?.();
      controller.update({ eligible: false, draft: "" });
      scope = next;
      if (scope && !locations.has(scope)) {
        locations.set(scope, {});
        if (locations.size > 32) locations.delete(locations.keys().next().value);
      }
    }
    current = host.state();
    if (manual?.key && manual.key !== current?.key) manual = void 0;
  };
  const controller = createController({
    paint: host.paint,
    insert: host.insert,
    predict: async (signal) => {
      const state = current;
      const location = scope;
      const generation = epoch;
      const explicit = requestingManual;
      let final;
      const modern = cache?.feedbackRevision === feedbackRevision;
      const debug = !!cache?.debug;
      const legacyProgress = [];
      const progress = (message) => log((text) => host.show({ code: "progress", severity: "info", title: "Prompt predictions", message: text }), message);
      const live = () => !disposed && !signal.aborted && epoch === generation && host.scope() === location && host.state()?.key === state.key;
      const flight = { signal, scope: location, epoch: generation, explicit };
      predicting = flight;
      try {
        let reply;
        try {
          reply = await host.predict(state, crypto.randomUUID(), signal, (message, notice3) => {
            if (!live()) return;
            if (notice3) {
              final = notice3;
              return;
            }
            if (modern) progress(message);
            else if (debug) {
              legacyProgress.push(message);
              if (legacyProgress.length > 32) legacyProgress.shift();
            }
          });
        } catch {
          reply = { reason: "service_unavailable", notice: reasonNotice("service_unavailable") };
        }
        if (!live()) return { reason: "stale" };
        if (reply.text || reply.reason === "no_suggestion") {
          record().requestFailure = void 0;
          record().announced = record().health ? fingerprint(record().health) : void 0;
          if (!record().health) host.clearNotice?.();
        }
        const notice2 = reply.notice ?? final ?? reasonNotice(reply.reason);
        for (const message of notice2?.severity === "error" ? legacyProgress.slice(0, -1) : legacyProgress) progress(message);
        if (notice2 && notice2.severity !== "info") {
          record().requestFailure = notice2;
          announce(notice2, explicit);
        } else if (notice2 && explicit) announce(notice2, true);
        return reply;
      } finally {
        if (predicting === flight) predicting = void 0;
      }
    }
  });
  const load = () => {
    if (!scope || disposed) return Promise.resolve();
    if (loading) return loading.done;
    const location = scope;
    const generation = epoch;
    const inspectedFailure = record().requestFailure;
    const abort = new AbortController();
    const live = () => !disposed && !abort.signal.aborted && epoch === generation && host.scope() === location;
    const request2 = { abort, done: Promise.resolve() };
    loading = request2;
    const done = (async () => {
      try {
        const value = await host.status(abort.signal);
        if (live()) {
          cache = value;
          checked = Date.now();
          const recoveredModels = record().requestFailure === inspectedFailure && !!value.candidates?.some((model) => model.state === "ready");
          health(statusNotice(value), recoveredModels);
        }
      } catch {
        if (live()) {
          cache = void 0;
          checked = Date.now();
          health(reasonNotice("service_unavailable"));
        }
      } finally {
        if (loading?.abort === abort) loading = void 0;
        if (live()) tick();
      }
    })();
    request2.done = done;
    return done;
  };
  const tick = () => {
    if (disposed) return;
    sync();
    if (scope && !loading && Date.now() - checked >= 2e3) void load();
    if (manual?.fromShortcut && (current?.draft || cache?.enabled === false)) manual = void 0;
    const available = !!cache?.enabled && !cache.reason;
    controller.update({ key: current && cache ? JSON.stringify([scope, current.key, cache.version]) : void 0, contextKey: current ? JSON.stringify([scope, current.key]) : void 0, eligible: !!current?.eligible && available, draft: current?.draft ?? "" });
    if (manual && !loading) {
      const issue = record().health?.severity === "error" ? record().health : !cache ? reasonNotice("service_unavailable") : !cache.enabled ? reasonNotice("disabled") : !current ? reasonNotice("context_unavailable") : current.draft || !current.eligible ? reasonNotice("composer_unavailable") : void 0;
      manual = void 0;
      if (issue) {
        announce(issue, true);
        return;
      }
      if (activePrediction()) {
        announce({ code: "prediction_pending", severity: "info", title: "A prediction is already running", message: "Wait for the current prediction to finish." }, true);
        return;
      }
      requestingManual = true;
      void controller.request(true);
      requestingManual = false;
    } else if (!manual && available && current?.eligible && !current.draft && cache?.automatic) void controller.request();
  };
  const request = (fromShortcut = false) => {
    if (disposed) return;
    sync();
    if (!scope) {
      announce(reasonNotice("location_unavailable"), true);
      return;
    }
    manual = { scope, key: host.state()?.key, fromShortcut };
    host.focus();
    tick();
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
    request,
    requestFromShortcut() {
      tick();
      if (!current?.eligible || current.draft || cache?.enabled === false) return false;
      request(true);
    },
    async status() {
      if (disposed) return;
      sync();
      const location = scope;
      const generation = epoch;
      if (scope) await load();
      if (disposed || epoch !== generation || host.scope() !== location) return;
      const value = scope ? record() : void 0;
      await host.openStatus(formatStatus(cache, { currentNotice: activeNotice() ?? (!scope ? reasonNotice("location_unavailable") : void 0), lastNotice: value?.lastNotice, suggestion: controller.preview(), diagnostics: host.diagnostics?.() }));
    },
    invalidate() {
      if (disposed) return;
      epoch++;
      loading?.abort.abort();
      loading = void 0;
      cache = void 0;
      checked = -Infinity;
      controller.update({ eligible: false, draft: "" });
      tick();
    },
    dispose() {
      disposed = true;
      clearInterval(interval);
      loading?.abort.abort();
      controller.dispose();
      host.clearNotice?.();
    }
  };
}

// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
var notice = {
  type: "object",
  properties: { code: { type: "string" }, severity: { type: "string", enum: ["info", "warning", "error"] }, title: { type: "string" }, message: { type: "string" }, persistent: { type: "boolean" } },
  required: ["code", "severity", "title", "message"],
  additionalProperties: false
};
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
      output: { type: "object", properties: { text: { type: "string" }, reason: { type: "string" }, notice }, additionalProperties: false }
    },
    status: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object" }
    }
  },
  events: {
    progress: {
      schema: { type: "object", properties: { requestID: { type: "string" }, sessionID: { type: "string" }, message: { type: "string" }, notice }, required: ["requestID", "sessionID", "message"], additionalProperties: false }
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
    const location = () => session()?.location ?? ctx.location ?? ctx.data.location.default();
    const client = startClient({
      scope: () => {
        const value = location();
        return value ? JSON.stringify(value) : void 0;
      },
      state: () => {
        const value = session();
        if (!value || value.parentID || !value.time.idle || ctx.data.session.status(value.id) !== "idle" || value.outcome === "interrupted") return;
        const eligible = adapter.eligible() && !ctx.data.session.pending.list(value.id).length && !ctx.data.session.permission.list(value.id)?.length && !ctx.data.session.form.list(value.id, value.location)?.length;
        return { key: value.id + "/" + value.location.directory + "/" + value.time.idle, sessionID: value.id, completion: value.time.idle, eligible, draft: adapter.read() };
      },
      status: async (signal) => await ctx.client.rpc(Predictions).status({}, { location: location(), signal }),
      predict: async (state, requestID, signal, notice2) => {
        const value = session();
        if (!value || value.id !== state.sessionID) return { reason: "stale" };
        const rpc = ctx.client.rpc(Predictions);
        const stop = rpc.events.on("progress", (event) => {
          if (event.data.requestID === requestID && event.data.sessionID === state.sessionID) notice2(String(event.data.message), event.data.notice);
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
      show: (notice2) => {
        ctx.ui.toast.show({ title: notice2.title, message: notice2.message + (notice2.severity !== "info" ? "\nOpen Prediction status and preview from the command palette for details." : ""), variant: notice2.severity, duration: 8e3 });
      },
      openStatus: async (view) => {
        if (await ctx.ui.dialog.confirm({ title: "Prediction status and preview", message: view.summary, label: { confirm: "Technical details", cancel: "Close" } })) await ctx.ui.dialog.alert({ title: "Prediction technical details", message: view.details });
      },
      diagnostics: () => ({ host: "CLI", hostVersion: ctx.app.version, clientVersion: pluginVersion, feedbackRevision, composerEligible: adapter.eligible() })
    });
    ctx.keymap.layer(() => ({ priority: 20, commands: [
      { id: "predictions.accept", bind: "tab", run: () => client.accept() ? void 0 : false },
      { id: "predictions.dismiss", bind: "escape", run: () => client.dismiss() ? void 0 : false },
      { id: "predictions.request", title: "Predict next prompt", group: "Predictions", palette: true, run: () => client.request() },
      { id: "predictions.request-shortcut", title: "Predict next prompt", bind: "alt+shift+p", run: () => client.requestFromShortcut() },
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
