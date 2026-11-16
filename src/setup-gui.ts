import { Command, SettingsPage } from "@opencode/plugin/gui"
import type { Plugin as GUIPlugin } from "@opencode/plugin/gui"
import { Index, Show, createComponent, createRenderEffect, createSignal } from "solid-js"
import { insert } from "solid-js/web"
import { createGUISetupAPI } from "./setup-gui-api.ts"
import { setupText } from "./setup-copy.ts"
import { createSetupEditor, readGroups, validateSettings, type SetupEditor, type SetupSnapshot } from "./setup.ts"

type GUIContext = Parameters<GUIPlugin.Setup>[0]
type UiMenuEntry = Parameters<GUIContext["ui"]["Menu"]>[0]["items"][number]
type Target = { serverID: string; label: string; location: { directory: string } }
type CatalogModel = SetupSnapshot["catalog"][number]

export { setupText }
export const setupEntries = [
  { id: "predictions-enabled", title: "Enable Predictions", description: "Turn next-prompt predictions on or off", keywords: "enabled switch" },
  { id: "predictions-automatic", title: "Predict After Replies", description: "Predict automatically after each reply", keywords: "automatic after replies" },
  { id: "predictions-escalation", title: "Escalation Mode", description: "What happens when a model gives no suggestion", keywords: "escalation second opinion" },
  { id: "predictions-models", title: "Models", description: "Ordered groups of prediction models", keywords: "models groups fallback variant reasoning pattern" },
  { id: "predictions-advanced-timeout", title: "Timeout per model", description: "Milliseconds before a model attempt is abandoned", keywords: "timeout milliseconds" },
  { id: "predictions-advanced-context", title: "Recent interactions", description: "How many recent interactions predictions read", keywords: "context turns interactions" },
  { id: "predictions-advanced-github", title: "Include GitHub PR context", description: "Send linked pull request metadata to prediction providers", keywords: "github pull request pr private" },
  { id: "predictions-advanced-debug", title: "Debug notices", description: "Show safe progress and failure notices", keywords: "debug notices" },
]
const escalationOptions = [
  { value: "off", label: "Off" },
  { value: "manual", label: "Manually" },
  { value: "automatic", label: "Automatically once after no suggestion" },
]
const turnOptions = ["1", "2", "3", "4", "5"].map(value => ({ value, label: value }))

// Reactive text node: Solid renders a text node anywhere JSX.Element is accepted.
function text(read: () => string | undefined): Text {
  const node = document.createTextNode("")
  createRenderEffect(() => { node.data = read() ?? "" })
  return node
}
const when = (condition: () => boolean, children: () => any, fallback?: () => any) => {
  const props: any = { get when() { return condition() }, get children() { return children() } }
  // Defined lazily: object spread would call the getter immediately.
  if (fallback) Object.defineProperty(props, "fallback", { get: fallback, enumerable: true })
  return createComponent(Show as any, props)
}

