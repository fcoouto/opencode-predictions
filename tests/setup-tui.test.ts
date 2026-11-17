import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { registerSetupTUI } from "../src/setup-tui.ts"
import { nativeFixture } from "./setup-native-fixture.ts"

type Call = { kind: "select" | "prompt" | "confirm" | "alert"; options: any }
type Step = (call: Call) => unknown
const catalog = [
  { providerID: "local", id: "family/a", name: "Family A", enabled: true, variants: [{ id: "low" }, { id: "high" }] },
  { providerID: "local", id: "b", name: "Model B", enabled: true, variants: [] },
  { providerID: "paid", id: "long", name: "非常に長いモデル名 ".repeat(6) + "Ünïcødé", enabled: true, variants: [] },
]

// Scripted dialogs: each step answers the next dialog call, so tests read as a user's key sequence.
const pick = (title: string): Step => call => {
  const option = call.options.options?.find((item: any) => item.title === title)
  assert.ok(option, `option "${title}" in ${JSON.stringify(call.options.options?.map((item: any) => item.title))}`)
  assert.notEqual(option.disabled, true, `option "${title}" must be enabled`)
  return option.value
}
const cancel: Step = () => undefined
const text = (value: string): Step => () => value
const yes = (value: boolean): Step => () => value
const ok: Step = () => undefined

async function harness(t: TestContext, options: { argv?: string[]; fields?: object; noSession?: boolean; settingsFails?: boolean; previewFails?: boolean } = {}) {
  const f = await nativeFixture(t)
  f.snapshot.catalog = catalog as any
  if (options.fields) f.snapshot.fields = options.fields as any
  f.snapshot.effective = { ...f.snapshot.effective, ...f.snapshot.fields } as any
  if (options.argv) f.runtime.argv = options.argv
  f.hooks.settingsFails = options.settingsFails
  f.hooks.previewFails = options.previewFails
  const script: Step[] = []
  const calls: Call[] = []
  const answer = async (kind: Call["kind"], dialog: unknown) => {
    const call = { kind, options: dialog } as Call
    calls.push(call)
    const step = script.shift()
    assert.ok(step, `unexpected ${kind} dialog: ${JSON.stringify((dialog as any).title)}`)
    return step(call)
  }
  let command: any, statusOpened = 0
  const ctx: any = {
    app: { version: "2.2.6" }, client: f.client, location: options.noSession ? { directory: f.location.directory } : undefined,
    options: {},
    ui: {
      router: { current: () => options.noSession ? { type: "home" } : { type: "session", sessionID: "ses_1" } },
      dialog: { select: (o: unknown) => answer("select", o), prompt: (o: unknown) => answer("prompt", o), confirm: (o: unknown) => answer("confirm", o), alert: (o: unknown) => answer("alert", o) },
    },
    data: { session: { get: () => ({ location: { directory: f.location.directory } }) }, location: { default: () => ({ directory: f.location.directory }) } },
    keymap: { layer: (factory: () => any) => { command = factory().commands[0] } },
  }
  const stop = registerSetupTUI(ctx, async () => { statusOpened++ }, f.runtime)
  t.after(stop)
  const run = async (...steps: Step[]) => {
    script.push(...steps)
    await command.run()
    // The palette command is fire-and-forget; wait for the script to drain.
    for (let i = 0; i < 300 && script.length; i++) await new Promise(resolve => setTimeout(resolve, 10))
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(script.length, 0, "every scripted step was consumed")
  }
  return { f, calls, run, command: () => command, statusOpened: () => statusOpened }
}
const titles = (call: Call) => call.options.options.map((item: any) => item.title)
const saves = (h: Awaited<ReturnType<typeof harness>>) => h.f.counts().saves
const option = (call: Call, name: string) => call.options.options.find((item: any) => item.title === name)

test("palette command is Predictions Setup in the Predictions group with no default shortcut", async t => {
  const h = await harness(t)
  assert.equal(h.command().id, "predictions.setup")
  assert.equal(h.command().title, "Predictions Setup")
  assert.equal(h.command().group, "Predictions")
  assert.equal(h.command().palette, true)
  assert.equal(h.command().bind, undefined)
})

