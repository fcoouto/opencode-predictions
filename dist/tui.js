// src/tui.ts
import { Plugin } from "@opencode/plugin/tui";

// src/controller.ts
function communicationText(value, reducedMotion = false, shortcut = "Alt+Shift+P") {
  if (!value.activity) return value.message && value.offer ? `${value.message}
${shortcut}: try [${value.offer.name}].` : value.message;
  const indicator = reducedMotion ? "\u2026" : ["\u25B0\u25B1\u25B1", "\u25B1\u25B0\u25B1", "\u25B1\u25B1\u25B0"][Math.floor(Date.now() / 200) % 3];
  return "\uFFFB" + indicator + (value.activity.kind === "alternative" ? " " + value.activity.name : "");
}
function createController(io) {
  let current = { eligible: false, draft: "" };
  let pending;
  let staged;
  let modelName;
  let transient;
  let timer;
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
    const result = !disposed && !current.draft && current.key ? results.get(current.key) : void 0;
    const activity = pending && modelName ? { kind: "alternative", name: modelName } : staged ?? (pending ? result?.communication?.offer ? { kind: "alternative", name: result.communication.offer.name } : { kind: "initial" } : void 0);
    const message = transient && transient.key === current.key ? transient.message : void 0;
    visible = io.paint(current.eligible && !activity && !message ? result?.text : void 0);
    io.communicate?.(!current.draft && !disposed ? activity ? { ...result?.communication, message: "", activity, pending: true } : message ? { message } : result?.communication : void 0);
  };
  const clearTransient = () => {
    clearTimeout(timer);
    timer = void 0;
    transient = void 0;
  };
  const clear = () => {
    pending?.abort();
    pending = void 0;
    staged = void 0;
    modelName = void 0;
    clearTransient();
    visible = false;
    io.paint(void 0);
    io.communicate?.(void 0);
  };
  const exhausted = () => {
    if (!current.key) return;
    clearTransient();
    transient = { key: current.key, message: "No alternatives available." };
    timer = setTimeout(() => {
      transient = void 0;
      timer = void 0;
      paint();
    }, 1500);
    paint();
  };
  return {
    update(snapshot) {
      if (disposed) return;
      if (snapshot.key !== current.key || snapshot.draft) clear();
      current = snapshot;
      if (snapshot.key && snapshot.draft) {
        remember(snapshot.key);
        const result = results.get(snapshot.key);
        if (result?.text || result?.authority) result.communication = void 0;
        else results.delete(snapshot.key);
      }
      paint();
    },
    async request(manual = false, expectedOffer, continuation = false) {
      const key = current.key;
      if (disposed || !key || !current.eligible || current.draft || pending || !manual && attempted.has(key)) return;
      const communication = results.get(key)?.communication;
      if (manual && expectedOffer !== void 0 && (communication?.offer?.token ?? null) !== expectedOffer) return;
      if (manual && communication && !communication.offer && expectedOffer !== null) {
        staged = void 0;
        exhausted();
        return;
      }
      const escalation2 = manual ? communication?.offer?.token ?? (continuation && results.get(key)?.authority ? "refresh" : void 0) : void 0;
      const refreshing = manual && !!communication && !communication.offer;
      let noAlternatives = false;
      remember(key);
      const request = new AbortController();
      pending = request;
      clearTransient();
      paint();
      try {
        const reply = await io.predict(request.signal, escalation2);
        if (!disposed && !request.signal.aborted && current.key === key && !current.draft) {
          const text = reply.text || results.get(key)?.text;
          const next = reply.communication ?? (reply.escalation ? { message: "", offer: reply.escalation } : !reply.text && communication ? { message: text ? "" : "No suggestion." } : void 0);
          const authority = !!reply.text || ["no_suggestion", "escalation_refreshed"].includes(reply.reason ?? "") || results.get(key)?.authority;
          results.set(key, { text, communication: next, authority });
          noAlternatives = refreshing && reply.reason === "escalation_refreshed" && !next?.offer;
        }
      } catch {
        if (!request.signal.aborted && current.key === key) {
          const result = results.get(key);
          if (result?.communication) result.communication = { message: result.text ? "" : "Prediction failed." };
        }
      } finally {
        if (pending === request) {
          pending = void 0;
          staged = void 0;
          modelName = void 0;
          if (noAlternatives) exhausted();
          else paint();
        }
      }
    },
    accept() {
      const result = current.key ? results.get(current.key) : void 0;
      if (disposed || pending || staged || !visible || !current.eligible || current.draft || !result?.text) return false;
      clear();
      result.communication = void 0;
      const inserted = io.insert(result.text);
      if (!inserted) paint();
      return inserted;
    },
    stage(activity) {
      staged = activity;
      paint();
    },
    progress(name) {
      if (pending && !pending.signal.aborted) {
        modelName = name;
        paint();
      }
    },
    preview() {
      return current.key ? results.get(current.key)?.text : void 0;
    },
    invalidate() {
      clear();
      results.clear();
      attempted.clear();
    },
    dispose() {
      disposed = true;
      clear();
      results.clear();
      attempted.clear();
    }
  };
}

