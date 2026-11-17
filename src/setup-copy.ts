export const setupText = {
  warning: "Avoid editing this configuration file elsewhere while saving. Changes made in another editor during a save can be overwritten, including unrelated settings. Recovery copies may not contain those changes.",
  github: "When enabled, descriptions and metadata from linked public and accessible private GitHub PRs may be sent to every attempted prediction provider, including fallback and paid models.",
  order: "Groups run top to bottom. A later group is tried when every model above it fails. With Escalation set to Automatically, another model is also tried once after no suggestion. Within a group, entry order sets the first preference and runtime ranking can reorder it.",
  cost: "Match counts check model names only and send no conversation. Predictions use provider quota and may incur charges; a model's name does not mean it is free.",
  escalation: "Errors always fall back to the next model automatically. Escalation only controls what happens when a model gives no suggestion.",
  disabled: "Controls stay editable while predictions are off; changes apply when you turn them on.",
}
export const setupTUIText = {
  standalone: "Local setup writes currently require a verified opencode --standalone session.",
  scope: "Settings apply to the global OpenCode configuration on the selected server.",
  fuller: "Avoid editing this configuration file elsewhere while saving. Changes made in another editor during a save can be overwritten, including unrelated settings. Recovery copies hold the file as it was just before a save, so they cannot include edits another editor makes during that save, and they may contain credentials. Saves are not conflict-proof.",
}