test("root menu orders Behavior, Models, Advanced with current values and keeps the narrow CLI scope visible", async t => {
  const h = await harness(t, { fields: { automatic: false, models: [["local/family/a#low"], ["local/b"]] } })
  await h.run(cancel)
  const root = h.calls[0]
  assert.equal(root.options.title, "Predictions Setup")
  assert.deepEqual(titles(root), ["Behavior", "Models", "Advanced", "Save changes", "Discard changes", "Prediction status and preview", "About saving"])
  for (const row of root.options.options) assert.ok(row.title.length + String(row.description ?? "").length <= 44, `row fits the CLI dialog without truncation: ${row.title}: ${row.description}`)
  assert.ok(root.options.options.every((row: any) => row.disabled !== true || row.title.includes("Save") || row.title.includes("Discard")), "informational rows are never disabled: disabled rows do not render")
  assert.equal(option(root, "Behavior").description, "On · After replies off · manual")
  assert.match(option(root, "Models").description, /2 groups, 2 entries/)
  assert.equal(option(root, "Advanced").description, "8000 ms · 3 recent · PR off")
  assert.equal(option(root, "Save changes").disabled, true, "nothing to save yet")
  assert.equal(option(root, "Discard changes").disabled, true)
  assert.equal(root.options.options.some((row: any) => row.title === "Read-only"), false, "a verified standalone session shows no read-only row")
})

test("editing Behavior and Advanced stages only edited fields; nested cancel keeps the draft; Save writes once", async t => {
  const h = await harness(t)
  await h.run(
    pick("Behavior"), pick("Enable Predictions"), pick("Escalation Mode"), pick("Off"), cancel,
    pick("Advanced"), pick("Debug notices"), cancel,
    // Back at the root the draft is intact and Save is now available.
    call => { assert.match(call.options.title, /unsaved changes/); assert.equal(option(call, "Save changes").disabled, false); return "save" },
    ok,
    cancel,
  )
  assert.equal(saves(h), 1)
  assert.equal(await readFile(h.f.file, "utf8"), '{"enabled":false,"escalation":"off","debug":true}')
})

test("strict numbers: a malformed timeout is rejected rather than truncated, and valid values stage", async t => {
  const h = await harness(t)
  await h.run(
    pick("Advanced"), pick("Timeout per model"),
    text("8000oops"), ok, text("0"), ok, text("9000"),
    pick("Recent interactions"), pick("5"),
    cancel, cancel, yes(true),
  )
  const alerts = h.calls.filter(call => call.kind === "alert").map(call => call.options.message)
  assert.equal(alerts.length, 2, "both invalid values were explained")
  assert.match(alerts[0], /whole number/)
  const advanced = h.calls.filter(call => call.kind === "select" && call.options.title === "Advanced").at(-1)!
  assert.match(option(advanced, "Timeout per model").description, /^9000 ms/)
  assert.match(option(advanced, "Recent interactions").description, /^5\b/)
  assert.equal(saves(h), 0)
})

test("GitHub PR context is off by default in Advanced with the private-data disclosure, and toggling has no side effects", async t => {
  const realFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = (async (input: any, init: any) => { if (/github/i.test(String(input?.url ?? input))) { fetches++; throw new Error("PRIVATE") } return realFetch(input, init) }) as typeof fetch
  t.after(() => { globalThis.fetch = realFetch })
  const h = await harness(t)
  await h.run(pick("Advanced"), pick("Include GitHub PR context"), pick("About Advanced"), call => { assert.match(call.options.message, /private GitHub PRs may be sent to every attempted prediction provider, including fallback and paid models/); return undefined }, cancel, cancel, yes(true))
  const before = option(h.calls[1], "Include GitHub PR context")
  assert.match(before.description, /^Off\b/)
  assert.match(before.description, /private/i, "the private-data note is short enough to render")
  assert.ok(before.title.length + before.description.length <= 44, before.description)
  assert.match(option(h.calls[2], "Include GitHub PR context").description, /^On\b/)
  assert.equal(fetches, 0, "setup performs no PR retrieval")
  assert.equal(saves(h), 0)
})

test("GitHub PR context saves an explicit false, and omission is preserved by unrelated edits", async t => {
  const h = await harness(t, { fields: { includeGithubPRContext: true } })
  await h.run(pick("Advanced"), pick("Include GitHub PR context"), cancel, pick("Save changes"), ok, cancel)
  assert.equal(await readFile(h.f.file, "utf8"), '{"includeGithubPRContext":false}', "an explicit false is persisted, not dropped")
  const other = await harness(t, { fields: {} })
  await other.run(pick("Behavior"), pick("Predict After Replies"), cancel, pick("Save changes"), ok, cancel)
  assert.equal(await readFile(other.f.file, "utf8"), '{"automatic":false}')
})

test("starting without models offers Add a model and Add model pattern; patterns are validated and kept as rules", async t => {
  const h = await harness(t, { fields: {} })
  await h.run(
    pick("Models"),
    call => { assert.deepEqual(titles(call).slice(0, 2), ["Add a model", "Add model pattern"]); return pick("Add model pattern")(call) },
    text("no-slash"), ok, text("local/missing-*"),
    cancel,
    pick("Save changes"), ok, cancel,
  )
  assert.equal(await readFile(h.f.file, "utf8"), '{"models":[["local/missing-*"]]}')
})