// src/adapters/terminal.ts
function createTerminalAdapter(renderer, reducedMotion = () => false) {
  let painted;
  let original;
  let ghost;
  let status = false;
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
  const paint = (text) => {
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
  };
  return {
    eligible: () => editor()?.plainText === "",
    read: () => editor()?.plainText ?? "",
    paint(text) {
      if (!text && status) return false;
      status = false;
      return paint(text);
    },
    communicate(value) {
      const text = value && communicationText(value, reducedMotion(), process.platform === "darwin" ? "Option+Shift+P" : "Alt+Shift+P");
      if (text) {
        status = true;
        paint(text);
      } else if (status) {
        clear();
        status = false;
      }
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

// src/options.ts
function parseOptions(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, reason: "Plugin options must be an object", warnings: [] };
  const raw = input;
  const fields = ["enabled", "models", "contextFile", "includeGithubPRContext", "timeoutMs", "contextTurns", "automatic", "debug", "escalation"];
  const warnings = Object.keys(raw).filter((key) => !fields.includes(key)).map((key) => `Unknown option ignored: ${key}`);
  const invalid = (reason) => ({ ok: false, reason, warnings });
  const contextFile = raw.contextFile;
  if (contextFile !== void 0 && (typeof contextFile !== "string" || !/^(?:\/|~\/|[A-Za-z]:[\\/]|\\\\)/.test(contextFile) || /[\x00-\x1F\x7F-\x9F]/u.test(contextFile))) return invalid("contextFile must be an absolute path or start with ~/");
  for (const name of ["enabled", "automatic", "debug", "includeGithubPRContext"]) {
    if (raw[name] !== void 0 && typeof raw[name] !== "boolean") return invalid(`${name} must be a boolean`);
  }
  const timeoutMs = raw.timeoutMs ?? 8e3;
  const escalation2 = raw.escalation === void 0 ? "manual" : raw.escalation;
  if (escalation2 !== "off" && escalation2 !== "manual" && escalation2 !== "automatic") return invalid('escalation must be "off", "manual", or "automatic"');
  const contextTurns = raw.contextTurns ?? 3;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) return invalid("timeoutMs must be a positive integer within the timer limit");
  if (typeof contextTurns !== "number" || !Number.isInteger(contextTurns) || contextTurns < 1 || contextTurns > 5) return invalid("contextTurns must be an integer from 1 to 5");
  const models = [];
  if (raw.models !== void 0) {
    const groups = typeof raw.models === "string" ? [raw.models] : raw.models;
    if (!Array.isArray(groups) || !groups.length) return invalid("models must be selector text or a nonempty array of selector groups");
    for (const group of groups) {
      const selectors = typeof group === "string" ? [group] : group;
      if (!Array.isArray(selectors) || !selectors.length || selectors.some((selector) => typeof selector !== "string")) return invalid("each models group must be selector text or a nonempty array of selector text");
      const text = selectors.join(", ");
      for (const entry of text.split(",")) {
        const [selector, variant, extra] = entry.trim().split("#");
        const slash = selector.indexOf("/");
        if (slash <= 0 || !selector.slice(slash + 1).trim() || /\s/.test(selector.slice(0, slash)) || variant === "" || variant !== void 0 && /\s/.test(variant) || extra !== void 0) return invalid("models must contain provider/model-pattern selectors with optional #variant");
      }
      models.push(text.trim());
    }
  }
  return { ok: true, value: { enabled: raw.enabled ?? true, ...raw.models === void 0 ? {} : { models }, ...contextFile === void 0 ? {} : { contextFile }, includeGithubPRContext: raw.includeGithubPRContext ?? false, timeoutMs, contextTurns, automatic: raw.automatic ?? true, debug: raw.debug ?? false, escalation: escalation2 }, warnings };
}

// src/predict.ts
var encoder = new TextEncoder();

// package.json
var package_default = {
  name: "opencode-predictions",
  version: "0.2.0",
  description: "Next-prompt predictions for OpenCode Desktop and CLI",
  type: "module",
  license: "MIT",
  repository: { type: "git", url: "https://github.com/fcoouto/opencode-predictions.git" },
  engines: { node: ">=26.4.0" },
  files: ["dist", "README.md", "readme-demo.svg", "LICENSE"],
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
  dependencies: { "@opencode/plugin": "2.2.6", "@opencode/client": "2.2.6", "jsonc-parser": "3.3.1" },
  devDependencies: {
    "@opentui/core": "0.8.4",
    "@types/node": "26.6.6",
    esbuild: "0.27.0",
    playwright: "1.65.0",
    "solid-js": "1.9.19",
    typescript: "5.9.3",
    vite: "7.3.8",
    "vite-plugin-solid": "2.11.16"
  }
};

// src/feedback.ts
var pluginVersion = package_default.version;
var feedbackRevision = 1;
var configurationNotice = (notice2) => ["models_required", "invalid_options"].includes(notice2.code);
function reasonNotice(reason) {
  if (!reason || ["cancelled", "stale", "escalation_refreshed"].includes(reason)) return;
  const info = {
    disabled: ["Predictions are turned off", "Set enabled to true in this plugin's configuration to request predictions."],
    no_suggestion: ["No suggestion for this response", "Continue typing your next prompt."],
    escalation_unavailable: ["This second opinion is no longer available", "The prediction context or available models changed. Request a fresh prediction."],
    context_unavailable: ["Prediction unavailable for this response.", "Continue typing your next prompt."],
    composer_unavailable: ["The prompt is not ready for a prediction", "Clear the prompt and close menus or pending input, then request a prediction."],
    location_unavailable: ["No prediction location selected", "Open a project or session, then open Prediction status and preview again."]
  };
  if (info[reason]) return { code: reason, severity: "info", title: info[reason][0], message: info[reason][1] };
  if (reason === "models_required") return { code: reason, severity: "error", title: "Predictions need a model", message: "Open Predictions Setup to choose a model, or set models to a provider/model selector in this plugin's OpenCode configuration.", persistent: true };
  if (reason === "model_unavailable") return { code: reason, severity: "error", title: "No prediction models match", message: "Check the provider, model pattern, and requested variant in Prediction status and preview. No model was called.", persistent: true };
  if (reason === "context_file_unavailable") return { code: reason, severity: "error", title: "Prediction context file could not be read", message: "Check contextFile in the global plugin options and ensure the file is readable on the OpenCode server, then request a prediction again. No model was called." };
  if (reason === "context_file_too_large") return { code: reason, severity: "error", title: "Prediction context file is too large", message: "Reduce the contextFile contents to at most 8192 UTF-8 bytes, then request a prediction again. No model was called." };
  if (reason === "context_file_invalid") return { code: reason, severity: "error", title: "Prediction context file is not valid text", message: "Save contextFile as UTF-8 text without binary control characters, then request a prediction again. No model was called." };
  if (reason === "wrong_location") return { code: reason, severity: "error", title: "Prediction location changed", message: "Open the intended project and request a prediction again." };
  if (reason === "timeout") return { code: reason, severity: "error", title: "Prediction timed out", message: "The prediction did not finish within the configured timeout. Check model availability in Prediction status and preview before requesting again." };
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
    const validation = /^(Plugin options|enabled|automatic|debug|includeGithubPRContext|escalation|timeoutMs|contextTurns|contextFile|models|each models group) must /.test(status.reason) ? status.reason : "The service rejected these settings.";
    return { code: "invalid_options", severity: "error", title: "Prediction settings are invalid", message: `${validation}. Open Predictions Setup or correct this plugin's options in your OpenCode configuration.`, persistent: true };
  }
  if (status.warnings.length) return { code: "options_warning", severity: "warning", title: "Some prediction settings were ignored", message: `${status.warnings.join(". ")}. Remove or correct these options in your OpenCode configuration.` };
}
function formatStatus(status, details) {
  const notice2 = status?.reason === "disabled" ? reasonNotice("disabled") : details.currentNotice ?? (status && (statusNotice(status) ?? (!status.enabled ? reasonNotice("disabled") : void 0)));
  const lines = ["Prediction status snapshot \u2014 reopen to refresh.", "", `State: ${notice2?.title ?? (status ? "Ready" : "Unavailable")}`];
  if (notice2) lines.push(notice2.message);
  if (status) {
    lines.push("", `Mode: ${status.automatic ? "Automatic" : "Manual only"}`, `Models: ${status.models ?? "Not configured"}`);
    if (status.contextFile) lines.push(`Context file: ${status.contextFile}`);
    lines.push(`Prediction escalation: ${status.escalation === "automatic" ? "Automatic \u2014 at most one abstention-triggered transition; errors continue through untried models and may consume paid provider quota." : status.escalation === "manual" ? "Manual \u2014 Alt+Shift+P tries an untried model using its provider's quota; errors fall back automatically." : "Off"}`);
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
    `GitHub PR context: ${status?.includeGithubPRContext ?? false}`,
    `Debug: ${status?.debug ?? "Unknown"}`,
    ...Object.entries(details.diagnostics ?? {}).map(([key, value]) => `${key}: ${String(value)}`)
  ];
  if (status && status.feedbackRevision !== feedbackRevision) technical.push("Feedback capabilities differ or are unknown. Check the installed client and server plugin versions to confirm compatibility.");
  return { summary: lines.join("\n"), details: technical.join("\n") };
}

// src/github-prompt.ts
var encoder2 = new TextEncoder();