export function registerSetupGUI(ctx: GUIContext, openStatus: () => Promise<void>): () => void {
  const [version, bump] = createSignal(0)
  const [advanced, setAdvanced] = createSignal(false)
  const [timeoutText, setTimeoutText] = createSignal<string | undefined>()
  let pinned: { key: string; target: Target; editor: SetupEditor } | undefined
  let previewTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const target = (): Target | undefined => {
    const session = ctx.sessions.current()
    // Host locations can be empty while they load; an empty directory is not a target.
    if (session?.location?.directory && session.server.connected) return { serverID: session.server.id, label: session.server.builtin ? "this computer" : session.server.id, location: { directory: session.location.directory } }
    const server = ctx.servers.get("sidecar")
    const location = server?.connected ? server.data.location.default() : undefined
    return server && location?.directory ? { serverID: "sidecar", label: "this computer", location: { directory: location.directory } } : undefined
  }
  const key = (value: Target) => JSON.stringify([value.serverID, value.location.directory])
  const refresh = () => { if (!disposed) bump(count => count + 1) }
  const open = (value: Target) => {
    const editor = createSetupEditor(createGUISetupAPI(ctx, { serverID: value.serverID, location: value.location }), refresh)
    pinned = { key: key(value), target: value, editor }
    setTimeoutText(undefined)
    // The Desktop main bridge can still be starting on first open; one quiet retry avoids a stuck read-only view.
    void editor.load().then(() => {
      const snapshot = editor.state().snapshot
      // Preview is metadata-only, so match counts can show without any user action.
      if (snapshot && groups().length) void editor.preview()
      if (snapshot && !snapshot.writable) setTimeout(() => { if (!disposed && pinned?.editor === editor && !editor.state().dirty) void editor.load() }, 2500)
    })
  }
  const current = () => { version(); return pinned?.editor }
  const state = () => { version(); return pinned?.editor.state() }
  // A new editor is created only when nothing is pinned or the pinned draft is clean; a dirty draft waits for explicit confirmation.
  const ensure = () => {
    const next = target()
    if (!next) return
    if (!pinned) open(next)
    else if (pinned.key !== key(next) && !pinned.editor.state().dirty && !pinned.editor.state().saving) { pinned.editor.dispose(); open(next) }
  }
  // Settings are global per server: only a different server needs confirmation. A new location on the same server re-pins a clean draft silently.
  const switching = () => { version(); const next = target(); return !!pinned && !!next && pinned.target.serverID !== next.serverID ? next : undefined }

  const fields = () => state()?.fields ?? {}
  const flag = (name: "enabled" | "automatic" | "includeGithubPRContext" | "debug", fallback: boolean) => typeof fields()[name] === "boolean" ? fields()[name] as boolean : fallback
  const readOnly = () => { const value = state(); return !value?.snapshot || !value.snapshot.writable }
  const locked = () => readOnly() || !!state()?.saving || !!state()?.loading
  const groups = (): string[][] => { try { return readGroups(fields()) ?? [] } catch { return [] } }
  const edit = (patch: Record<string, unknown>) => { try { current()?.change(patch) } catch { /* invalid values are surfaced by draft validation */ } }
  const schedulePreview = () => {
    clearTimeout(previewTimer)
    previewTimer = setTimeout(() => { if (!disposed) void pinned?.editor.preview() }, 300)
  }
  const setGroups = (value: string[][]) => { current()?.setGroups(value.filter(group => group.length)); schedulePreview() }
  // Focus follows the moved row: the first named control that still exists and is enabled, else the first enabled control in the row.
  // A host menu returns focus to its trigger when it closes, so the move is asserted once more after that.
  const focusControl = (id: string, ...names: string[]) => {
    const find = () => {
      const controls = [...(document.querySelector(`[data-action="${id}"]`)?.querySelectorAll("button") ?? [])] as HTMLButtonElement[]
      const named = (name: string) => controls.find(control => !control.disabled && (control.getAttribute("aria-label") === name || control.textContent?.trim() === name))
      return names.map(named).find(Boolean) ?? controls.find(control => !control.disabled)
    }
    queueMicrotask(() => find()?.focus())
    setTimeout(() => { const active = document.activeElement; if (!active || active === document.body || active.getAttribute("aria-haspopup") === "menu") find()?.focus() }, 60)
  }
  const issuesFor = (group: number, entry?: number) => (state()?.issues ?? []).filter(issue => issue.field === "models" && issue.group === group && (entry === undefined ? issue.entry === undefined : issue.entry === entry))
  const modelName = (selector: string) => {
    const [base] = selector.split("#")
    const model = state()?.snapshot?.catalog.find(item => item.providerID + "/" + item.id === base)
    return model ? (model.name ?? model.id) : undefined
  }
  const selectorFor = (model: CatalogModel, variant: string | undefined) => model.providerID + "/" + model.id + (variant ? "#" + variant : "")

  const ui = ctx.ui
  const button = (label: () => string, onClick: () => void, options: { variant?: "neutral" | "contrast" | "ghost" | "danger"; disabled?: () => boolean; size?: "small" | "normal" } = {}) =>
    createComponent(ui.Button, { get children() { return text(label) }, onClick, get variant() { return options.variant ?? "neutral" }, get size() { return options.size ?? "small" }, get disabled() { return options.disabled?.() ?? false } })
  const box = (...children: any[]) => { const element = document.createElement("div"); element.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end"; for (const child of children) if (child) insert(element, child); return element }
  const actions = (...children: any[]) => { const element = box(...children); element.style.justifyContent = "flex-start"; return element }
  const column = (...children: any[]) => { const element = document.createElement("div"); element.style.cssText = "display:flex;flex-direction:column;gap:8px"; for (const child of children) if (child) insert(element, child); return element }
  const stack = (...children: any[]) => { const element = document.createElement("div"); element.style.cssText = "display:flex;flex-direction:column;gap:8px;max-height:60vh;overflow:auto"; for (const child of children) if (child) insert(element, child); return element }
  const note = (read: () => string | undefined, role?: string) => {
    const element = document.createElement("div")
    if (role) element.setAttribute("role", role)
    element.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere"
    element.append(text(read))
    return element
  }

  const addDialog = (destination: number | "new") => ctx.dialogs.open(dialog => {
    const [query, setQuery] = createSignal("")
    const [picked, setPicked] = createSignal<CatalogModel | undefined>()
    const [variant, setVariant] = createSignal("")
    const matches = () => {
      const words = query().toLowerCase().split(/\s+/).filter(Boolean)
      return (state()?.snapshot?.catalog ?? []).filter(model => words.every(word => (model.providerID + "/" + model.id + " " + (model.name ?? "")).toLowerCase().includes(word))).slice(0, 50)
    }
    const add = () => {
      const model = picked()
      if (!model) return
      const next = groups().map(group => [...group])
      if (destination === "new") next.push([selectorFor(model, variant() || undefined)]); else next[destination].push(selectorFor(model, variant() || undefined))
      setGroups(next); dialog.close()
    }
    return createComponent(ui.Dialog, {
      title: "Add a model", description: "Search by provider or model name. Choosing a model does not change your session model. " + setupText.cost, size: "large",
      get children() {
        return stack(
          createComponent(ui.TextInput, { get value() { return query() }, onInput: setQuery, label: "Search models", type: "search", autofocus: true }),
          when(() => !picked(), () => createComponent(Index as any, { get each() { return matches() }, children: (model: () => CatalogModel) => button(() => `${model().name ?? model().id} (${model().providerID}/${model().id})${model().enabled ? "" : " — disabled"}`, () => { setPicked(model()); setVariant("") }, { variant: "ghost" }) }),
            () => stack(text(() => `${picked()!.name ?? picked()!.id} (${picked()!.providerID}/${picked()!.id})`),
              createComponent(ui.Select, { get options() { return [{ value: "", label: "Default reasoning" }, ...picked()!.variants.map(item => ({ value: item.id, label: item.id }))] }, get value() { return variant() }, onChange: setVariant, label: "Reasoning variant" }))),
          when(() => matches().length === 0 && !picked(), () => note(() => "No models match. Add a model pattern instead, or connect a provider in OpenCode.")))
      },
      get footer() { return box(button(() => "Cancel", () => dialog.close()), button(() => "Add model", add, { variant: "contrast", disabled: () => !picked() })) },
    })
  })
  const patternDialog = (destination: number | "new") => ctx.dialogs.open(dialog => {
    const [value, setValue] = createSignal("")
    const problem = () => { const text = value().trim(); if (!text) return undefined; return validateSettings({ models: [[text]] })[0]?.message }
    const add = () => {
      if (!value().trim() || problem()) return
      const next = groups().map(group => [...group])
      if (destination === "new") next.push([value().trim()]); else next[destination].push(value().trim())
      setGroups(next); dialog.close()
    }
    return createComponent(ui.Dialog, {
      title: "Add a model pattern", description: "Use provider/model-pattern, such as provider/family-*, with an optional #variant. Patterns stay patterns and are matched against current models.",
      get children() { return stack(createComponent(ui.TextInput, { get value() { return value() }, onInput: setValue, onSubmit: add, label: "Model pattern", placeholder: "provider/model-*", autofocus: true, get invalid() { return !!problem() } }), note(problem, "alert")) },
      get footer() { return box(button(() => "Cancel", () => dialog.close()), button(() => "Add pattern", add, { variant: "contrast", disabled: () => !value().trim() || !!problem() })) },
    })
  })

  const swap = <T,>(items: T[], from: number, to: number) => { const copy = [...items]; [copy[from], copy[to]] = [copy[to], copy[from]]; return copy }
  const display = (selector: string) => modelName(selector) ?? selector
  // A warning is an icon plus text, never colour alone.
  const warnings = (read: () => string[]) => {
    const element = document.createElement("div")
    element.style.cssText = "display:flex;flex-direction:column;gap:4px;overflow-wrap:anywhere"
    createRenderEffect(() => {
      element.replaceChildren(...read().map(message => {
        const line = document.createElement("div")
        line.style.cssText = "display:flex;gap:6px;align-items:flex-start"
        line.append(createComponent(ui.Icon, { name: "outline-hexagonal-warning", size: "small" }) as Node, Object.assign(document.createElement("span"), { textContent: message }))
        return line
      }))
    })
    return element
  }
  const groupTitle = (index: number) => `Group ${index + 1} — ${index === 0 ? "Tried first" : `If Group ${index} fails`}`
  const addMenu = (label: string, destination: () => number | "new", icon: "plus" = "plus", trigger: "button" | "icon" = "button") =>
    createComponent(ui.Menu, {
      label, icon, trigger, placement: "bottom-end", get disabled() { return locked() },
      items: [
        { label: "Model…", icon: "models", onSelect: () => addDialog(destination()) },
        { label: "Pattern… (for example provider/family-*)", icon: "code", onSelect: () => patternDialog(destination()) },
      ],
    })
  const afterRemoval = (index: number, remaining: string[][]) => {
    if (remaining.length === 0) focusControl("predictions-models", "Add a model")
    else { const target = remaining[index] ? index : Math.max(0, index - 1); focusControl(`predictions-group-${target}`, `Group ${target + 1} actions`) }
  }
  const removeGroup = async (index: number) => {
    const group = groups()[index]
    if (!group) return
    if (group.length > 1 && !await ctx.dialogs.confirm({ title: `Remove Group ${index + 1}?`, description: `This removes ${group.length} models from the draft. Nothing changes until you save.`, confirm: "Remove group", danger: true })) return
    const next = groups().filter((_, position) => position !== index)
    setGroups(next)
    afterRemoval(index, next)
  }
  const groupSections = () => createComponent(Index as any, {
    get each() { return groups() },
    children: (group: () => string[], index: number) => createComponent(ui.SettingsSection, {
      title: groupTitle(index),
      get children() {
        return [
          createComponent(ui.SettingsRow, {
            id: `predictions-group-${index}`,
            get title() {
              return text(() => {
                const count = state()?.preview?.groups[index]?.candidates.length
                return count === undefined ? (state()?.previewError ? "Match count unavailable" : "Counting matches…") : `${count} ${count === 1 ? "model matches" : "models match"} now`
              })
            },
            get description() { return warnings(() => issuesFor(index).map(issue => issue.message)) },
            get children() {
              return box(
                addMenu(`Add to Group ${index + 1}`, () => index),
                createComponent(ui.Menu, {
                  label: `Group ${index + 1} actions`, trigger: "icon", icon: "outline-dots", placement: "bottom-end", get disabled() { return locked() },
                  get items() {
                    return [
                      { label: "Move group up", disabled: index === 0, onSelect: () => { setGroups(swap(groups(), index, index - 1)); focusControl(`predictions-group-${index - 1}`, `Group ${index} actions`) } },
                      { label: "Move group down", disabled: index === groups().length - 1, onSelect: () => { setGroups(swap(groups(), index, index + 1)); focusControl(`predictions-group-${index + 1}`, `Group ${index + 2} actions`) } },
                      { type: "separator" as const },
                      { label: "Remove group", icon: "outline-trash" as const, onSelect: () => void removeGroup(index) },
                    ] as UiMenuEntry[]
                  },
                }))
            },
          }),
          createComponent(Index as any, {
            get each() { return group() },
            children: (selector: () => string, entry: number) => createComponent(ui.SettingsRow, {
              id: `predictions-entry-${index}-${entry}`,
              get title() { return text(() => `${entry + 1}. ${display(selector())}`) },
              get description() {
                return column(note(() => modelName(selector()) ? selector() : undefined), warnings(() => issuesFor(index, entry).map(issue => issue.message)))
              },
              get children() {
                const move = (to: number) => () => {
                  const next = groups().map(items => [...items]); next[index] = swap(next[index], entry, to); setGroups(next)
                  focusControl(`predictions-entry-${index}-${to}`, `Actions for ${display(next[index][to])}`)
                }
                return createComponent(ui.Menu, {
                  get label() { return `Actions for ${display(selector())}` }, trigger: "icon", icon: "outline-dots", placement: "bottom-end", get disabled() { return locked() },
                  get items() {
                    return [
                      { label: "Move up", disabled: entry === 0, onSelect: move(entry - 1) },
                      { label: "Move down", disabled: entry === group().length - 1, onSelect: move(entry + 1) },
                      { type: "separator" as const },
                      { label: "Remove", icon: "outline-trash" as const, onSelect: () => {
                        const next = groups().map(items => [...items]); next[index].splice(entry, 1)
                        const kept = next.filter(items => items.length)
                        setGroups(kept)
                        if (next[index].length) focusControl(`predictions-entry-${index}-${Math.min(entry, next[index].length - 1)}`, `Actions for ${display(next[index][Math.min(entry, next[index].length - 1)])}`)
                        else afterRemoval(index, kept)
                      } },
                    ] as UiMenuEntry[]
                  },
                })
              },
            }),
          }),
        ]
      },
    }),
  })

  const saveMessage = () => {
    const value = state()
    if (!value) return undefined
    if (value.error) return `${value.error} If this persists, update the Predictions plugin on this server.`
    const result = value.lastSave
    if (!result) return undefined
    if (result.kind === "saved") return "Saved. The new settings are active."
    if (result.kind === "saved_not_active") return "Saved on disk, but activation is not verified. Reopen settings to check the active values."
    if (result.kind === "invalid") return "Fix the highlighted settings before saving."
    return result.message
  }
  const content = () => createComponent(ui.SettingsLayout, {
    title: "Predictions",
    get description() { version(); return pinned ? `Settings apply to the global OpenCode configuration on ${pinned.target.label}.` : "Connect to an OpenCode server to review prediction settings." },
    get actions() { return button(() => "Prediction status and preview", () => void openStatus()) },
    get children() {
      return [
        when(() => !!switching(), () => createComponent(ui.SettingsSection, {
          get children() {
            return createComponent(ui.SettingsRow, {
              id: "predictions-switch", title: text(() => `Switch to ${switching()?.label}`),
              description: text(() => state()?.dirty ? "This page has unsaved changes for another server. Switching discards them." : "The selected server changed."),
              get children() {
                return button(() => "Switch server", async () => {
                  const next = switching()
                  if (!next || (state()?.dirty && !await ctx.dialogs.confirm({ title: "Discard unsaved prediction settings?", description: `Your changes apply to ${pinned?.target.label} and will be discarded.`, confirm: "Discard and switch", danger: true }))) return
                  pinned?.editor.dispose(); open(next)
                }, { disabled: () => !!state()?.saving })
              },
            })
          },
        })),
        when(() => { version(); return !pinned || (!state()?.snapshot && !state()?.loading && !state()?.error) }, () => createComponent(ui.SettingsSection, { get children() { return createComponent(ui.SettingsRow, { id: "predictions-unavailable", title: "Settings are not connected", description: "Open a project or connect to an OpenCode server to edit prediction settings." }) } })),
        when(() => !!state()?.loading, () => createComponent(ui.SettingsSection, { get children() { return createComponent(ui.SettingsRow, { id: "predictions-loading", title: "Loading settings", get children() { return createComponent(ui.Loader, {}) } }) } })),
        when(() => !!state()?.error, () => createComponent(ui.SettingsSection, {
          get children() { return createComponent(ui.SettingsRow, { id: "predictions-error", title: "Settings are unavailable", get description() { return note(saveMessage, "alert") }, get children() { return button(() => "Try again", () => void pinned?.editor.load()) } }) },
        })),
        when(() => !!state()?.snapshot && !state()?.snapshot?.writable, () => createComponent(ui.SettingsSection, {
          get children() {
            return createComponent(ui.SettingsRow, { id: "predictions-readonly", title: "Read-only", get description() { return note(() => (state()?.snapshot?.reason ?? "This configuration cannot be edited here.") + " Current values are shown; edit the configuration file manually to change them.") }, get children() { return button(() => "Check again", () => void pinned?.editor.load()) } })
          },
        })),
        when(() => !!state()?.snapshot, () => [
          createComponent(ui.SettingsSection, {
            title: "Behavior",
            get footer() { return note(() => flag("enabled", true) ? undefined : setupText.disabled) },
            get children() {
              return [
                createComponent(ui.SettingsRow, { id: "predictions-enabled", title: "Enable Predictions", description: "Suggest a next prompt after a completed reply.", get children() { return createComponent(ui.Switch, { get checked() { return flag("enabled", true) }, onChange: (checked: boolean) => edit({ enabled: checked }), label: "Enable Predictions", hideLabel: true, get disabled() { return locked() } }) } }),
                createComponent(ui.SettingsRow, { id: "predictions-automatic", title: "Predict After Replies", description: "Predict automatically after each reply. When off, request predictions manually.", get children() { return createComponent(ui.Switch, { get checked() { return flag("automatic", true) }, onChange: (checked: boolean) => edit({ automatic: checked }), label: "Predict After Replies", hideLabel: true, get disabled() { return locked() } }) } }),
                createComponent(ui.SettingsRow, { id: "predictions-escalation", title: "Escalation Mode", description: setupText.escalation, get children() { return createComponent(ui.Select, { options: escalationOptions, get value() { return typeof fields().escalation === "string" ? fields().escalation as string : "manual" }, onChange: (value: string) => edit({ escalation: value }), label: "Escalation Mode", get disabled() { return locked() } }) } }),
              ]
            },
          }),
          createComponent(ui.SettingsSection, {
            title: "Models",
            get children() {
              const explanation = () => column(note(() => setupText.order), note(() => setupText.cost), when(() => !!state()?.previewError, () => note(() => state()?.previewError, "status")))
              return when(() => groups().length === 0,
                () => createComponent(ui.SettingsRow, {
                  id: "predictions-models", title: "No models configured",
                  get description() { return column(note(() => "Add a model or a model pattern to start predicting."), explanation()) },
                  get children() { return box(button(() => "Add a model", () => addDialog("new"), { variant: "contrast", disabled: locked }), button(() => "Add model pattern", () => patternDialog("new"), { disabled: locked })) },
                }),
                () => createComponent(ui.SettingsRow, {
                  id: "predictions-models", title: "Fallback order",
                  get description() { return explanation() },
                  get children() {
                    return box(
                      addMenu("Add group", () => "new"),
                      createComponent(ui.Tooltip, { value: "Refresh matches", get children() { return createComponent(ui.IconButton, { icon: "refresh", label: "Refresh matches", size: "small", variant: "ghost-muted", get busy() { return !!state()?.previewing }, get disabled() { return locked() }, onClick: () => void pinned?.editor.preview() }) } }))
                  },
                }))
            },
          }),
          groupSections(),
          createComponent(ui.SettingsSection, {
            title: "Advanced",
            get children() {
              return [
                createComponent(ui.SettingsRow, { id: "predictions-advanced", title: "Advanced settings", description: "Timeout, recent interactions, GitHub PR context and debug notices.", get children() { return button(() => (advanced() ? "Hide advanced settings" : "Show advanced settings"), () => setAdvanced(!advanced())) } }),
                when(advanced, () => [
                  createComponent(ui.SettingsRow, { id: "predictions-advanced-timeout", title: "Timeout per model", get description() { return column(note(() => "Milliseconds, a whole number from 1 to 2147483647. Default 8000."), when(() => !!state()?.issues.some(issue => issue.field === "timeoutMs" && issue.severity === "error"), () => note(() => state()?.issues.find(issue => issue.field === "timeoutMs")?.message, "alert"))) }, get children() { return createComponent(ui.TextInput, { get value() { return timeoutText() ?? String(fields().timeoutMs ?? 8000) }, onInput: (value: string) => { setTimeoutText(value); const text = value.trim(); edit({ timeoutMs: /^[0-9]+$/.test(text) ? Number(text) : null }) }, label: "Timeout per model", get disabled() { return locked() }, get invalid() { return !!state()?.issues.some(issue => issue.field === "timeoutMs" && issue.severity === "error") } }) } }),
                  createComponent(ui.SettingsRow, { id: "predictions-advanced-context", title: "Recent interactions", description: "How many recent interactions predictions read, 1 to 5. Default 3.", get children() { return createComponent(ui.Select, { options: turnOptions, get value() { return String(fields().contextTurns ?? 3) }, onChange: (value: string) => edit({ contextTurns: Number(value) }), label: "Recent interactions", get disabled() { return locked() } }) } }),
                  createComponent(ui.SettingsRow, { id: "predictions-advanced-github", title: "Include GitHub PR context", description: setupText.github, get children() { return createComponent(ui.Switch, { get checked() { return flag("includeGithubPRContext", false) }, onChange: (checked: boolean) => edit({ includeGithubPRContext: checked }), label: "Include GitHub PR context", hideLabel: true, get disabled() { return locked() } }) } }),
                  createComponent(ui.SettingsRow, { id: "predictions-advanced-debug", title: "Debug notices", description: "Show safe progress and failure notices, never raw provider errors.", get children() { return createComponent(ui.Switch, { get checked() { return flag("debug", false) }, onChange: (checked: boolean) => edit({ debug: checked }), label: "Debug notices", hideLabel: true, get disabled() { return locked() } }) } }),
                ]),
              ]
            },
          }),
          createComponent(ui.SettingsSection, {
            get footer() { return note(saveMessage, "status") },
            get children() {
              return createComponent(ui.SettingsRow, {
                id: "predictions-save", title: "Save changes", get description() { return note(() => setupText.warning) },
                get children() {
                  return box(
                    when(() => !!state()?.blocked, () => button(() => "Reload settings", () => { setTimeoutText(undefined); void pinned?.editor.load() }, { disabled: () => !!state()?.saving })),
                    button(() => "Discard changes", () => { current()?.discard(); setTimeoutText(undefined) }, { disabled: () => !state()?.dirty || !!state()?.saving }),
                    button(() => (state()?.saving ? "Saving…" : "Save changes"), () => void current()?.save(), { variant: "contrast", disabled: () => readOnly() || !state()?.dirty || !!state()?.saving || !!state()?.issues.some(issue => issue.severity === "error") }))
                },
              })
            },
          }),
        ]),
      ]
    },
  })

  ctx.add(SettingsPage, {
    id: "predictions", title: "Predictions", icon: "prompt", entries: [{ id: "predictions", title: "Predictions Setup", description: "Configure prediction models and behavior", keywords: "predictions setup settings" }, ...setupEntries],
    render: input => {
      if (input.target?.startsWith("predictions-advanced")) setAdvanced(true)
      // Re-run when the host's server or location becomes available later.
      createRenderEffect(() => { version(); ensure() })
      // Reloading on each visit refreshes a clean draft; an unsaved draft is kept.
      if (pinned && !pinned.editor.state().dirty && !pinned.editor.state().saving && pinned.editor.state().snapshot) void pinned.editor.load()
      return content()
    },
  })
  ctx.add(Command, { id: "setup", title: "Predictions Setup", group: "Predictions", keywords: "settings configure models", run: () => ctx.layout.settings("predictions") })
  return () => { disposed = true; clearTimeout(previewTimer); pinned?.editor.dispose(); pinned = undefined }
}
