import { Ipc, Plugin, Server } from "@opencode/plugin/gui"
import { Schema } from "effect"
import { Predictions } from "../../../src/rpc.ts"
import { createDesktopAdapter } from "../../../src/adapters/desktop.ts"
import { createDesktopSetupOrigin } from "../../../src/setup-origin.ts"
import { createGUISetupAPI } from "../../../src/setup-gui-api.ts"
import { createSetupEditor } from "../../../src/setup.ts"
const OriginProbe = Ipc.define({
  id: "prediction-test-observer.origin",
  methods: { inspect: {
    input: Schema.Struct({ ids: Schema.Array(Schema.String) }),
    output: Schema.Struct({
      hostVersion: Schema.String,
      entries: Schema.Array(Schema.Struct({ id: Schema.String, known: Schema.Boolean, sameMachine: Schema.Boolean, guardAllowed: Schema.Boolean, localDispatches: Schema.Number })),
    }),
  } },
})
export default Plugin.define({
  main(ctx) {
    if (!ctx.options.originProbe) return
    const provider = ctx.provide(OriginProbe, { inspect: async ({ ids }) => ({
      hostVersion: ctx.app.version,
      entries: await Promise.all(ids.map(async id => {
        const endpoint = ctx.serverEndpoints.get(id)
        const origin = createDesktopSetupOrigin(ctx, id)
        let localDispatches = 0, guardAllowed = false
        try { await origin.dispatch(ctx.signal, async () => { localDispatches++ }); guardAllowed = true }
        catch { /* Origin refusal is the observation; no local operation may run. */ }
        finally { origin.dispose() }
        return { id, known: !!endpoint, sameMachine: endpoint?.sameMachine === true, guardAllowed, localDispatches }
      })),
    }) })
    return () => provider.dispose()
  },
  setup(ctx) {
    const setupEditor = ctx.options.setupProbe ? createSetupEditor(createGUISetupAPI(ctx, { serverID: "sidecar", location: { directory: String(ctx.options.directory) } }), () => {}) : undefined
    if (ctx.options.originProbe) {
      const targets = ctx.options.originTargets
      if (!Array.isArray(targets)) throw new Error("Origin fixture targets are missing")
      ctx.add(Server, {
        ready: true,
        entries: targets.map((target: { id: string; url: string; password: string }) => ({
          id: target.id, name: "Origin fixture " + target.id, state: "ready" as const,
          http: { url: target.url, password: target.password },
        })),
      })
    }
    const handoff = ctx.storage?.memory?.("lifecycle-proof", { initial: { generations: 0, token: "" } })
    handoff?.[1](state => { state.generations++; state.token ||= crypto.randomUUID() })
    const adapter = createDesktopAdapter(document, () => ctx.screen.current()?.composer)
    let lastKey: unknown
    const onKey = (event: KeyboardEvent) => { if (event.code === "KeyP") lastKey = { key: event.key, code: event.code, eligible: adapter.eligible(), matches: ctx.keybinds.matches("opencode-predictions.request-shortcut", event) } }
    document.addEventListener("keydown", onKey, true)
    const fixture = {
      setupReady: () => !!setupEditor && ctx.servers.get("sidecar")?.connected === true,
      setupServerVersion: async () => (await ctx.servers.get("sidecar")!.client.server.info()).version,
      setupRead: async () => { await setupEditor!.load(); return setupEditor!.state().snapshot },
      setupSave: async () => { setupEditor!.change({ debug: true }); return setupEditor!.save() },
      originReady: () => ["other", "relay"].every(id => ctx.servers.get("prediction-test-observer:" + id)?.connected),
      origin: async () => {
        const ids = ["sidecar", "prediction-test-observer:other", "prediction-test-observer:relay", "missing-origin-target"]
        const result = await ctx.main(OriginProbe).inspect({ ids })
        const other = ctx.servers.get(ids[1])!, relay = ctx.servers.get(ids[2])!
        const a = await other.client.server.info(), b = await relay.client.server.info()
        return { ...result, relayMatchesOtherServer: a.pid === b.pid && a.version === b.version, windowOtherIsLocal: other.local }
      },
      memory: () => handoff ? { available: true, generations: handoff[0].generations, token: handoff[0].token } : { available: false },
      ready: () => ctx.layout.ready() && !!ctx.servers.get("sidecar")?.connected,
      launch: () => ctx.layout.draft({ server: "sidecar", directory: String(ctx.options.directory), prompt: "Fix the assertion." }),
      status: () => ctx.commands.run("opencode-predictions.status"),
      openSetup: () => ctx.commands.run("opencode-predictions.setup"),
      predictionReady: (submittedAt: number) => {
        const session = ctx.sessions.current()
        if (!session || !session.server.connected || !session.location || session.pending) return false
        const data = session.server.data
        const info = data.session.get(session.id)
        return !!info && !info.parentID && (info.time.idle ?? 0) >= submittedAt && info.outcome !== "interrupted" && data.session.status(session.id) === "idle" && adapter.eligible() && !data.session.pending.list(session.id).length && !data.session.permission.list(session.id)?.length && !data.session.form.list(session.id, session.location)?.length
      },
      users: () => { const session = ctx.sessions.current(); return session?.server.data.session.message.list(session.id).filter((message: { type: string }) => message.type === "user").length },
      snapshot: async () => {
        const session = ctx.sessions.current()
        if (!session) return { session: false }
        const composer = ctx.screen.current()?.composer
        const data = session.server.data
        const ready = !session.pending && data.session.status(session.id) === "idle" && !data.session.pending.list(session.id).length && !data.session.permission.list(session.id)?.length && !data.session.form.list(session.id, session.location)?.length
        return { session: data.session.get(session.id), ready, eligible: adapter.eligible(), focused: composer?.focused(), text: composer?.text(), shortcut: ctx.keybinds.keybind("opencode-predictions.request-shortcut"), lastKey, status: await session.server.client.rpc(Predictions).status({}, { location: session.location }) }
      },
    }
    Object.defineProperty(window, "__predictionFixture", { value: fixture, configurable: true })
    return () => { setupEditor?.dispose(); adapter.dispose(); document.removeEventListener("keydown", onKey, true); Reflect.deleteProperty(window, "__predictionFixture") }
  },
})