// src/service.ts
async function abortable(work, signal) {
  signal.throwIfAborted();
  let onAbort = () => {
  };
  try {
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([work(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

// src/log.ts
var prefix = "[opencode-predictions]";
function log(show, message) {
  show(message.startsWith(prefix) ? message : `${prefix} ${message}`);
}

// src/client.ts
function startClient(host) {
  const suppressed = new Set(host.memory?.[0].suppressed);
  const versions = /* @__PURE__ */ new Map();
  let lastCompletion;
  if (host.memory?.[0].mounted && host.memory[0].current) suppressed.add(host.memory[0].current);
  host.memory?.[1]((draft) => {
    draft.mounted = true;
    draft.suppressed = [...suppressed];
  });
  const completionKey = () => {
    const location = host.scope(), state = host.state();
    return location && state ? JSON.stringify([location, state.key]) : void 0;
  };
  const suppress = () => {
    const key = completionKey() ?? lastCompletion;
    if (!key) return;
    suppressed.add(key);
    if (suppressed.size > 128) suppressed.delete(suppressed.values().next().value);
    host.memory?.[1]((draft) => {
      draft.suppressed = [...suppressed];
    });
  };
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
  let communication;
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
      lastCompletion = void 0;
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
    if (current) {
      lastCompletion = completionKey();
      if (host.memory && host.memory[0].current !== lastCompletion) host.memory[1]((draft) => {
        draft.current = lastCompletion;
      });
    }
    if (manual && (manual.key && manual.key !== current?.key || manual.draft !== (current?.draft ?? "") || manual.epoch !== epoch)) manual = void 0;
  };
  const controller = createController({
    paint: host.paint,
    insert: host.insert,
    communicate: (value) => {
      communication = value;
      const key = current?.key;
      const location = scope;
      const generation = epoch;
      host.communicate?.(value, () => {
        if (disposed || generation !== epoch || host.scope() !== location || host.state()?.key !== key || host.state()?.draft || !value?.offer || communication?.offer?.token !== value.offer.token || communication.pending) return;
        request();
      });
    },
    predict: async (signal, escalation2) => {
      const state = current;
      const location = scope;
      const generation = epoch;
      const version = cache?.version;
      const explicit = requestingManual;
      let final;
      const modern = cache?.feedbackRevision === feedbackRevision;
      const debug = !!cache?.debug;
      const legacyProgress = [];
      const progress = (message) => log((text) => host.show({ code: "progress", severity: "info", title: "Prompt predictions", message: text }), message);
      const live = () => !disposed && !signal.aborted && epoch === generation && host.scope() === location && host.state()?.key === state.key && !host.state()?.draft;
      const flight = { signal, scope: location, epoch: generation, explicit };
      const deadline2 = new AbortController();
      let timer;
      const renew = () => {
        clearTimeout(timer);
        timer = setTimeout(() => deadline2.abort(), (cache?.timeoutMs ?? 8e3) * 2);
      };
      renew();
      const requestSignal = AbortSignal.any([signal, deadline2.signal]);
      predicting = flight;
      try {
        let reply;
        try {
          reply = await abortable(() => host.predict(state, crypto.randomUUID(), requestSignal, (message, notice3, modelName) => {
            if (predicting !== flight || !live() || requestSignal.aborted) return;
            if (modelName) {
              renew();
              controller.progress(modelName);
              return;
            }
            if (notice3) {
              final = notice3;
              return;
            }
            if (modern) progress(message);
            else if (debug) {
              legacyProgress.push(message);
              if (legacyProgress.length > 32) legacyProgress.shift();
            }
          }, explicit, escalation2), requestSignal);
        } catch {
          const reason = deadline2.signal.aborted && !signal.aborted ? "timeout" : "service_unavailable";
          reply = { reason, notice: reasonNotice(reason) };
        }
        if (!live()) {
          if (!signal.aborted) {
            const latest = host.state();
            if (host.scope() === location && latest?.key === state.key && latest.draft) controller.update({ key: JSON.stringify([location, state.key, version]), eligible: false, draft: latest.draft });
            else {
              sync();
              controller.update({ eligible: false, draft: "" });
            }
          }
          return { reason: "stale" };
        }
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
        } else if (notice2 && explicit && !(["no_suggestion", "escalation_refreshed"].includes(reply.reason ?? "") && cache?.escalation && cache.escalation !== "off" && host.communicate)) announce(notice2, true);
        if (cache?.escalation && cache.escalation !== "off") {
          const refreshed = reply.reason === "escalation_refreshed" || escalation2 === "refresh";
          const abstained = reply.reason === "no_suggestion" && !refreshed;
          const message = reply.text || controller.preview() || refreshed || ["stale", "cancelled"].includes(reply.reason ?? "") ? "" : abstained ? reply.modelName ? `[${reply.modelName}] provided no prediction.` : "No prediction." : notice2 ? `${notice2.title}
${["generation_failed", "context_unavailable"].includes(reply.reason ?? "") ? notice2.message : "Open Prediction status and preview for recovery."}` : "";
          return { ...reply, communication: { message, offer: reply.text || abstained || refreshed ? reply.escalation : void 0 } };
        }
        return reply;
      } finally {
        clearTimeout(timer);
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
    const deadline2 = AbortSignal.timeout(cache?.timeoutMs ?? 8e3);
    const signal = AbortSignal.any([abort.signal, deadline2]);
    const live = () => !disposed && !abort.signal.aborted && epoch === generation && host.scope() === location;
    const request2 = { abort, done: Promise.resolve() };
    loading = request2;
    const done = (async () => {
      try {
        const value = await abortable(() => host.status(signal), signal);
        if (live()) {
          if (versions.has(location) && versions.get(location) !== value.version) {
            suppress();
            manual = void 0;
            controller.invalidate();
          }
          versions.set(location, value.version);
          cache = value;
          checked = Date.now();
          const recoveredModels = record().requestFailure === inspectedFailure && !!value.candidates?.some((model) => model.state === "ready");
          health(statusNotice(value), recoveredModels);
        }
      } catch {
        if (live()) {
          checked = Date.now();
          if (deadline2.aborted) {
            manual = void 0;
            controller.stage(void 0);
            health(reasonNotice("timeout"));
          } else {
            cache = void 0;
            health(reasonNotice("service_unavailable"));
          }
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
    controller.update({ key: current && cache ? JSON.stringify([scope, current.key, cache.version]) : void 0, eligible: !!current?.eligible && !!cache?.enabled, draft: current?.draft ?? "" });
    controller.stage(manual?.activity);
    if (manual && !loading) {
      const action = manual;
      manual = void 0;
      if (action.version && action.version !== cache?.version) {
        controller.stage(void 0);
        return;
      }
      const issue = record().health?.severity === "error" ? record().health : !cache ? reasonNotice("service_unavailable") : !cache.enabled ? reasonNotice("disabled") : !current ? reasonNotice("context_unavailable") : current.draft || !current.eligible ? reasonNotice("composer_unavailable") : void 0;
      if (issue) {
        controller.stage(void 0);
        announce(issue, true);
        return;
      }
      if (activePrediction()) {
        controller.stage(void 0);
        return;
      }
      requestingManual = true;
      void controller.request(true, action.escalation ?? null, !!cache?.escalation && cache.escalation !== "off");
      requestingManual = false;
    } else if (!manual && available && current?.eligible && current.automaticEligible !== false && !current.draft && cache?.automatic && !suppressed.has(completionKey())) void controller.request();
  };
  const request = (fromShortcut = false) => {
    if (disposed) return;
    sync();
    if (manual || activePrediction()) return;
    if (!scope) {
      announce(reasonNotice("location_unavailable"), true);
      return;
    }
    const offer = communication?.offer;
    manual = { scope, key: host.state()?.key, fromShortcut, draft: host.state()?.draft ?? "", epoch, version: cache?.version, escalation: offer?.token, activity: offer ? { kind: "alternative", name: offer.name } : { kind: "initial" } };
    controller.stage(manual.activity);
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
    invalidate(options) {
      if (disposed) return;
      if (options?.suppressAutomatic) suppress();
      epoch++;
      manual = void 0;
      loading?.abort.abort();
      loading = void 0;
      cache = void 0;
      checked = -Infinity;
      if (options?.suppressAutomatic) controller.invalidate();
      else controller.update({ eligible: false, draft: "" });
      tick();
    },
    dispose() {
      suppress();
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
var escalation = {
  type: "object",
  properties: {
    token: { type: "string", minLength: 1 },
    group: { type: "integer", minimum: 1 },
    name: { type: "string" },
    model: { type: "object", properties: { providerID: { type: "string" }, id: { type: "string" }, variant: { type: "string" } }, required: ["providerID", "id"], additionalProperties: false }
  },
  required: ["token", "group", "name", "model"],
  additionalProperties: false
};
var settingsFields = {
  type: "object",
  properties: { models: {}, enabled: {}, automatic: {}, escalation: {}, timeoutMs: {}, contextTurns: {}, debug: {}, includeGithubPRContext: {} },
  additionalProperties: false
};
var setupIssue = {
  type: "object",
  properties: {
    field: { type: "string", enum: ["models", "enabled", "automatic", "escalation", "timeoutMs", "contextTurns", "debug", "includeGithubPRContext"] },
    group: { type: "integer", minimum: 0 },
    entry: { type: "integer", minimum: 0 },
    severity: { type: "string", enum: ["error", "warning"] },
    code: { type: "string" },
    message: { type: "string" }
  },
  required: ["field", "severity", "code", "message"],
  additionalProperties: false
};
var candidate = {
  type: "object",
  properties: { providerID: { type: "string" }, id: { type: "string" }, name: { type: "string" }, variant: { type: "string" } },
  required: ["providerID", "id", "name"],
  additionalProperties: false
};
var catalogModel = {
  type: "object",
  properties: {
    providerID: { type: "string" },
    id: { type: "string" },
    name: { type: "string" },
    enabled: { type: "boolean" },
    variants: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } }
  },
  required: ["providerID", "id", "enabled", "variants"],
  additionalProperties: false
};
var effectiveOptions = {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
    automatic: { type: "boolean" },
    debug: { type: "boolean" },
    includeGithubPRContext: { type: "boolean" },
    contextFile: { type: "string" },
    escalation: { type: "string", enum: ["off", "manual", "automatic"] },
    timeoutMs: { type: "integer", minimum: 1, maximum: 2147483647 },
    contextTurns: { type: "integer", minimum: 1, maximum: 5 },
    models: { type: "array", items: { type: "string" } }
  },
  required: ["enabled", "automatic", "debug", "includeGithubPRContext", "escalation", "timeoutMs", "contextTurns"],
  additionalProperties: false
};
var Predictions = Rpc.define({
  id: "fcoouto.predictions",
  methods: {
    predict: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string", minLength: 5 }, completion: { type: "number", minimum: 0 }, requestID: { type: "string", minLength: 1 }, manual: { type: "boolean" }, escalation: { type: "string", minLength: 1 } },
        required: ["sessionID", "completion", "requestID"],
        additionalProperties: false
      },
      output: { type: "object", properties: { text: { type: "string" }, reason: { type: "string" }, modelName: { type: "string" }, notice, escalation }, additionalProperties: false }
    },
    status: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object" }
    },
    settings: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          revision: { type: "string" },
          source: { type: "string" },
          scope: { type: "string", enum: ["global"] },
          writable: { type: "boolean" },
          reason: { type: "string" },
          fields: settingsFields,
          localAuthority: { type: "object", properties: { id: { type: "string", minLength: 16, maxLength: 16 } }, required: ["id"], additionalProperties: false },
          effective: { anyOf: [{ type: "null" }, effectiveOptions] },
          catalog: { type: "array", items: catalogModel },
          issues: { type: "array", items: setupIssue },
          serviceVersion: { type: "string" }
        },
        required: ["revision", "scope", "writable", "fields", "effective", "catalog", "issues", "serviceVersion"],
        additionalProperties: false
      }
    },
    previewSettings: {
      // Preserve unknown nested keys so server validation can reject them instead of decoder stripping.
      input: { type: "object", properties: { fields: { ...settingsFields, additionalProperties: true } }, required: ["fields"], additionalProperties: false },
      output: {
        type: "object",
        properties: {
          groups: { type: "array", items: { type: "object", properties: { selectors: { type: "array", items: { type: "string" } }, candidates: { type: "array", items: candidate } }, required: ["selectors", "candidates"], additionalProperties: false } },
          issues: { type: "array", items: setupIssue }
        },
        required: ["groups", "issues"],
        additionalProperties: false
      }
    }
  },
  events: {
    progress: {
      schema: { type: "object", properties: { requestID: { type: "string" }, sessionID: { type: "string" }, message: { type: "string" }, modelName: { type: "string" }, notice }, required: ["requestID", "sessionID", "message"], additionalProperties: false }
    }
  }
});

// src/setup-origin.ts
import { execFile } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import { promisify } from "node:util";
var OriginRefusal = class extends Error {
  constructor() {
    super("This target is not verified for local setup.");
  }
};
function refuse(lifetime) {
  const error = new OriginRefusal();
  lifetime.abort(error);
  throw error;
}
function ambiguous(lifetime) {
  const error = new Error("Local setup is unavailable.");
  lifetime.abort(error);
  throw error;
}
function standaloneArguments(argv) {
  const seen = /* @__PURE__ */ new Set();
  let directory = false;
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index] === "-c" ? "--continue" : argv[index] === "-s" ? "--session" : argv[index];
    if (["--standalone", "--continue", "--auto", "--print-logs", "--session", "--prompt", "--log-level"].includes(arg)) {
      if (seen.has(arg)) return false;
      seen.add(arg);
      if (["--session", "--prompt", "--log-level"].includes(arg)) {
        const value = argv[++index];
        if (!value || value.startsWith("-")) return false;
      }
    } else {
      if (directory || !(isAbsolute(arg) || arg === "." || arg === ".." || arg.startsWith("./") || arg.startsWith("../"))) return false;
      directory = true;
    }
  }
  return seen.has("--standalone");
}
var routingEnvironment = [
  "OPENCODE_SERVER",
  "OPENCODE_SERVER_URL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "NODE_OPTIONS",
  "BUN_OPTIONS",
  "BUN_BE_BUN",
  "OPENCODE_DRIVE"
];
function nativeRuntime() {
  const run = promisify(execFile);
  return {
    platform: process.platform,
    pid: process.pid,
    uid: process.getuid?.() ?? -1,
    executable: process.execPath,
    get argv() {
      return process.argv;
    },
    get env() {
      return process.env;
    },
    async inspect(pid, signal) {
      const { stdout } = await run("/bin/ps", ["-p", String(pid), "-o", "ppid=,uid=,lstart=,args="], {
        signal,
        timeout: 1e3,
        maxBuffer: 8192,
        env: { LC_ALL: "C" }
      });
      const fields = stdout.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)\s*$/);
      return fields ? { parent: Number(fields[1]), uid: Number(fields[2]), started: fields[3].replace(/\s+/g, " "), command: fields[4].trim() } : void 0;
    }
  };
}
function createStandaloneSetupOrigin(host, runtime = nativeRuntime()) {
  const lifetime = new AbortController();
  const client = host.client;
  const argv = JSON.stringify(runtime.argv);
  const executable = runtime.executable, pid = runtime.pid, uid = runtime.uid;
  let anchor;
  const qualified = () => host.app.version === "2.2.6" && host.client === client && runtime.platform === "darwin" && runtime.pid === pid && runtime.uid === uid && uid >= 0 && runtime.executable === executable && isAbsolute(executable) && basename(executable) === "opencode" && JSON.stringify(runtime.argv) === argv && standaloneArguments(runtime.argv) && !routingEnvironment.some((key) => !!runtime.env[key]);
  return {
    async dispatch(signal, local) {
      signal = AbortSignal.any([signal, lifetime.signal]);
      signal.throwIfAborted();
      let serverPid;
      try {
        if (!qualified()) refuse(lifetime);
        const verification = AbortSignal.any([signal, AbortSignal.timeout(2e3)]);
        const info = await abortable(() => client.server.info({ signal: verification }), verification);
        if (info.version !== "2.2.6" || !Number.isSafeInteger(info.pid) || info.pid <= 0 || info.pid === pid) refuse(lifetime);
        if (anchor && anchor.pid !== info.pid) refuse(lifetime);
        const process2 = await abortable(() => runtime.inspect(info.pid, verification), verification);
        verification.throwIfAborted();
        if (!process2 || process2.parent !== pid || process2.uid !== uid || process2.command !== executable + " serve --stdio --port 0" || !process2.started) refuse(lifetime);
        if (anchor && anchor.started !== process2.started) refuse(lifetime);
        if (!qualified()) refuse(lifetime);
        anchor ??= { pid: info.pid, started: process2.started };
        serverPid = info.pid;
      } catch {
        signal.throwIfAborted();
        refuse(lifetime);
      }
      const value = await abortable(() => local({ serverPid }, signal), signal);
      signal.throwIfAborted();
      if (!qualified()) ambiguous(lifetime);
      return value;
    },
    dispose() {
      lifetime.abort();
    },
    revoked: () => lifetime.signal.aborted
  };
}

