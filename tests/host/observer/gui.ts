import { Plugin } from "@opencode/plugin/gui"
import { Predictions } from "../../../src/rpc.ts"
export default Plugin.define({
  setup(ctx) {
    const fixture = {
      ready: () => ctx.layout.ready() && !!ctx.servers.get("sidecar")?.connected,
      launch: () => ctx.layout.draft({ server: "sidecar", directory: String(ctx.options.directory), prompt: "Fix the assertion." }),
      users: () => { const session = ctx.sessions.current(); return session?.server.data.session.message.list(session.id).filter((message: { type: string }) => message.type === "user").length },
      snapshot: async () => {
        const session = ctx.sessions.current()
        if (!session) return { session: false }
        const composer = ctx.screen.current()?.composer
        return { session: session.server.data.session.get(session.id), focused: composer?.focused(), quotable: composer?.quotable(), text: composer?.text(), status: await session.server.client.rpc(Predictions).status({}, { location: session.location }) }
      },
    }
    Object.defineProperty(window, "__predictionFixture", { value: fixture, configurable: true })
    return () => { Reflect.deleteProperty(window, "__predictionFixture") }
  },
})
