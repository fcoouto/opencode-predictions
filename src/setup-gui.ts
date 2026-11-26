import { Command, SettingsPage } from "@opencode/plugin/gui"
import type { Plugin as GUIPlugin } from "@opencode/plugin/gui"
import { Index, Show, createComponent, createRenderEffect, createSignal, untrack } from "solid-js"
import { insert } from "solid-js/web"
import { createGUISetupAPI } from "./setup-gui-api.ts"
import { setupText, contextFileIssue } from "./setup-copy.ts"
import { createSetupEditor, parseSelector, readGroups, validateSettings, type SetupEditor, type SetupSnapshot } from "./setup.ts"
import { defaultTimeoutMs } from "./options.ts"

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
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const later = (run: () => void, delay: number) => { const timer = setTimeout(() => { timers.delete(timer); if (!disposed) run() }, delay); timers.add(timer) }
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
      if (snapshot && !snapshot.writable) later(() => { if (pinned?.editor === editor && !editor.state().dirty) void editor.load() }, 2500)
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
  // Preview is metadata-only. Any edit, discard, save or reload clears it, so ask again whenever groups exist and nothing is pending.
  createRenderEffect(() => {
    const value = state()
    if (value?.snapshot && groups().length && !value.preview && !value.previewing && !value.previewError && !value.loading && !value.saving) schedulePreview()
  })
  // Focus follows the moved row: the first named control that still exists and is enabled, else the first enabled control in the row.
  // A host menu returns focus to its trigger when it closes, so the move is asserted once more after that.
  const focusControl = (id: string, ...names: string[]) => {
    const find = () => {
      const controls = [...(document.querySelector(`[data-action="${id}"]`)?.querySelectorAll("button") ?? [])] as HTMLButtonElement[]
      const named = (name: string) => controls.find(control => !control.disabled && (control.getAttribute("aria-label") === name || control.textContent?.trim() === name))
      return names.map(named).find(Boolean) ?? controls.find(control => !control.disabled)
    }
    queueMicrotask(() => find()?.focus())
    later(() => { const active = document.activeElement; if (!active || active === document.body || active.getAttribute("aria-haspopup") === "menu") find()?.focus() }, 60)
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
  // Each child gets its own insertion point (marker null): without one, Solid treats every dynamic child as the element's only child and a swapped child leaves its old node behind.
  const box = (...children: any[]) => { const element = document.createElement("div"); element.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end"; for (const child of children) if (child) insert(element, child, null); return element }
  const actions = (...children: any[]) => { const element = box(...children); element.style.justifyContent = "flex-start"; return element }
  const column = (...children: any[]) => { const element = document.createElement("div"); element.style.cssText = "display:flex;flex-direction:column;gap:8px"; for (const child of children) if (child) insert(element, child, null); return element }
  const stack = (...children: any[]) => { const element = document.createElement("div"); element.style.cssText = "display:flex;flex-direction:column;gap:8px;max-height:60vh;overflow:auto"; for (const child of children) if (child) insert(element, child, null); return element }
  const note = (read: () => string | undefined, role?: string) => {
    const element = document.createElement("div")
    if (role) element.setAttribute("role", role)
    element.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere"
    element.append(text(read))
    return element
  }

  // The host's own searchable pickers: the model, then its reasoning level when it has any. Dismissing either step changes nothing.
  const pickModel = async (current?: string): Promise<string | undefined> => {
    const catalog = state()?.snapshot?.catalog ?? []
    if (!catalog.length) { await ctx.dialogs.alert({ title: "No models available", description: "This server lists no models. Add a model pattern instead, or connect a provider in OpenCode." }); return undefined }
    const parsed = current === undefined ? undefined : parseSelector(current, catalog)
    const was = parsed?.kind === "model" ? parsed : undefined
    const model = await ctx.dialogs.select<CatalogModel>({
      title: current === undefined ? "Add a model" : "Change model", placeholder: "Search by provider or model name", current: was?.model,
      options: catalog.map(item => ({ title: item.name ?? item.id, description: item.providerID + "/" + item.id + (item.enabled ? "" : " — disabled"), group: item.providerID, value: item })),
    })
    if (!model || disposed) return undefined
    if (!model.variants.length) return selectorFor(model, undefined)
    // A level the model no longer offers falls back to highlighting the default.
    const kept = model === was?.model && model.variants.some(item => item.id === was.variant) ? was.variant! : null
    const variant = await ctx.dialogs.select<string | null>({
      title: `Reasoning for ${model.name ?? model.id}`, current: kept,
      options: [{ title: "Default reasoning", value: null }, ...model.variants.map(item => ({ title: item.id, value: item.id }))],
    })
    if (variant === undefined || disposed) return undefined
    return selectorFor(model, variant ?? undefined)
  }
  // A picker or dialog can stay open while the page moves to another server; its result belongs only to the editor it was opened for.
  const addTo = (editor: SetupEditor | undefined, destination: number | "new", selector: string) => {
    if (!editor || pinned?.editor !== editor || locked()) return
    const next = groups().map(group => [...group])
    if (destination === "new" || !next[destination]) next.push([selector]); else next[destination].push(selector)
    setGroups(next)
  }
  const addModel = async (destination: number | "new") => { const editor = current(); const selector = await pickModel(); if (selector) addTo(editor, destination, selector) }
  // Adds a pattern, or edits one when `initial` is given. The pattern is checked as it is typed.
  const patternDialog = (options: { initial?: string; onDone: (selector: string) => void }) => ctx.dialogs.open(dialog => {
    const editing = options.initial !== undefined
    const [value, setValue] = createSignal(options.initial ?? "")
    const problem = () => { const text = value().trim(); if (!text) return undefined; return validateSettings({ models: [[text]] })[0]?.message }
    const done = () => {
      if (!value().trim() || problem()) return
      options.onDone(value().trim()); dialog.close()
    }
    return createComponent(ui.Dialog, {
      title: editing ? "Edit model pattern" : "Add a model pattern", description: "Use provider/model-pattern, such as provider/family-*, with an optional #variant. Patterns stay patterns and are matched against current models.",
      get children() { return stack(createComponent(ui.TextInput, { get value() { return value() }, onInput: setValue, onSubmit: done, label: "Model pattern", placeholder: "provider/model-*", autofocus: true, get invalid() { return !!problem() } }), note(problem, "alert")) },
      get footer() { return box(button(() => "Cancel", () => dialog.close()), button(() => editing ? "Save pattern" : "Add pattern", done, { variant: "contrast", disabled: () => !value().trim() || !!problem() })) },
    })
  })
  // The draft can change while a picker is open; only replace the entry that was edited, where it still is.
  const replaceAt = (editor: SetupEditor | undefined, group: number, entry: number, was: string, selector: string) => {
    if (!editor || pinned?.editor !== editor || locked() || groups()[group]?.[entry] !== was) return
    const next = groups().map(items => [...items]); next[group][entry] = selector
    setGroups(next)
    focusControl(`predictions-entry-${group}-${entry}`, editName(selector, group, entry))
  }
  // A catalog model reopens the pickers on its current choice; anything else, including a model that left the catalog, is edited as text.
  const editEntry = async (group: number, entry: number) => {
    const was = groups()[group]?.[entry]
    const editor = current()
    if (was === undefined || locked()) return
    if (parseSelector(was, state()?.snapshot?.catalog ?? []).kind === "pattern") { patternDialog({ initial: was, onDone: selector => replaceAt(editor, group, entry, was, selector) }); return }
    const selector = await pickModel(was)
    if (selector) replaceAt(editor, group, entry, was, selector)
  }
  // Every row has an Edit button; its accessible name says which entry it edits while the visible text stays "Edit".
  const editName = (selector: string, group: number, entry: number) => `Edit ${display(selector)}, group ${group + 1}, entry ${entry + 1}`
  const editButton = (selector: () => string, group: number, entry: number) => {
    const hidden = document.createElement("span")
    hidden.style.cssText = "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0"
    hidden.append(text(() => editName(selector(), group, entry).slice("Edit".length)))
    return createComponent(ui.Button, { get children() { return [text(() => "Edit"), hidden] }, onClick: () => void editEntry(group, entry), variant: "neutral", size: "small", get disabled() { return locked() } })
  }
  // The second line under an entry: its provider/id and reasoning level in words, or that it is a pattern.
  const entryDetail = (selector: string) => {
    const parsed = parseSelector(selector, state()?.snapshot?.catalog ?? [])
    if (parsed.kind === "model") return parsed.model.providerID + "/" + parsed.model.id + (parsed.variant ? ` · Reasoning: ${parsed.variant}` : "")
    return selector.includes("*") ? "Pattern" : undefined
  }

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
  // A host may read a menu's label, items and disabled state once. Rebuild the menu whenever any of them changes instead of relying on reactivity.
  const keyed = (key: () => string, build: () => any) => createComponent(Show as any, { get when() { return "k:" + key() }, keyed: true, // Show only calls `children` as a render function, and so re-runs it when the key changes, if it declares a parameter.
    children: (_key: string) => untrack(build) })
  const addMenu = (label: string, destination: () => number | "new", icon: "plus" = "plus", trigger: "button" | "icon" = "button") =>
    keyed(() => String(locked()), () => createComponent(ui.Menu, {
      label, icon, trigger, placement: "bottom-end", disabled: locked(),
      items: [
        { label: "Model…", icon: "models", onSelect: () => void addModel(destination()) },
        { label: "Pattern… (for example provider/family-*)", icon: "code", onSelect: () => { const editor = current(); patternDialog({ onDone: selector => addTo(editor, destination(), selector) }) } },
      ],
    }))
  const afterRemoval = (index: number, remaining: string[][]) => {
    if (remaining.length === 0) focusControl("predictions-models", "Add a model")
    else { const target = remaining[index] ? index : Math.max(0, index - 1); focusControl(`predictions-group-${target}`, `Group ${target + 1} actions`) }
  }
  const removeGroup = async (index: number) => {
    const group = groups()[index]
    if (!group || locked()) return
    const text = group.join("\u0000")
    if (group.length > 1 && !await ctx.dialogs.confirm({ title: `Remove Group ${index + 1}?`, description: `This removes ${group.length} models from the draft. Nothing changes until you save.`, confirm: "Remove group", danger: true })) return
    // The draft can change while the question is open; only remove the group that was asked about.
    if (locked() || groups()[index]?.join("\u0000") !== text) return
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
                keyed(() => `${index}:${groups().length}:${locked()}`, () => createComponent(ui.Menu, {
                  label: `Group ${index + 1} actions`, trigger: "icon", icon: "outline-dots", placement: "bottom-end", disabled: locked(),
                  items: [
                    { label: "Move group up", disabled: index === 0, onSelect: () => { setGroups(swap(groups(), index, index - 1)); focusControl(`predictions-group-${index - 1}`, `Group ${index} actions`) } },
                    { label: "Move group down", disabled: index === groups().length - 1, onSelect: () => { setGroups(swap(groups(), index, index + 1)); focusControl(`predictions-group-${index + 1}`, `Group ${index + 2} actions`) } },
                    { type: "separator" as const },
                    { label: "Remove group", icon: "outline-trash" as const, onSelect: () => void removeGroup(index) },
                  ] as UiMenuEntry[],
                })))
            },
          }),
          createComponent(Index as any, {
            get each() { return group() },
            children: (selector: () => string, entry: number) => createComponent(ui.SettingsRow, {
              id: `predictions-entry-${index}-${entry}`,
              get title() { return text(() => `${entry + 1}. ${display(selector())}`) },
              get description() {
                return column(note(() => entryDetail(selector())), warnings(() => issuesFor(index, entry).map(issue => issue.message)))
              },
              get children() {
                const name = (position: number, selectorText: string) => `Actions for ${display(selectorText)}, group ${index + 1}, entry ${position + 1}`
                const moveTo = (to: number) => () => {
                  const next = groups().map(items => [...items]); next[index] = swap(next[index], entry, to); setGroups(next)
                  focusControl(`predictions-entry-${index}-${to}`, name(to, next[index][to]))
                }
                return box(editButton(selector, index, entry), keyed(() => `${index}:${entry}:${selector()}:${group().length}:${locked()}`, () => createComponent(ui.Menu, {
                  label: name(entry, selector()), trigger: "icon", icon: "outline-dots", placement: "bottom-end", disabled: locked(),
                  items: [
                    { label: "Move up", disabled: entry === 0, onSelect: moveTo(entry - 1) },
                    { label: "Move down", disabled: entry === group().length - 1, onSelect: moveTo(entry + 1) },
                    { type: "separator" as const },
                    { label: "Remove", icon: "outline-trash" as const, onSelect: () => {
                      const next = groups().map(items => [...items]); next[index].splice(entry, 1)
                      const kept = next.filter(items => items.length)
                      setGroups(kept)
                      if (next[index].length) { const target = Math.min(entry, next[index].length - 1); focusControl(`predictions-entry-${index}-${target}`, name(target, next[index][target])) }
                      else afterRemoval(index, kept)
                    } },
                  ] as UiMenuEntry[],
                })))
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
    if (value.error) return `${value.error} If this persists, update the Predictions plugin on both this client and the server.`
    const result = value.lastSave
    // Say why Save is off, next to Save, whichever section the problem is in.
    if (!result) return value.issues.find(issue => issue.severity === "error")?.message
    if (result.kind === "saved") return "Saved. The new settings are active."
    if (result.kind === "saved_not_active") return "Saved on disk, but activation is not verified. Reopen settings to check the active values."
    if (result.kind === "invalid") return result.issues.find(issue => issue.field === "contextFile")?.message ?? "Fix the highlighted settings before saving."
    return result.message
  }
  const content = () => createComponent(ui.SettingsLayout, {
    title: "Predictions",
    get description() { version(); return pinned ? `User prediction preferences on ${pinned.target.label}. ${setupText.scope}` : "Connect to an OpenCode server to review prediction settings." },
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
                  get children() { return box(button(() => "Add a model", () => void addModel("new"), { variant: "contrast", disabled: locked }), button(() => "Add model pattern", () => { const editor = current(); patternDialog({ onDone: selector => addTo(editor, "new", selector) }) }, { disabled: locked })) },
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
                createComponent(ui.SettingsRow, { id: "predictions-advanced", title: "Advanced settings", description: "Timeout, recent interactions, context sources and debug notices.", get children() { return button(() => (advanced() ? "Hide advanced settings" : "Show advanced settings"), () => setAdvanced(!advanced())) } }),
                when(advanced, () => [
                  createComponent(ui.SettingsRow, { id: "predictions-advanced-timeout", title: "Timeout per model", get description() { return column(note(() => `Milliseconds, a whole number from 1 to 2147483647. Default ${defaultTimeoutMs}.`), when(() => !!state()?.issues.some(issue => issue.field === "timeoutMs" && issue.severity === "error"), () => note(() => state()?.issues.find(issue => issue.field === "timeoutMs")?.message, "alert"))) }, get children() { return createComponent(ui.TextInput, { get value() { return timeoutText() ?? String(fields().timeoutMs ?? defaultTimeoutMs) }, onInput: (value: string) => { setTimeoutText(value); const text = value.trim(); edit({ timeoutMs: /^[0-9]+$/.test(text) ? Number(text) : null }) }, label: "Timeout per model", get disabled() { return locked() }, get invalid() { return !!state()?.issues.some(issue => issue.field === "timeoutMs" && issue.severity === "error") } }) } }),
                  createComponent(ui.SettingsRow, { id: "predictions-advanced-context", title: "Recent interactions", description: "How many recent interactions predictions read, 1 to 5. Default 3.", get children() { return createComponent(ui.Select, { options: turnOptions, get value() { return String(fields().contextTurns ?? 3) }, onChange: (value: string) => edit({ contextTurns: Number(value) }), label: "Recent interactions", get disabled() { return locked() } }) } }),
                  createComponent(ui.SettingsRow, { id: "predictions-advanced-context-file", title: "Context file", get description() { return column(note(() => setupText.contextFileManual), when(() => !!contextFileIssue(state()), () => note(() => contextFileIssue(state()), "alert"))) } }),
                  createComponent(ui.SettingsRow, { id: "predictions-advanced-github", title: "Include GitHub PR context", description: setupText.github, get children() { return createComponent(ui.Switch, { get checked() { return flag("includeGithubPRContext", false) }, onChange: (checked: boolean) => edit({ includeGithubPRContext: checked }), label: "Include GitHub PR context", hideLabel: true, get disabled() { return locked() } }) } }),
                  createComponent(ui.SettingsRow, { id: "predictions-advanced-debug", title: "Debug notices", description: "Show safe progress and failure notices, never raw provider errors.", get children() { return createComponent(ui.Switch, { get checked() { return flag("debug", false) }, onChange: (checked: boolean) => edit({ debug: checked }), label: "Debug notices", hideLabel: true, get disabled() { return locked() } }) } }),
                ]),
              ]
            },
          }),
          // Reset edits the draft across every section, so it sits just before the Save row that commits it.
          createComponent(ui.SettingsSection, {
            get children() {
              const saved = () => Object.keys(state()?.snapshot?.overrides ?? {}).length > 0
              return createComponent(ui.SettingsRow, {
                id: "predictions-reset", title: "Reset to defaults",
                get description() { return note(() => saved() ? "Replace every setting on this page with its default. Nothing changes until you save." : "Every setting already uses its default.") },
                get children() {
                  return button(() => "Reset to defaults", async () => {
                    if (state()?.dirty && !await ctx.dialogs.confirm({ title: "Replace unsaved prediction settings?", description: "This replaces your draft with defaults. Save to apply the reset.", confirm: "Reset to defaults" })) return
                    current()?.resetPreferences(); setTimeoutText(undefined)
                  }, { disabled: () => locked() || !saved() })
                },
              })
            },
          }),
          createComponent(ui.SettingsSection, {
            get footer() { return note(saveMessage, "status") },
            get children() {
              return createComponent(ui.SettingsRow, {
                id: "predictions-save", title: "Save changes", get description() { return note(() => setupText.warning) },
                get children() {
                  return box(
                    when(() => !!state()?.blocked, () => button(() => "Reload settings", async () => {
                      if (state()?.dirty && !await ctx.dialogs.confirm({ title: "Discard unsaved prediction settings?", description: "Reloading shows the saved settings and discards your unsaved changes.", confirm: "Reload and discard", danger: true })) return
                      setTimeoutText(undefined); void pinned?.editor.load()
                    }, { disabled: () => !!state()?.saving })),
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
    id: "predictions", title: "Predictions", icon: "comment", entries: [{ id: "predictions", title: "Predictions Setup", description: "Configure prediction models and behavior", keywords: "predictions setup settings" }, ...setupEntries],
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
  return () => { disposed = true; clearTimeout(previewTimer); for (const timer of timers) clearTimeout(timer); timers.clear(); pinned?.editor.dispose(); pinned = undefined }
}