// src/setup-native-api.ts
import { isDeepStrictEqual } from "node:util";

// src/setup-local.ts
import { chmod, lstat, mkdir, realpath, rmdir, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, isAbsolute as isAbsolute2 } from "node:path";

// src/setup.ts
var settingKeys = ["models", "enabled", "automatic", "escalation", "timeoutMs", "contextTurns", "debug", "includeGithubPRContext"];
async function waitForSetupSnapshot(read, signal) {
  const waiting = AbortSignal.any([signal, AbortSignal.timeout(2e3)]);
  for (; ; ) {
    try {
      return await abortable(() => read(waiting), waiting);
    } catch (error) {
      waiting.throwIfAborted();
      if (!error || typeof error !== "object" || !("type" in error) || error.type !== "rpc.unavailable") throw error;
      await abortable(() => new Promise((resolve) => setTimeout(resolve, 100)), waiting);
    }
  }
}
function validateSettings(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("Settings must be an object.");
  if (Object.keys(fields).some((key) => !settingKeys.includes(key))) throw new Error("Unknown setting.");
  for (const field of ["timeoutMs", "contextTurns"]) {
    if (fields[field] === null) return [{ field, severity: "error", code: "invalid_value", message: "Enter a whole number." }];
  }
  const parsed = parseOptions(fields);
  return parsed.ok ? [] : [{ field: settingKeys.find((key) => parsed.reason.startsWith(key)) ?? "models", severity: "error", code: "invalid_value", message: parsed.reason }];
}
function createSetupEditor(api, changed) {
  const state = { fields: {}, issues: [], dirty: false, loading: false, previewing: false, saving: false };
  const lifetime = new AbortController();
  let generation = 0, previewAbort, blocked = false;
  const notify = () => {
    if (!lifetime.signal.aborted) changed();
  };
  const resetPreview = () => {
    generation++;
    previewAbort?.abort();
    state.preview = void 0;
    state.previewing = false;
  };
  const groups = () => {
    try {
      state.groups = readGroups(state.fields);
    } catch {
      state.groups = void 0;
    }
  };
  const update = () => {
    state.issues = validateSettings(state.fields);
    state.dirty = !!state.snapshot && Object.keys(changedFields(state.snapshot.fields, state.fields)).length > 0;
    groups();
    notify();
  };
  const adopt = (snapshot) => {
    state.snapshot = structuredClone(snapshot);
    state.fields = structuredClone(snapshot.fields);
    state.issues = [...snapshot.issues];
    state.dirty = false;
    groups();
  };
  const readback = async () => {
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(3e3)]);
    for (; ; ) {
      try {
        return await abortable(() => api.read(signal), signal);
      } catch {
        signal.throwIfAborted();
        await abortable(() => new Promise((resolve) => setTimeout(resolve, 100)), signal);
      }
    }
  };
  return {
    state: () => state,
    async load() {
      if (lifetime.signal.aborted || state.saving) return;
      resetPreview();
      const revision = generation;
      state.loading = true;
      state.error = void 0;
      notify();
      try {
        const snapshot = await abortable(() => api.read(lifetime.signal), lifetime.signal);
        if (revision !== generation || lifetime.signal.aborted) return;
        adopt(snapshot);
        blocked = false;
        state.lastSave = void 0;
      } catch {
        if (revision === generation && !lifetime.signal.aborted) state.error = "Settings are unavailable. Reopen settings to try again.";
      } finally {
        if (revision === generation) {
          state.loading = false;
          notify();
        }
      }
    },
    change(fields) {
      if (lifetime.signal.aborted || state.loading || state.saving || !state.snapshot) return;
      validateSettings(fields);
      resetPreview();
      state.fields = { ...state.fields, ...structuredClone(fields) };
      state.lastSave = void 0;
      update();
    },
    setGroups(value) {
      this.change(patchGroups(value));
    },
    async preview() {
      if (lifetime.signal.aborted || state.saving || !state.snapshot) return;
      resetPreview();
      const revision = generation;
      const abort = new AbortController();
      previewAbort = abort;
      const signal = AbortSignal.any([abort.signal, lifetime.signal]);
      state.previewing = true;
      state.error = void 0;
      notify();
      try {
        const result = await abortable(() => api.preview(structuredClone(state.fields), signal), signal);
        if (revision !== generation || signal.aborted) return;
        state.preview = result;
        state.issues = result.issues;
      } catch {
        if (revision === generation && !signal.aborted) state.error = "Model preview is unavailable.";
      } finally {
        if (revision === generation) {
          state.previewing = false;
          notify();
        }
      }
    },
    async save() {
      const failed = (message) => ({ kind: "failed", message });
      if (lifetime.signal.aborted || state.loading || state.saving || !state.snapshot) return failed("Settings are unavailable.");
      if (blocked) return state.lastSave ?? failed("Reload settings before trying again.");
      const issues = validateSettings(state.fields);
      if (issues.length) {
        state.issues = issues;
        notify();
        return { kind: "invalid", issues };
      }
      if (!state.dirty) return failed("No changes to save.");
      if (!state.snapshot.writable) return { kind: "read_only", message: state.snapshot.reason ?? "This configuration is read-only." };
      resetPreview();
      const before = state.snapshot;
      const expected = structuredClone(state.fields);
      const patch = changedFields(before.fields, expected);
      const removeModels = Object.hasOwn(patch, "models") && patch.models === void 0;
      if (removeModels) delete patch.models;
      state.saving = true;
      state.error = void 0;
      notify();
      let result;
      try {
        try {
          result = await abortable(() => api.save({ revision: before.revision, fields: patch, ...removeModels ? { removeModels: true } : {} }, lifetime.signal), lifetime.signal);
        } catch {
        }
        if (lifetime.signal.aborted) return failed("Settings editor closed.");
        if (!result || result.kind === "saved" || result.kind === "saved_not_active" || result.kind === "failed") {
          try {
            const fresh = await readback();
            lifetime.signal.throwIfAborted();
            const fieldsMatch = settingKeys.every((key) => JSON.stringify(fresh.fields[key]) === JSON.stringify(expected[key]));
            if (fresh.source === before.source && fresh.revision !== before.revision && fieldsMatch) {
              const parsed = parseOptions(expected);
              const active = parsed.ok && !!fresh.effective && settingKeys.every((key) => JSON.stringify(fresh.effective[key]) === JSON.stringify(parsed.value[key])) && fresh.serviceVersion !== before.serviceVersion;
              result = active ? { kind: "saved", revision: fresh.revision, serviceVersion: fresh.serviceVersion } : { kind: "saved_not_active", revision: fresh.revision, message: "Saved on disk. Effective activation is not verified." };
              adopt(fresh);
            }
          } catch {
          }
        }
        if (lifetime.signal.aborted) return failed("Settings editor closed.");
        result ??= failed("Changes may have been saved. Reopen settings before trying again.");
        if (result.kind === "saved" || result.kind === "saved_not_active") {
          if (state.dirty) {
            state.snapshot = { ...before, fields: expected, revision: result.revision };
            state.dirty = false;
          }
        } else if (result.kind !== "invalid") blocked = true;
        state.lastSave = result;
        if (result.kind === "invalid") state.issues = result.issues;
        return result;
      } finally {
        if (!lifetime.signal.aborted) {
          state.saving = false;
          notify();
        }
      }
    },
    discard() {
      if (!lifetime.signal.aborted && !state.saving && state.snapshot) {
        resetPreview();
        adopt(state.snapshot);
        notify();
      }
    },
    dispose() {
      lifetime.abort();
      previewAbort?.abort();
      generation++;
      api.dispose?.();
    }
  };
}
function readGroups(fields) {
  if (fields.models === void 0) return void 0;
  const parsed = parseOptions({ models: fields.models });
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.value.models.map((group) => group.split(",").map((entry) => entry.trim()));
}
function patchGroups(groups) {
  return { models: groups?.length ? groups.map((group) => [...group]) : void 0 };
}
function changedFields(original, draft) {
  return Object.fromEntries(settingKeys.filter((key) => Object.hasOwn(draft, key) && JSON.stringify(original[key]) !== JSON.stringify(draft[key])).map((key) => [key, draft[key]]));
}

