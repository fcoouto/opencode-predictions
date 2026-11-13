import metadata from "../package.json" with { type: "json" }
import type { Status } from "./service.ts"

export const pluginVersion = metadata.version
export const feedbackRevision = 1
export type Notice = { code: string; severity: "info" | "warning" | "error"; title: string; message: string; persistent?: boolean }
export type StatusView = { summary: string; details: string }

export function reasonNotice(reason: string | undefined): Notice | undefined {
  if (!reason || ["cancelled", "stale"].includes(reason)) return
  const info: Record<string, [string, string]> = {
    disabled: ["Predictions are turned off", "Set enabled to true in this plugin's configuration to request predictions."],
    no_suggestion: ["No suggestion for this response", "Continue typing your next prompt."],
    escalation_unavailable: ["This second opinion is no longer available", "The prediction context or available models changed. Request a fresh prediction."],
    context_unavailable: ["No completed response to predict from", "Finish an assistant response with usable conversation text, then request a prediction."],
    composer_unavailable: ["The prompt is not ready for a prediction", "Clear the prompt and close menus or pending input, then request a prediction."],
    location_unavailable: ["No prediction location selected", "Open a project or session, then open Prediction status and preview again."],
  }
  if (info[reason]) return { code: reason, severity: "info", title: info[reason][0], message: info[reason][1] }
  if (reason === "models_required") return { code: reason, severity: "error", title: "Predictions need a model", message: "Set models to a provider/model selector in this plugin's OpenCode configuration.", persistent: true }
  if (reason === "model_unavailable") return { code: reason, severity: "error", title: "No prediction models match", message: "Check the provider, model pattern, and requested variant in Prediction status and preview. No model was called.", persistent: true }
  if (reason === "wrong_location") return { code: reason, severity: "error", title: "Prediction location changed", message: "Open the intended project and request a prediction again." }
  if (reason === "timeout") return { code: reason, severity: "error", title: "Prediction timed out", message: "The model did not respond within the configured timeout. Check model availability in Prediction status and preview before requesting again." }
  return { code: "service_unavailable", severity: "error", title: "Prediction service unavailable", message: "Predictions could not complete. Check the OpenCode service connection, then request a prediction again. Open Prediction status and preview for details." }
}

export function statusNotice(status: Status): Notice | undefined {
  if (status.reason === "no_models_eligible") {
    const candidates = status.candidates ?? []
    const retryAt = candidates.filter(model => model.state === "cooling" && Number.isFinite(model.retryAt)).map(model => model.retryAt!)
    const causes = [...new Set(candidates.map(model => model.reason).filter(Boolean))].slice(0, 3).join(" ")
    const recovery = retryAt.length
      ? `Earliest retry eligibility: ${new Date(Math.min(...retryAt)).toISOString()}. A new prediction request can try again afterward.`
      : "Check your provider connection, model access, and configuration. Blocked models remain blocked until the server plugin reloads."
    return { code: "models_unavailable", severity: "error", title: retryAt.length ? "Prediction models are temporarily paused" : "Prediction models are blocked", message: [causes, recovery].filter(Boolean).join(" "), persistent: !retryAt.length }
  }
  if (status.reason && status.reason !== "disabled") {
    if (["models_required", "model_unavailable", "service_unavailable"].includes(status.reason)) return reasonNotice(status.reason)
    // Validation messages describe field types, never the supplied option values.
    const validation = /^(Plugin options|enabled|automatic|debug|escalation|timeoutMs|contextTurns|models|each models group) must /.test(status.reason) ? status.reason : "The service rejected these settings."
    return { code: "invalid_options", severity: "error", title: "Prediction settings are invalid", message: `${validation}. Correct this plugin's options in your OpenCode configuration.`, persistent: true }
  }
  if (status.warnings.length) return { code: "options_warning", severity: "warning", title: "Some prediction settings were ignored", message: `${status.warnings.join(". ")}. Remove or correct these options in your OpenCode configuration.` }
}

export function formatStatus(status: Status | undefined, details: { lastNotice?: Notice; suggestion?: string; diagnostics?: Record<string, unknown>; currentNotice?: Notice }): StatusView {
  const notice = status?.reason === "disabled" ? reasonNotice("disabled") : details.currentNotice ?? (status && (statusNotice(status) ?? (!status.enabled ? reasonNotice("disabled") : undefined)))
  const lines = ["Prediction status snapshot — reopen to refresh.", "", `State: ${notice?.title ?? (status ? "Ready" : "Unavailable")}`]
  if (notice) lines.push(notice.message)
  if (status) {
    lines.push("", `Mode: ${status.automatic ? "Automatic" : "Manual only"}`, `Models: ${status.models ?? "Not configured"}`)
    lines.push(`Prediction escalation: ${status.escalation === "automatic" ? "Automatic — at most one additional model call after abstention; may consume paid provider quota." : status.escalation === "manual" ? "Manual — Alt+Shift+P tries an untried model using its provider's quota." : "Off"}`)
    const groups = status.groups ?? (status.candidates ? [{ selectors: status.models ?? "", candidates: status.candidates }] : [])
    for (const [index, group] of groups.entries()) {
      lines.push(`Group ${index + 1}: ${group.selectors}`)
      if (!group.candidates.length) lines.push("  No matching models.")
      for (const model of group.candidates) lines.push(`  ${model.providerID}/${model.id}${model.variant ? "#" + model.variant : ""}: ${model.state}${model.reason ? " — " + model.reason : ""}${model.retryAt ? " Eligible after " + new Date(model.retryAt).toISOString() : ""}`)
    }
    if (status.warnings.length) lines.push("", "Settings warnings:", ...status.warnings)
  }
  if (details.lastNotice) {
    lines.push("", `Last failure: ${details.lastNotice.title}`)
    if (details.lastNotice.message !== notice?.message) lines.push(details.lastNotice.message)
  }
  if (details.suggestion) lines.push("", "Current suggestion:", details.suggestion)
  const technical = [
    `Service plugin: ${status?.pluginVersion ?? "unknown (legacy metadata)"}`,
    `Service feedback revision: ${status?.feedbackRevision ?? "unknown (legacy metadata)"}`,
    `Last outcome: ${status?.lastOutcome ?? "None"}`,
    `Last latency: ${status?.lastLatencyMs === undefined ? "Unknown" : status.lastLatencyMs + " ms"}`,
    `Timeout: ${status?.timeoutMs ?? "Unknown"} ms`,
    `Context turns: ${status?.contextTurns ?? "Unknown"}`,
    `Debug: ${status?.debug ?? "Unknown"}`,
    ...Object.entries(details.diagnostics ?? {}).map(([key, value]) => `${key}: ${String(value)}`),
  ]
  if (status && status.feedbackRevision !== feedbackRevision) technical.push("Feedback capabilities differ or are unknown. Check the installed client and server plugin versions to confirm compatibility.")
  return { summary: lines.join("\n"), details: technical.join("\n") }
}
