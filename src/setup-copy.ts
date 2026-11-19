export const setupText = {
  warning: "Avoid saving prediction preferences from multiple places at once. Simultaneous saves can overwrite each other's changes, including different settings. The recovery copy may not contain those changes.",
  scope: "Settings apply to user prediction preferences on the selected server. They affect all projects using this configuration directory.",
  precedence: "Saved preferences override OpenCode configuration. Use OpenCode configuration removes these overrides after you save.",
  github: "When enabled, descriptions and metadata from linked public and accessible private GitHub PRs may be sent to every attempted prediction provider, including fallback and paid models.",
  order: "Groups run top to bottom. A later group is tried when every model above it fails. With Escalation set to Automatically, another model is also tried once after no suggestion. Within a group, entry order sets the first preference and runtime ranking can reorder it.",
  cost: "Match counts check model names only and send no conversation. Predictions use provider quota and may incur charges; a model's name does not mean it is free.",
  escalation: "Errors always fall back to the next model automatically. Escalation only controls what happens when a model gives no suggestion.",
  disabled: "Controls stay editable while predictions are off; changes apply when you turn them on.",
}
export const setupTUIText = {
  scope: setupText.scope,
  fuller: setupText.precedence + "\n\n" + setupText.warning,
}
export const originLabels = { preferences: "Saved preference", configuration: "OpenCode configuration", default: "Default" } as const