// src/setup-local.ts
var requestLimit = 65536;
var responseLimit = 8388608;
var deadline = 1e4;
var failure = () => new Error("Local setup is unavailable.");
var object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
var keys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
function validSetupLocation(value) {
  return object(value) && keys(value, ["directory", "workspaceID"]) && typeof value.directory === "string" && isAbsolute2(value.directory) && !value.directory.includes("\0") && (value.workspaceID === void 0 || typeof value.workspaceID === "string" && !!value.workspaceID);
}
function validSave(value) {
  if (!object(value) || !keys(value, ["revision", "fields", "removeModels"]) || typeof value.revision !== "string" || !value.revision || value.removeModels !== void 0 && value.removeModels !== true) return false;
  try {
    validateSettings(value.fields);
    return !(value.removeModels && Object.hasOwn(value.fields, "models"));
  } catch {
    return false;
  }
}
async function socketPath(id) {
  if (!/^[0-9a-f]{16}$/.test(id)) throw failure();
  const directory = join(await realpath(tmpdir()), "pp-" + id), path = join(directory, "s");
  if (Buffer.byteLength(path) > 100) throw failure();
  return { directory, path };
}
async function safePath(directory, path) {
  const parent = await lstat(directory), socket = await lstat(path), uid = process.getuid?.();
  if (uid === void 0 || !parent.isDirectory() || parent.uid !== uid || (parent.mode & 4095) !== 448 || !socket.isSocket() || socket.uid !== uid || (socket.mode & 4095) !== 384) throw failure();
}
async function exchange(target, method, input, signal) {
  let socket;
  try {
    signal = AbortSignal.any([signal, AbortSignal.timeout(deadline)]);
    signal.throwIfAborted();
    if (!object(target) || !keys(target, ["id", "serviceVersion", "location", "serverPid"]) || !validSetupLocation(target.location) || typeof target.serviceVersion !== "string" || !target.serviceVersion || !Number.isSafeInteger(target.serverPid) || target.serverPid <= 0 || method === "save" && !validSave(input)) throw failure();
    const request = JSON.stringify({ id: target.id, serviceVersion: target.serviceVersion, serverPid: target.serverPid, location: target.location, method, ...input ? { input } : {} }) + "\n";
    if (Buffer.byteLength(request) > requestLimit) throw failure();
    const { directory, path } = await socketPath(target.id);
    await safePath(directory, path);
    signal.throwIfAborted();
    socket = createConnection({ path, signal });
    const connection = socket;
    const reply = await new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      connection.on("connect", () => connection.end(request));
      connection.on("data", (chunk) => {
        size += chunk.length;
        if (size > responseLimit) {
          reject(failure());
          connection.destroy();
          return;
        }
        chunks.push(chunk);
      });
      connection.on("error", reject);
      connection.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      connection.on("close", () => reject(failure()));
    });
    signal.throwIfAborted();
    if (!reply.endsWith("\n") || reply.indexOf("\n") !== reply.length - 1) throw failure();
    const response = JSON.parse(reply);
    if (!object(response) || !keys(response, ["pid", "value"]) || response.pid !== target.serverPid || !object(response.value)) throw failure();
    return response.value;
  } catch {
    throw failure();
  } finally {
    socket?.destroy();
  }
}
async function readLocalSetup(target, signal) {
  const value = await exchange(target, "read", void 0, signal);
  if (value.serviceVersion !== target.serviceVersion || value.localAuthority?.id !== target.id || typeof value.writable !== "boolean") throw failure();
  return value;
}
async function saveLocalSetup(target, input, signal) {
  const value = await exchange(target, "save", input, signal);
  if (!["saved", "saved_not_active", "invalid", "conflict", "read_only", "failed"].includes(value.kind)) throw failure();
  return value;
}