test("searchable model selection offers variants and keeps provider IDs secondary", async t => {
  const h = await harness(t, { fields: {} })
  await h.run(
    pick("Models"), pick("Add a model"),
    call => {
      const results = call.options.search("family a", call.options.options)
      assert.deepEqual(results.map((item: any) => item.title), ["Family A"])
      assert.equal(results[0].description, "local/family/a", "the exact ID is secondary text")
      assert.equal(call.options.search("zzz", call.options.options).length, 0)
      return results[0].value
    },
    pick("high"),
    cancel, pick("Save changes"), ok, cancel,
  )
  assert.equal(await readFile(h.f.file, "utf8"), '{"models":[["local/family/a#high"]]}')
})

test("groups and entries move, remove and reorder with named actions", async t => {
  const h = await harness(t, { fields: { models: [["local/family/a#low", "local/b"], ["local/b"]] } })
  await h.run(
    pick("Models"),
    // Move the fallback group to the front, then remove it (the group menu follows the moved group).
    pick("Group 2 — Fallback"), pick("Move group up"), pick("Remove group"),
    // The remaining group holds Family A then Model B; reorder them, then remove the one now first.
    pick("Group 1 — Try first"), pick("Family A"), pick("Move down"),
    pick("Model B"), pick("Remove"),
    cancel, cancel,
    pick("Save changes"), ok, cancel,
  )
  assert.equal(await readFile(h.f.file, "utf8"), '{"models":[["local/family/a#low"]]}')
})

test("an emptied group disappears instead of saving an invalid empty group", async t => {
  const h = await harness(t, { fields: { models: [["local/b"]] } })
  await h.run(pick("Models"), pick("Group 1 — Try first"), pick("Model B"), pick("Remove"), call => { assert.equal(titles(call)[0], "Add a model"); return undefined }, pick("Save changes"), ok, cancel)
  assert.equal(await readFile(h.f.file, "utf8"), "{}", "removing every model removes the models setting (an explicit removal, not an empty array)")
})

test("leaving with unsaved edits asks first; Keep editing preserves the draft and Discard drops it", async t => {
  const h = await harness(t)
  await h.run(
    pick("Behavior"), pick("Enable Predictions"), cancel,
    cancel, yes(false),
    call => { assert.match(call.options.title, /unsaved changes/); return undefined },
    yes(true),
  )
  assert.equal(h.calls.filter(call => call.kind === "confirm").length, 2)
  assert.equal(saves(h), 0)
})

test("explicit-server, shared and conflicting launches keep inspection but cannot save, and explain the standalone requirement", async t => {
  const standalone = "Local setup writes currently require a verified opencode --standalone session."
  for (const argv of [["/native/opencode", "/native/opencode", "--server", "http://remote"], ["/native/opencode", "/native/opencode"], ["/native/opencode", "/native/opencode", "--standalone", "--server", "http://remote"]]) {
    const h = await harness(t, { argv })
    const before = await readFile(h.f.file, "utf8")
    await h.run(
      call => { assert.equal(option(call, "Read-only").title.length + option(call, "Read-only").description.length <= 44, true); assert.equal(option(call, "Read-only").disabled, undefined, "enabled so it renders"); assert.equal(option(call, "Save changes").disabled, true); return "readonly" },
      call => { assert.equal(call.kind, "alert"); assert.match(call.options.message, new RegExp(standalone.replaceAll(".", "\\.").replaceAll("--", "\\-\\-"))); return undefined },
      pick("Behavior"),
      pick("Enable Predictions"),
      call => { assert.match(call.options.message, new RegExp("Read-only\\. " + standalone.replaceAll(".", "\\.").replaceAll("--", "\\-\\-"))); return undefined },
      cancel, cancel,
    )
    assert.equal(saves(h), 0)
    assert.equal(await readFile(h.f.file, "utf8"), before, "no client configuration write")
    assert.equal(h.calls.some(call => call.kind === "confirm"), false, "nothing was drafted, so leaving needs no confirmation")
  }
})

test("a conflict keeps the draft and is explained; a later Save is a deliberate new attempt, never an automatic repeat", async t => {
  const h = await harness(t)
  await h.run(
    pick("Behavior"), pick("Enable Predictions"), cancel,
    () => { h.f.snapshot.revision = "changed-elsewhere"; return "save" },
    call => { assert.match(call.options.message, /Configuration changed/); return undefined },
    call => { assert.equal(option(call, "Save changes").disabled, false, "the draft survives the conflict"); return "behavior" },
    call => { assert.match(call.options.options[0].description, /^Off/, "the staged value is still shown"); return undefined },
    cancel, yes(true),
  )
  assert.equal(saves(h), 1)
})

