import type { Plugin as TUIPlugin } from "@opencode/plugin/tui"
import { createTUISetupAPI } from "./setup-tui-api.ts"
import { setupText, setupTUIText, originLabels, contextFileIssue } from "./setup-copy.ts"
import { createSetupEditor, parseSelector, readGroups, settingKeys, validateSettings, type SetupEditor, type SetupSnapshot } from "./setup.ts"
import { defaultTimeoutMs } from "./options.ts"

type TUIContext = TUIPlugin.Context
type Catalog = SetupSnapshot["catalog"][number]
const title = "Predictions Setup"
const escalationNames: Record<string, string> = { off: "Off", manual: "Manually", automatic: "Automatically once after no suggestion" }

export function registerSetupTUI(ctx: TUIContext, openStatus: () => Promise<void>): () => void {
  const dialog = ctx.ui.dialog
  let running = false, disposed = false

  const location = () => {
    const route = ctx.ui.router.current()
    const found = (route.type === "session" ? ctx.data.session.get(route.sessionID)?.location : undefined) ?? ctx.location ?? ctx.data.location.default()
    return found?.directory ? { directory: found.directory } : undefined
  }
  const alert = (message: string) => dialog.alert({ title, message })

  async function run() {
    if (running || disposed) return
    running = true
    let editor: SetupEditor | undefined
    try {
      const target = location()
      if (!target) { await alert("Open a project, or connect to an OpenCode server, before changing prediction settings."); return }
      editor = createSetupEditor(createTUISetupAPI(ctx, target), () => {})
      await editor.load()
      if (editor.state().error || !editor.state().snapshot) { await alert((editor.state().error ?? "Settings are unavailable.") + " If this persists, update the Predictions plugin on both this client and the server."); return }
      await root(editor)
    } finally { editor?.dispose(); running = false }
  }

  const fields = (editor: SetupEditor) => editor.state().fields
  const flag = (editor: SetupEditor, name: "enabled" | "automatic" | "includeGithubPRContext" | "debug", fallback: boolean) => typeof fields(editor)[name] === "boolean" ? fields(editor)[name] as boolean : fallback
  const groups = (editor: SetupEditor): string[][] => { try { return readGroups(fields(editor)) ?? [] } catch { return [] } }
  const onOff = (value: boolean) => value ? "On" : "Off"
  const readOnly = (editor: SetupEditor) => !editor.state().snapshot?.writable
  const readOnlyReason = (editor: SetupEditor) => {
    const snapshot = editor.state().snapshot
    return snapshot?.reason ?? "This configuration cannot be edited here."
  }
  // Returns false (after explaining) when the target cannot be edited, so no draft diverges from what Save may do.
  async function editable(editor: SetupEditor) {
    if (!readOnly(editor)) return true
    await alert(`Read-only. ${readOnlyReason(editor)} Current values are shown; edit the configuration file manually to change them.`)
    return false
  }
  const edit = (editor: SetupEditor, patch: Record<string, unknown>) => { try { editor.change(patch) } catch { /* invalid values appear as draft issues */ } }
  const modelName = (editor: SetupEditor, selector: string) => {
    const [base] = selector.split("#")
    const model = editor.state().snapshot?.catalog.find(item => item.providerID + "/" + item.id === base)
    return model ? model.name ?? model.id : undefined
  }
  const issues = (editor: SetupEditor, group: number, entry?: number) => editor.state().issues.filter(issue => issue.field === "models" && issue.group === group && (entry === undefined ? issue.entry === undefined : issue.entry === entry)).map(issue => issue.message)

  // The host truncates a row to one line (title plus description, about 44 characters on a 56-column terminal) instead of wrapping,
  // so descriptions stay terse and the full text lives in an About alert.
  const escalationShort: Record<string, string> = { off: "off", manual: "manual", automatic: "auto" }
  const summary = {
    behavior: (editor: SetupEditor) => `${onOff(flag(editor, "enabled", true))} · After replies ${onOff(flag(editor, "automatic", true)).toLowerCase()} · ${escalationShort[String(fields(editor).escalation ?? "manual")] ?? "manual"}`,
    models: (editor: SetupEditor) => { const all = groups(editor); return all.length ? `${all.length} ${all.length === 1 ? "group" : "groups"}, ${all.flat().length} ${all.flat().length === 1 ? "entry" : "entries"}` : "No models configured" },
    advanced: (editor: SetupEditor) => `${fields(editor).timeoutMs ?? defaultTimeoutMs} ms · ${fields(editor).contextTurns ?? 3} recent · PR ${onOff(flag(editor, "includeGithubPRContext", false)).toLowerCase()}`,
  }

  async function root(editor: SetupEditor) {
    for (;;) {
      const state = editor.state()
      const invalid = state.issues.some(issue => issue.severity === "error")
      const choice = await dialog.select<string>({
        title: state.dirty ? `${title} — unsaved changes` : title,
        placeholder: "Choose a section",
        options: [
          ...(readOnly(editor) ? [{ title: "Read-only", description: "Select to see why.", value: "readonly", category: "Settings" }] : []),
          { title: "Behavior", description: summary.behavior(editor), value: "behavior", category: "Settings" },
          { title: "Models", description: summary.models(editor), value: "models", category: "Settings" },
          { title: "Advanced", description: summary.advanced(editor), value: "advanced", category: "Settings" },
          { title: "Save changes", description: invalid ? "Fix invalid settings first." : "Can overwrite other edits.", value: "save", disabled: !state.dirty || readOnly(editor) || invalid || state.saving, category: "Changes" },
          { title: "Discard changes", description: "Restore saved values.", value: "discard", disabled: !state.dirty, category: "Changes" },
          { title: "Reset to defaults", value: "reset", disabled: readOnly(editor) || !Object.keys(state.snapshot?.overrides ?? {}).length, category: "Changes" },
          { title: "Preference sources", description: "Path and origins.", value: "sources", category: "More" },
          { title: "Prediction status and preview", description: "Diagnostics.", value: "status", category: "More" },
          { title: "About saving", description: "Scope and limits.", value: "about", category: "More" },
        ],
      })
      if (choice === undefined) {
        // Leaving with unsaved edits needs confirmation; declining returns to this menu with the draft intact.
        if (editor.state().dirty && !await dialog.confirm({ title, message: "Discard your unsaved prediction settings?", label: { confirm: "Discard", cancel: "Keep editing" } })) continue
        return
      }
      if (choice === "behavior") await behavior(editor)
      else if (choice === "models") await models(editor)
      else if (choice === "advanced") await advanced(editor)
      else if (choice === "save") await save(editor)
      else if (choice === "discard") editor.discard()
      else if (choice === "reset") {
        if (state.dirty && !await dialog.confirm({ title, message: "Replace your unsaved draft with defaults? Save to apply the reset.", label: { confirm: "Replace draft", cancel: "Keep editing" } })) continue
        editor.resetPreferences()
      }
      else if (choice === "sources") await alert(`User preferences\n${state.snapshot?.source ?? "Server preferences"}\n\n${settingKeys.map(key => `${key}: ${originLabels[state.origins[key]]}`).join("\n")}\n\n${setupText.defaults}`)
      else if (choice === "status") await openStatus()
      else if (choice === "readonly") await alert(`Read-only. ${readOnlyReason(editor)} Current values are shown; edit the configuration file manually to change them.`)
      else if (choice === "about") await alert(`${setupTUIText.scope}\n\n${setupTUIText.fuller}`)
    }
  }

  async function save(editor: SetupEditor) {
    const result = await editor.save()
    const message = result.kind === "saved" ? "Saved. The new settings are active."
      : result.kind === "saved_not_active" ? "Saved on disk, but activation is not verified. Reopen settings to check the active values."
      : result.kind === "invalid" ? result.issues.find(issue => issue.field === "contextFile")?.message ?? "Fix the invalid settings before saving."
      : result.message
    await alert(message)
  }

  async function behavior(editor: SetupEditor) {
    for (;;) {
      const choice = await dialog.select<string>({
        title: "Behavior",
        options: [
          { title: "Enable Predictions", description: onOff(flag(editor, "enabled", true)) + (flag(editor, "enabled", true) ? "" : " · edits apply later"), value: "enabled" },
          { title: "Predict After Replies", description: onOff(flag(editor, "automatic", true)) + (flag(editor, "automatic", true) ? "" : " · request manually"), value: "automatic" },
          { title: "Escalation Mode", description: { off: "Off", manual: "Manual", automatic: "Auto once" }[String(fields(editor).escalation ?? "manual")] ?? "Manual", value: "escalation" },
          { title: "About Behavior", description: "Escalation and fallback.", value: "about" },
        ],
      })
      if (choice === undefined) return
      if (choice === "about") { await alert(setupText.escalation + " " + setupText.disabled); continue }
      if (!await editable(editor)) continue
      if (choice === "enabled" || choice === "automatic") edit(editor, { [choice]: !flag(editor, choice, true) })
      else {
        const next = await dialog.select<string>({ title: "Escalation Mode", current: String(fields(editor).escalation ?? "manual"), options: Object.entries(escalationNames).map(([value, name]) => ({ title: name, value, description: value === "off" ? "No second opinion offered." : undefined })) })
        if (next !== undefined) edit(editor, { escalation: next })
      }
    }
  }

  const strictNumber = /^[0-9]+$/
  async function advanced(editor: SetupEditor) {
    for (;;) {
      const choice = await dialog.select<string>({
        title: "Advanced",
        options: [
          { title: "Timeout per model", description: `${fields(editor).timeoutMs ?? defaultTimeoutMs} ms`, value: "timeout" },
          { title: "Recent interactions", description: `${fields(editor).contextTurns ?? 3} (1 to 5)`, value: "context" },
          { title: "Include GitHub PR context", description: `${onOff(flag(editor, "includeGithubPRContext", false))} · private data`, value: "github" },
          { title: "Debug notices", description: onOff(flag(editor, "debug", false)), value: "debug" },
          { title: "About Advanced", description: "PR and context file data.", value: "about" },
        ],
      })
      if (choice === undefined) return
      if (choice === "about") { await alert([setupText.github, setupText.contextFile, contextFileIssue(editor.state())].filter(Boolean).join("\n\n")); continue }
      if (!await editable(editor)) continue
      if (choice === "github" || choice === "debug") edit(editor, { [choice === "github" ? "includeGithubPRContext" : "debug"]: !flag(editor, choice === "github" ? "includeGithubPRContext" : "debug", false) })
      else if (choice === "context") {
        const next = await dialog.select<string>({ title: "Recent interactions", current: String(fields(editor).contextTurns ?? 3), options: ["1", "2", "3", "4", "5"].map(value => ({ title: value, value })) })
        if (next !== undefined) edit(editor, { contextTurns: Number(next) })
      } else {
        let value = String(fields(editor).timeoutMs ?? defaultTimeoutMs)
        for (;;) {
          const answer = await dialog.prompt({ title: "Timeout per model", description: "Milliseconds, a whole number from 1 to 2147483647.", value })
          if (answer === undefined) break
          value = answer.trim()
          // Strict: "8000oops" is rejected rather than truncated to 8000.
          const number = strictNumber.test(value) ? Number(value) : null
          const problem = number === null ? "Enter a whole number from 1 to 2147483647." : validateSettings({ timeoutMs: number })[0]?.message
          if (problem) { await alert(problem); continue }
          edit(editor, { timeoutMs: number })
          break
        }
      }
    }
  }

  const setGroups = (editor: SetupEditor, next: string[][]) => editor.setGroups(next.filter(group => group.length))
  const swap = <T,>(items: T[], from: number, to: number) => { const copy = [...items]; [copy[from], copy[to]] = [copy[to], copy[from]]; return copy }

  // With `current`, the pickers open on the entry's model and reasoning level so editing is one or two confirmations.
  async function pickModel(editor: SetupEditor, current?: string): Promise<string | undefined> {
    const catalog = editor.state().snapshot?.catalog ?? []
    if (!catalog.length) { await alert("No models are available from this server. Add a model pattern instead, or connect a provider in OpenCode."); return undefined }
    const parsed = current === undefined ? undefined : parseSelector(current, catalog)
    const was = parsed?.kind === "model" ? parsed : undefined
    const model = await dialog.select<Catalog>({
      title: current === undefined ? "Add a model" : "Change model", placeholder: "Search by provider or model name", current: was?.model,
      options: catalog.map(item => ({ title: item.name ?? item.id, description: `${item.providerID}/${item.id}${item.enabled ? "" : " — disabled"}`, value: item, category: item.providerID })),
      search: (query, options) => {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean)
        return options.filter(option => words.every(word => (option.title + " " + option.description).toLowerCase().includes(word))).slice(0, 50)
      },
    })
    if (!model) return undefined
    let variant: string | undefined
    if (model.variants.length) {
      const kept = model === was?.model && model.variants.some(item => item.id === was.variant) ? was.variant! : ""
      const chosen = await dialog.select<string>({ title: "Reasoning variant", current: kept, options: [{ title: "Default reasoning", value: "" }, ...model.variants.map(item => ({ title: item.id, value: item.id }))] })
      if (chosen === undefined) return undefined
      variant = chosen || undefined
    }
    return model.providerID + "/" + model.id + (variant ? "#" + variant : "")
  }
  async function pickPattern(editor: SetupEditor, current?: string): Promise<string | undefined> {
    let value = current ?? ""
    for (;;) {
      const answer = await dialog.prompt({ title: current === undefined ? "Add a model pattern" : "Edit model pattern", description: "Use provider/model-pattern, such as provider/family-*, with an optional #variant. Patterns stay patterns.", placeholder: "provider/model-*", value })
      if (answer === undefined) return undefined
      value = answer.trim()
      const problem = !value ? "Enter a provider/model-pattern selector." : validateSettings({ models: [[value]] })[0]?.message
      if (problem) { await alert(problem); continue }
      return value
    }
  }
  async function addTo(editor: SetupEditor, destination: number | "new", pick: (editor: SetupEditor) => Promise<string | undefined>) {
    if (!await editable(editor)) return
    const selector = await pick(editor)
    if (!selector) return
    const next = groups(editor).map(group => [...group])
    if (destination === "new" || !next[destination]) next.push([selector]); else next[destination].push(selector)
    setGroups(editor, next)
    await editor.preview()
  }

  async function models(editor: SetupEditor) {
    await editor.preview()
    for (;;) {
      const all = groups(editor)
      const preview = editor.state().preview
      const options = [
        ...all.map((group, index) => {
          const count = preview?.groups[index]?.candidates.length
          return { title: `Group ${index + 1} — ${index === 0 ? "Try first" : "Fallback"}`, description: `${group.length} ${group.length === 1 ? "entry" : "entries"}${count === undefined ? "" : ` · ${count} match`}`, value: `group:${index}`, category: "Groups" }
        }),
        { title: all.length ? "Add fallback group (model)" : "Add a model", value: "new-model", category: "Add" },
        { title: all.length ? "Add fallback group (pattern)" : "Add model pattern", value: "new-pattern", category: "Add" },
        ...(editor.state().previewError ? [{ title: "Preview unavailable", description: "Match counts hidden.", value: "preview-retry", category: "More" }] : []),
        { title: "Preview matches", description: "Names only; sends nothing.", value: "preview", category: "More" },
        { title: "About models", description: "Cost, order, fallback.", value: "about", category: "More" },
      ]
      const choice = await dialog.select<string>({ title: "Models", options })
      if (choice === undefined) return
      if (choice === "new-model") await addTo(editor, "new", pickModel)
      else if (choice === "new-pattern") await addTo(editor, "new", pickPattern)
      else if (choice === "preview" || choice === "preview-retry") await editor.preview()
      else if (choice === "about") await alert(setupText.order + " " + setupText.cost)
      else await group(editor, Number(choice.slice("group:".length)))
    }
  }

  async function group(editor: SetupEditor, index: number) {
    for (;;) {
      const all = groups(editor)
      if (index >= all.length) return
      const entries = all[index]
      const choice = await dialog.select<string>({
        title: `Group ${index + 1} — ${index === 0 ? "Try first" : "Fallback"}`,
        options: [
          ...entries.map((selector, position) => ({ title: modelName(editor, selector) ?? selector, description: modelName(editor, selector) ? selector : undefined, value: `entry:${position}`, category: "Entries" })),
          { title: "Add model", value: "add-model", category: "Actions" }, { title: "Add model pattern", value: "add-pattern", category: "Actions" },
          { title: "Move group up", value: "up", disabled: index === 0, category: "Actions" },
          { title: "Move group down", value: "down", disabled: index === all.length - 1, category: "Actions" },
          { title: "Remove group", description: "Removes the group.", value: "remove", category: "Actions" },
        ],
      })
      if (choice === undefined) return
      if (choice === "add-model") await addTo(editor, index, pickModel)
      else if (choice === "add-pattern") await addTo(editor, index, pickPattern)
      else if (choice === "remove") { if (await editable(editor)) { setGroups(editor, all.filter((_, position) => position !== index)); await editor.preview(); return } }
      else if (choice === "up" || choice === "down") {
        if (!await editable(editor)) continue
        const to = choice === "up" ? index - 1 : index + 1
        setGroups(editor, swap(all, index, to)); await editor.preview(); index = to
      } else await entry(editor, index, Number(choice.slice("entry:".length)))
    }
  }

  async function entry(editor: SetupEditor, index: number, position: number) {
    const all = groups(editor)
    const selector = all[index]?.[position]
    if (selector === undefined) return
    const choice = await dialog.select<string>({
      title: modelName(editor, selector) ?? selector,
      options: [
        { title: "Edit", description: "Change model or pattern.", value: "edit" },
        { title: "Details", description: "Selector and warnings.", value: "details" },
        { title: "Move up", value: "up", disabled: position === 0 }, { title: "Move down", value: "down", disabled: position === all[index].length - 1 },
        { title: "Remove", description: "Removes it.", value: "remove" },
      ],
    })
    if (choice === "details") { await alert([selector, ...issues(editor, index, position)].join("\n")); return }
    if (choice === undefined || !await editable(editor)) return
    if (choice === "edit") {
      const replacement = parseSelector(selector, editor.state().snapshot?.catalog ?? []).kind === "model" ? await pickModel(editor, selector) : await pickPattern(editor, selector)
      // Only replace the entry that was edited, where it still is.
      const now = groups(editor)
      if (!replacement || now[index]?.[position] !== selector) return
      const edited = now.map(items => [...items]); edited[index][position] = replacement
      setGroups(editor, edited)
      await editor.preview()
      return
    }
    const next = all.map(items => [...items])
    if (choice === "remove") next[index].splice(position, 1)
    else next[index] = swap(next[index], position, choice === "up" ? position - 1 : position + 1)
    setGroups(editor, next)
    await editor.preview()
  }

  ctx.keymap.layer(() => ({ mode: "global", priority: 20, commands: [{ id: "predictions.setup", title, group: "Predictions", palette: true, run: () => void run() }] }))
  return () => { disposed = true }
}