// src/setup-native-api.ts
function createNativeSetupAPI(network, location, dispatch, dispose, revoked = () => false) {
  const pinned = { ...location };
  let target, source;
  const readonly = () => ({ kind: "read_only", message: "This target is not verified for local setup." });
  return {
    async read(signal) {
      target = void 0;
      const remote = await waitForSetupSnapshot(network.read, signal);
      try {
        if (!validSetupLocation(pinned) || !remote.localAuthority || source !== void 0 && remote.source !== source) throw new Error();
        const local = await dispatch(signal, async (serverPid, signal2) => {
          const candidate2 = { id: remote.localAuthority.id, serviceVersion: remote.serviceVersion, location: pinned, serverPid };
          const value = await readLocalSetup(candidate2, signal2);
          if (value.source !== remote.source || value.revision !== remote.revision || !isDeepStrictEqual(value.fields, remote.fields)) throw new Error();
          target = candidate2;
          return value;
        });
        if (local.writable) source ??= local.source;
        else target = void 0;
        return local;
      } catch {
        target = void 0;
        signal.throwIfAborted();
        return { ...remote, writable: false, reason: remote.reason ?? readonly().message };
      }
    },
    preview: (fields, signal) => network.preview(fields, signal),
    async save(input, signal) {
      if (!target) return readonly();
      const issues = validateSettings(input.fields);
      if (issues.length) return { kind: "invalid", issues };
      const selected = target;
      let remote;
      try {
        remote = await waitForSetupSnapshot(network.read, signal);
      } catch {
        signal.throwIfAborted();
        throw new Error("Local setup is unavailable.");
      }
      if (remote.localAuthority?.id !== selected.id || remote.serviceVersion !== selected.serviceVersion || remote.source !== source) {
        target = void 0;
        return readonly();
      }
      try {
        return await dispatch(signal, (serverPid, signal2) => {
          if (serverPid !== selected.serverPid || target !== selected) throw new OriginRefusal();
          return saveLocalSetup(selected, input, signal2);
        });
      } catch (error) {
        target = void 0;
        if (error instanceof OriginRefusal) return readonly();
        throw new Error("Local setup is unavailable.");
      }
    },
    dispose() {
      target = void 0;
      dispose();
    },
    revoked
  };
}

// src/setup-tui-api.ts
function createTUISetupAPI(ctx, location, runtime) {
  const client = ctx.client, pinned = { ...location };
  const origin = createStandaloneSetupOrigin(ctx, runtime);
  return createNativeSetupAPI({
    read: async (signal) => await client.rpc(Predictions).settings({}, { location: pinned, signal }),
    preview: async (fields, signal) => await client.rpc(Predictions).previewSettings({ fields }, { location: pinned, signal })
  }, pinned, (signal, local) => origin.dispatch(signal, (identity, signal2) => local(identity.serverPid, signal2)), () => origin.dispose(), () => origin.revoked());
}

// src/setup-copy.ts
var setupText = {
  warning: "Avoid editing this configuration file elsewhere while saving. Changes made in another editor during a save can be overwritten, including unrelated settings. Recovery copies may not contain those changes.",
  github: "When enabled, descriptions and metadata from linked public and accessible private GitHub PRs may be sent to every attempted prediction provider, including fallback and paid models.",
  cost: "Models are tried group by group. Entry order sets initial preference; runtime ranking can reorder candidates within a group. Previewing checks model names only and sends no conversation. Predictions use provider quota and may incur charges; a model's name does not mean it is free.",
  escalation: "Errors always fall back to the next model automatically. Escalation only controls what happens when a model gives no suggestion.",
  disabled: "Controls stay editable while predictions are off; changes apply when you turn them on."
};
var setupTUIText = {
  standalone: "Local setup writes currently require a verified opencode --standalone session.",
  scope: "Settings apply to the global OpenCode configuration on the selected server.",
  fuller: "Avoid editing this configuration file elsewhere while saving. Changes made in another editor during a save can be overwritten, including unrelated settings. Recovery copies hold the file as it was just before a save, so they cannot include edits another editor makes during that save, and they may contain credentials. Saves are not conflict-proof."
};

