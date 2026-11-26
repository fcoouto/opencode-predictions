import type { SetupState } from "./setup.ts"

export const setupText = {
  warning: "Avoid saving prediction preferences from multiple places at once. Simultaneous saves can overwrite each other's changes, including different settings. The recovery copy may not contain those changes.",
  scope: "Settings apply to user prediction preferences on the selected server. They affect all projects using this configuration directory.",
  defaults: "Reset to defaults removes saved settings shown here after you save.",
  contextFile: "Standing notes about you and your work, sent to prediction providers with every request. Up to 8 KB of text.",
  // The old-server row keeps this sentence until the server can manage the file.
  contextFileManual: "Set contextFile in predictions.json on the OpenCode server. Its contents go to prediction providers.",
  github: "When enabled, descriptions and metadata from linked public and accessible private GitHub PRs may be sent to every attempted prediction provider, including fallback and paid models.",
  order: "Groups run top to bottom. A later group is tried when every model above it fails. With Escalation set to Automatically, another model is also tried once after no suggestion. Within a group, entry order sets the first preference and runtime ranking can reorder it.",
  cost: "Match counts check model names only and send no conversation. Predictions use provider quota and may incur charges; a model's name does not mean it is free.",
  escalation: "Errors always fall back to the next model automatically. Escalation only controls what happens when a model gives no suggestion.",
  disabled: "Controls stay editable while predictions are off; changes apply when you turn them on.",
}
export const setupTUIText = {
  scope: setupText.scope,
  fuller: setupText.defaults + "\n\n" + setupText.warning,
}
export const originLabels = { preferences: "Saved preference", default: "Default" } as const

// Desktop context file row. contextFileManual above stays the old-server sentence.
const grouped = (count: number) => String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
export const contextFileText = {
  checking: "Checking the context file…",
  unavailable: "Context file status is unavailable right now.",
  unsupported: "Update the Predictions plugin on the server to manage the context file here.",
  // Save adopts an existing file as it is, so this must not promise a new, empty one.
  staged: "Save will use predictions-context.md. If it already exists, its current text will be sent with predictions.",
  stagedOff: "The context file will stop being used when you save. The file stays on disk.",
  empty: "Empty — nothing is sent until you add text.",
  openFailed: "Could not open the file on this computer.",
  okLine: (path: string, bytes: number) => `${path} · ${grouped(bytes)} of 8,192 bytes`,
  // The reason a set file cannot be used, or undefined when it can.
  issue: (state: string, bytes?: number): string | undefined => {
    if (state === "missing") return "Missing"
    if (state === "invalid") return "Not UTF-8 text"
    if (state === "unreadable") return "Cannot be read"
    if (state === "too_large") return bytes === undefined ? "Too large" : `Too large: ${grouped(bytes)} of 8,192 bytes`
    return undefined
  },
  // Names the file manager of the OS this desktop runs on.
  reveal: (os?: string) => os === "macos" ? "Show in Finder" : os === "windows" ? "Show in File Explorer" : "Show in Folder",
}

export const contextFileIssue = (state?: Readonly<SetupState>) =>
  state?.issues.find(issue => issue.field === "contextFile")?.message
  ?? state?.snapshot?.issues.find(issue => issue.field === "contextFile")?.message