test("a connection lost during Save reports a safe message, keeps the draft and never retries", async t => {
  const h = await harness(t)
  await h.run(
    pick("Behavior"), pick("Enable Predictions"), cancel,
    async () => { await h.f.authority.dispose(); return "save" },
    call => { assert.match(call.options.message, /Changes may have been saved/); assert.doesNotMatch(call.options.message, /PRIVATE|\/var\/|\.sock/); return undefined },
    cancel, yes(true),
  )
  assert.equal(saves(h), 0)
})

test("setup works with no active session, and unavailable service methods explain an update without crashing", async t => {
  const home = await harness(t, { noSession: true })
  await home.run(cancel)
  assert.equal(home.calls[0].options.title, "Predictions Setup")
  const broken = await harness(t, { settingsFails: true })
  await broken.run(call => { assert.equal(call.kind, "alert"); assert.match(call.options.message, /update the Predictions plugin/i); assert.doesNotMatch(call.options.message, /PRIVATE/); return undefined })
})

test("the external-editor warning sits beside Save and About saving gives the fuller limit without a consent dialog", async t => {
  const h = await harness(t)
  await h.run(
    pick("Behavior"), pick("Enable Predictions"), cancel,
    call => { const save = option(call, "Save changes"); assert.match(save.description, /overwrite/); assert.ok(save.title.length + save.description.length <= 44, save.description); assert.doesNotMatch(save.description, /conflict-proof/); return "about" },
    call => { assert.match(call.options.message, /another editor during a save can be overwritten, including unrelated settings/); assert.match(call.options.message, /Recovery copies hold the file as it was just before a save/); assert.match(call.options.message, /global OpenCode configuration/); assert.match(call.options.message, /not conflict-proof/); return undefined },
    cancel, yes(true),
  )
  assert.equal(h.calls.filter(call => call.kind === "confirm").length, 1, "only the unsaved-exit confirmation, never a save consent")
})

test("the status entry opens the existing status view and does not edit", async t => {
  const h = await harness(t)
  await h.run(pick("Prediction status and preview"), cancel)
  assert.equal(h.statusOpened(), 1)
  assert.equal(saves(h), 0)
})

test("long Unicode model names and IDs stay complete in menus", async t => {
  const h = await harness(t, { fields: { models: [["paid/long"]] } })
  await h.run(pick("Models"), pick("Group 1 — Try first"), call => { const entry = titles(call)[0]; assert.match(entry, /非常に長いモデル名/); assert.match(entry, /Ünïcødé$/); assert.equal(call.options.options[0].description, "paid/long"); return call.options.options[0].value }, pick("Details"), call => { assert.equal(call.kind, "alert"); assert.match(call.options.message, /^paid\/long/); return undefined }, cancel, cancel, cancel)
})

test("every menu description fits the CLI dialog width, because the host truncates instead of wrapping", async t => {
  const h = await harness(t, { fields: { models: [["local/family/a#low"], ["local/b"]] } })
  await h.run(pick("Behavior"), cancel, pick("Advanced"), cancel, pick("Models"), pick("Group 1 — Try first"), cancel, cancel, cancel)
  for (const call of h.calls.filter(item => item.kind === "select")) for (const row of call.options.options ?? []) {
    if (row.description === undefined) continue
    assert.ok(row.title.length + row.description.length <= 44, `${call.options.title} › ${row.title}: ${row.title.length + row.description.length} chars: ${row.description}`)
  }
})

test("a failed model preview is explained in the Models menu instead of silently losing the match counts", async t => {
  const h = await harness(t, { fields: { models: [["local/b"]] }, previewFails: true })
  await h.run(pick("Models"), call => { const row = option(call, "Preview unavailable"); assert.ok(row, JSON.stringify(titles(call))); assert.ok(row.title.length + row.description.length <= 44); assert.doesNotMatch(JSON.stringify(call.options), /PRIVATE/); return undefined }, cancel)
})

test("the order explanation does not promise that no suggestion triggers the next group unless escalation says so", async t => {
  const { setupText } = await import("../src/setup-copy.ts")
  assert.doesNotMatch(setupText.order, /gives no suggestion/i, "Off and Manual escalation do not move to the next group on abstention")
  assert.match(setupText.order, /fails/)
  assert.match(setupText.order, /Escalation/)
  void t
})