// src/setup-tui.ts
var title = "Predictions Setup";
var escalationNames = { off: "Off", manual: "Manually", automatic: "Automatically once after no suggestion" };
function registerSetupTUI(ctx, openStatus, runtime) {
  const dialog = ctx.ui.dialog;
  let running = false, disposed = false;
  const location = () => {
    const route = ctx.ui.router.current();
    const found = (route.type === "session" ? ctx.data.session.get(route.sessionID)?.location : void 0) ?? ctx.location ?? ctx.data.location.default();
    return found?.directory ? { directory: found.directory } : void 0;
  };
  const alert = (message) => dialog.alert({ title, message });
  async function run() {
    if (running || disposed) return;
    running = true;
    let editor;
    try {
      const target = location();
      if (!target) {
        await alert("Open a project, or connect to an OpenCode server, before changing prediction settings.");
        return;
      }
      editor = createSetupEditor(createTUISetupAPI(ctx, target, runtime), () => {
      });
      await editor.load();
      if (editor.state().error || !editor.state().snapshot) {
        await alert((editor.state().error ?? "Settings are unavailable.") + " If this persists, update the Predictions plugin on this server.");
        return;
      }
      await root(editor);
    } finally {
      editor?.dispose();
      running = false;
    }
  }
  const fields = (editor) => editor.state().fields;
  const flag = (editor, name, fallback) => typeof fields(editor)[name] === "boolean" ? fields(editor)[name] : fallback;
  const groups = (editor) => {
    try {
      return readGroups(fields(editor)) ?? [];
    } catch {
      return [];
    }
  };
  const onOff = (value) => value ? "On" : "Off";
  const readOnly = (editor) => !editor.state().snapshot?.writable;
  const readOnlyReason = (editor) => {
    const snapshot = editor.state().snapshot;
    return snapshot?.localAuthority ? setupTUIText.standalone : snapshot?.reason ?? "This configuration cannot be edited here.";
  };
  async function editable(editor) {
    if (!readOnly(editor)) return true;
    await alert(`Read-only. ${readOnlyReason(editor)} Current values are shown; edit the configuration file manually to change them.`);
    return false;
  }
  const edit = (editor, patch) => {
    try {
      editor.change(patch);
    } catch {
    }
  };
  const modelName = (editor, selector) => {
    const [base] = selector.split("#");
    const model = editor.state().snapshot?.catalog.find((item) => item.providerID + "/" + item.id === base);
    return model ? model.name ?? model.id : void 0;
  };
  const issues = (editor, group2, entry2) => editor.state().issues.filter((issue) => issue.field === "models" && issue.group === group2 && (entry2 === void 0 ? issue.entry === void 0 : issue.entry === entry2)).map((issue) => issue.message);
  const escalationShort = { off: "off", manual: "manual", automatic: "auto" };
  const summary = {
    behavior: (editor) => `${onOff(flag(editor, "enabled", true))} \xB7 After replies ${onOff(flag(editor, "automatic", true)).toLowerCase()} \xB7 ${escalationShort[String(fields(editor).escalation ?? "manual")] ?? "manual"}`,
    models: (editor) => {
      const all = groups(editor);
      return all.length ? `${all.length} ${all.length === 1 ? "group" : "groups"}, ${all.flat().length} ${all.flat().length === 1 ? "entry" : "entries"}` : "No models configured";
    },
    advanced: (editor) => `${fields(editor).timeoutMs ?? 8e3} ms \xB7 ${fields(editor).contextTurns ?? 3} recent \xB7 PR ${onOff(flag(editor, "includeGithubPRContext", false)).toLowerCase()}`
  };
  async function root(editor) {
    for (; ; ) {
      const state = editor.state();
      const invalid = state.issues.some((issue) => issue.severity === "error");
      const choice = await dialog.select({
        title: state.dirty ? `${title} \u2014 unsaved changes` : title,
        placeholder: "Choose a section",
        options: [
          ...readOnly(editor) ? [{ title: "Read-only", description: "Select to see why.", value: "readonly", category: "Settings" }] : [],
          { title: "Behavior", description: summary.behavior(editor), value: "behavior", category: "Settings" },
          { title: "Models", description: summary.models(editor), value: "models", category: "Settings" },
          { title: "Advanced", description: summary.advanced(editor), value: "advanced", category: "Settings" },
          { title: "Save changes", description: invalid ? "Fix invalid settings first." : "Can overwrite other edits.", value: "save", disabled: !state.dirty || readOnly(editor) || invalid || state.saving, category: "Changes" },
          { title: "Discard changes", description: "Restore saved values.", value: "discard", disabled: !state.dirty, category: "Changes" },
          { title: "Prediction status and preview", description: "Diagnostics.", value: "status", category: "More" },
          { title: "About saving", description: "Scope and limits.", value: "about", category: "More" }
        ]
      });
      if (choice === void 0) {
        if (editor.state().dirty && !await dialog.confirm({ title, message: "Discard your unsaved prediction settings?", label: { confirm: "Discard", cancel: "Keep editing" } })) continue;
        return;
      }
      if (choice === "behavior") await behavior(editor);
      else if (choice === "models") await models(editor);
      else if (choice === "advanced") await advanced(editor);
      else if (choice === "save") await save(editor);
      else if (choice === "discard") editor.discard();
      else if (choice === "status") await openStatus();
      else if (choice === "readonly") await alert(`Read-only. ${readOnlyReason(editor)} Current values are shown; edit the configuration file manually to change them.`);
      else if (choice === "about") await alert(`${setupTUIText.scope}

${setupTUIText.fuller}`);
    }
  }
  async function save(editor) {
    const result = await editor.save();
    const message = result.kind === "saved" ? "Saved. The new settings are active." : result.kind === "saved_not_active" ? "Saved on disk, but activation is not verified. Reopen settings to check the active values." : result.kind === "invalid" ? "Fix the invalid settings before saving." : result.message;
    await alert(message);
  }
  async function behavior(editor) {
    for (; ; ) {
      const choice = await dialog.select({
        title: "Behavior",
        options: [
          { title: "Enable Predictions", description: onOff(flag(editor, "enabled", true)) + (flag(editor, "enabled", true) ? "" : " \xB7 edits apply later"), value: "enabled" },
          { title: "Predict After Replies", description: onOff(flag(editor, "automatic", true)) + (flag(editor, "automatic", true) ? "" : " \xB7 request manually"), value: "automatic" },
          { title: "Escalation Mode", description: { off: "Off", manual: "Manual", automatic: "Auto once" }[String(fields(editor).escalation ?? "manual")] ?? "Manual", value: "escalation" },
          { title: "About Behavior", description: "Escalation and fallback.", value: "about" }
        ]
      });
      if (choice === void 0) return;
      if (choice === "about") {
        await alert(setupText.escalation + " " + setupText.disabled);
        continue;
      }
      if (!await editable(editor)) continue;
      if (choice === "enabled" || choice === "automatic") edit(editor, { [choice]: !flag(editor, choice, true) });
      else {
        const next = await dialog.select({ title: "Escalation Mode", current: String(fields(editor).escalation ?? "manual"), options: Object.entries(escalationNames).map(([value, name]) => ({ title: name, value, description: value === "off" ? "No second opinion offered." : void 0 })) });
        if (next !== void 0) edit(editor, { escalation: next });
      }
    }
  }
  const strictNumber = /^[0-9]+$/;
  async function advanced(editor) {
    for (; ; ) {
      const choice = await dialog.select({
        title: "Advanced",
        options: [
          { title: "Timeout per model", description: `${fields(editor).timeoutMs ?? 8e3} ms`, value: "timeout" },
          { title: "Recent interactions", description: `${fields(editor).contextTurns ?? 3} (1 to 5)`, value: "context" },
          { title: "Include GitHub PR context", description: `${onOff(flag(editor, "includeGithubPRContext", false))} \xB7 private data`, value: "github" },
          { title: "Debug notices", description: onOff(flag(editor, "debug", false)), value: "debug" },
          { title: "About Advanced", description: "GitHub data sent.", value: "about" }
        ]
      });
      if (choice === void 0) return;
      if (choice === "about") {
        await alert(setupText.github);
        continue;
      }
      if (!await editable(editor)) continue;
      if (choice === "github" || choice === "debug") edit(editor, { [choice === "github" ? "includeGithubPRContext" : "debug"]: !flag(editor, choice === "github" ? "includeGithubPRContext" : "debug", false) });
      else if (choice === "context") {
        const next = await dialog.select({ title: "Recent interactions", current: String(fields(editor).contextTurns ?? 3), options: ["1", "2", "3", "4", "5"].map((value) => ({ title: value, value })) });
        if (next !== void 0) edit(editor, { contextTurns: Number(next) });
      } else {
        let value = String(fields(editor).timeoutMs ?? 8e3);
        for (; ; ) {
          const answer = await dialog.prompt({ title: "Timeout per model", description: "Milliseconds, a whole number from 1 to 2147483647.", value });
          if (answer === void 0) break;
          value = answer.trim();
          const number = strictNumber.test(value) ? Number(value) : null;
          const problem = number === null ? "Enter a whole number from 1 to 2147483647." : validateSettings({ timeoutMs: number })[0]?.message;
          if (problem) {
            await alert(problem);
            continue;
          }
          edit(editor, { timeoutMs: number });
          break;
        }
      }
    }
  }
  const setGroups = (editor, next) => editor.setGroups(next.filter((group2) => group2.length));
  const swap = (items, from, to) => {
    const copy = [...items];
    [copy[from], copy[to]] = [copy[to], copy[from]];
    return copy;
  };
  async function pickModel(editor) {
    const catalog = editor.state().snapshot?.catalog ?? [];
    if (!catalog.length) {
      await alert("No models are available from this server. Add a model pattern instead, or connect a provider in OpenCode.");
      return void 0;
    }
    const model = await dialog.select({
      title: "Add a model",
      placeholder: "Search by provider or model name",
      options: catalog.map((item) => ({ title: item.name ?? item.id, description: `${item.providerID}/${item.id}${item.enabled ? "" : " \u2014 disabled"}`, value: item, category: item.providerID })),
      search: (query, options) => {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        return options.filter((option) => words.every((word) => (option.title + " " + option.description).toLowerCase().includes(word))).slice(0, 50);
      }
    });
    if (!model) return void 0;
    let variant;
    if (model.variants.length) {
      const chosen = await dialog.select({ title: "Reasoning variant", options: [{ title: "Default reasoning", value: "" }, ...model.variants.map((item) => ({ title: item.id, value: item.id }))] });
      if (chosen === void 0) return void 0;
      variant = chosen || void 0;
    }
    return model.providerID + "/" + model.id + (variant ? "#" + variant : "");
  }
  async function pickPattern(editor) {
    let value = "";
    for (; ; ) {
      const answer = await dialog.prompt({ title: "Add a model pattern", description: "Use provider/model-pattern, such as provider/family-*, with an optional #variant. Patterns stay patterns.", placeholder: "provider/model-*", value });
      if (answer === void 0) return void 0;
      value = answer.trim();
      const problem = !value ? "Enter a provider/model-pattern selector." : validateSettings({ models: [[value]] })[0]?.message;
      if (problem) {
        await alert(problem);
        continue;
      }
      return value;
    }
  }
  async function addTo(editor, destination, pick) {
    if (!await editable(editor)) return;
    const selector = await pick(editor);
    if (!selector) return;
    const next = groups(editor).map((group2) => [...group2]);
    if (destination === "new") next.push([selector]);
    else next[destination].push(selector);
    setGroups(editor, next);
    await editor.preview();
  }
  async function models(editor) {
    await editor.preview();
    for (; ; ) {
      const all = groups(editor);
      const preview = editor.state().preview;
      const options = [
        ...all.map((group2, index) => {
          const count = preview?.groups[index]?.candidates.length;
          return { title: `Group ${index + 1} \u2014 ${index === 0 ? "Try first" : "Fallback"}`, description: `${group2.length} ${group2.length === 1 ? "entry" : "entries"}${count === void 0 ? "" : ` \xB7 ${count} match`}`, value: `group:${index}`, category: "Groups" };
        }),
        { title: all.length ? "Add fallback group (model)" : "Add a model", value: "new-model", category: "Add" },
        { title: all.length ? "Add fallback group (pattern)" : "Add model pattern", value: "new-pattern", category: "Add" },
        { title: "Preview matches", description: "Names only; sends nothing.", value: "preview", category: "More" },
        { title: "About models", description: "Cost, order, fallback.", value: "about", category: "More" }
      ];
      const choice = await dialog.select({ title: "Models", options });
      if (choice === void 0) return;
      if (choice === "new-model") await addTo(editor, "new", pickModel);
      else if (choice === "new-pattern") await addTo(editor, "new", pickPattern);
      else if (choice === "preview") await editor.preview();
      else if (choice === "about") await alert(setupText.cost);
      else await group(editor, Number(choice.slice("group:".length)));
    }
  }
  async function group(editor, index) {
    for (; ; ) {
      const all = groups(editor);
      if (index >= all.length) return;
      const entries = all[index];
      const choice = await dialog.select({
        title: `Group ${index + 1} \u2014 ${index === 0 ? "Try first" : "Fallback"}`,
        options: [
          ...entries.map((selector, position) => ({ title: modelName(editor, selector) ?? selector, description: modelName(editor, selector) ? selector : void 0, value: `entry:${position}`, category: "Entries" })),
          { title: "Add model", value: "add-model", category: "Actions" },
          { title: "Add model pattern", value: "add-pattern", category: "Actions" },
          { title: "Move group up", value: "up", disabled: index === 0, category: "Actions" },
          { title: "Move group down", value: "down", disabled: index === all.length - 1, category: "Actions" },
          { title: "Remove group", description: "Removes the group.", value: "remove", category: "Actions" }
        ]
      });
      if (choice === void 0) return;
      if (choice === "add-model") await addTo(editor, index, pickModel);
      else if (choice === "add-pattern") await addTo(editor, index, pickPattern);
      else if (choice === "remove") {
        if (await editable(editor)) {
          setGroups(editor, all.filter((_, position) => position !== index));
          await editor.preview();
          return;
        }
      } else if (choice === "up" || choice === "down") {
        if (!await editable(editor)) continue;
        const to = choice === "up" ? index - 1 : index + 1;
        setGroups(editor, swap(all, index, to));
        await editor.preview();
        index = to;
      } else await entry(editor, index, Number(choice.slice("entry:".length)));
    }
  }
  async function entry(editor, index, position) {
    const all = groups(editor);
    const selector = all[index]?.[position];
    if (selector === void 0) return;
    const choice = await dialog.select({
      title: modelName(editor, selector) ?? selector,
      options: [
        { title: "Details", description: "Selector and warnings.", value: "details" },
        { title: "Move up", value: "up", disabled: position === 0 },
        { title: "Move down", value: "down", disabled: position === all[index].length - 1 },
        { title: "Remove", description: "Removes it.", value: "remove" }
      ]
    });
    if (choice === "details") {
      await alert([selector, ...issues(editor, index, position)].join("\n"));
      return;
    }
    if (choice === void 0 || !await editable(editor)) return;
    const next = all.map((items) => [...items]);
    if (choice === "remove") next[index].splice(position, 1);
    else next[index] = swap(next[index], position, choice === "up" ? position - 1 : position + 1);
    setGroups(editor, next);
    await editor.preview();
  }
  ctx.keymap.layer(() => ({ priority: 20, commands: [{ id: "predictions.setup", title, group: "Predictions", palette: true, run: () => void run() }] }));
  return () => {
    disposed = true;
  };
}

// src/tui.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
var tui_default = Plugin.define({
  id: "opencode-predictions.tui",
  setup(ctx) {
    let checkedMotion = -Infinity;
    let reducedMotion = true;
    const adapter = createTerminalAdapter(ctx.renderer, () => {
      if (Date.now() - checkedMotion < 2e3) return reducedMotion;
      checkedMotion = Date.now();
      try {
        let settings = {};
        try {
          settings = JSON.parse(readFileSync(join2(process.env.XDG_CONFIG_HOME ?? join2(homedir(), ".config"), "opencode", "cli.json"), "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const inline = JSON.parse(process.env.OPENCODE_CLI_CONFIG_CONTENT ?? "{}");
        const animations = inline.animations ?? settings.animations;
        reducedMotion = animations !== void 0 && animations !== true;
      } catch {
        reducedMotion = true;
      }
      return reducedMotion;
    });
    const session = () => {
      const route = ctx.ui.router.current();
      return route.type === "session" ? ctx.data.session.get(route.sessionID) : void 0;
    };
    const location = () => session()?.location ?? ctx.location ?? ctx.data.location.default();
    const client = startClient({
      memory: ctx.storage?.memory("prediction-lifecycle", { initial: { mounted: false, suppressed: [] } }),
      scope: () => {
        const value = location();
        return value ? JSON.stringify(value) : void 0;
      },
      state: () => {
        const value = session();
        if (!value || value.parentID || ctx.data.session.status(value.id) !== "idle" || value.outcome === "interrupted") return;
        const completion = value.time.idle || value.time.updated;
        if (!completion) return;
        const eligible = adapter.eligible() && !ctx.data.session.pending.list(value.id).length && !ctx.data.session.permission.list(value.id)?.length && !ctx.data.session.form.list(value.id, value.location)?.length;
        return { key: value.id + "/" + value.location.directory + "/" + completion, sessionID: value.id, completion, eligible, draft: adapter.read(), automaticEligible: !!value.time.idle };
      },
      status: async (signal) => await ctx.client.rpc(Predictions).status({}, { location: location(), signal }),
      predict: async (state, requestID, signal, notice2, manual, escalation2) => {
        const value = session();
        if (!value || value.id !== state.sessionID) return { reason: "stale" };
        const rpc = ctx.client.rpc(Predictions);
        const stop = rpc.events.on("progress", (event) => {
          if (event.data.requestID === requestID && event.data.sessionID === state.sessionID) notice2(String(event.data.message), event.data.notice, typeof event.data.modelName === "string" ? event.data.modelName : void 0);
        });
        try {
          return await rpc.predict({ sessionID: state.sessionID, completion: state.completion, requestID, ...manual ? { manual: true } : {}, ...escalation2 ? { escalation: escalation2 } : {} }, { location: value.location, signal });
        } finally {
          stop();
        }
      },
      paint: adapter.paint,
      insert: adapter.insert,
      communicate: adapter.communicate,
      focus: () => ctx.renderer.currentFocusedEditor?.focus(),
      show: (notice2) => {
        ctx.ui.toast.show({ title: notice2.title, message: notice2.message + (notice2.severity !== "info" ? configurationNotice(notice2) ? "\nOpen Predictions Setup from the command palette to fix this." : "\nOpen Prediction status and preview from the command palette for details." : ""), variant: notice2.severity, duration: 8e3 });
      },
      openStatus: async (view) => {
        if (await ctx.ui.dialog.confirm({ title: "Prediction status and preview", message: view.summary + "\n\nTo change settings, run Predictions Setup from the command palette.", label: { confirm: "Technical details", cancel: "Close" } })) await ctx.ui.dialog.alert({ title: "Prediction technical details", message: view.details });
      },
      diagnostics: () => ({ host: "CLI", hostVersion: ctx.app.version, clientVersion: pluginVersion, feedbackRevision, composerEligible: adapter.eligible() })
    });
    ctx.keymap.layer(() => ({ priority: 20, commands: [
      { id: "predictions.accept", bind: "tab", run: () => client.accept() ? void 0 : false },
      { id: "predictions.request", title: "Predict next prompt", group: "Predictions", palette: true, run: () => client.request() },
      { id: "predictions.request-shortcut", title: "Predict next prompt", bind: "alt+shift+p", run: () => client.requestFromShortcut() },
      { id: "predictions.status", title: "Prediction status and preview", group: "Predictions", palette: true, run: () => client.status() }
    ] }));
    const stopSetup = registerSetupTUI(ctx, () => client.status());
    const stopConfig = ctx.data.on("config.updated", () => client.invalidate({ suppressAutomatic: true }));
    const stopPlugin = ctx.data.on("plugin.updated", () => client.invalidate({ suppressAutomatic: true }));
    return () => {
      stopSetup();
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
