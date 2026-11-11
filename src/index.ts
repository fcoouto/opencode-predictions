import { Plugin } from "@opencode/plugin"
import { Predictions } from "./rpc.ts"
import { createService, type Request } from "./service.ts"

export default Plugin.define({
  id: "fcoouto.predictions",
  async setup(ctx) {
    const service = createService({
      session: (sessionID, signal) => ctx.session.get({ sessionID }, { signal }),
      context: (sessionID, signal) => ctx.session.context({ sessionID }, { signal }),
      models: async signal => (await ctx.model.list(undefined, { signal })).data,
      generate: async (model, prompt, signal) => (await ctx.experimental.generate.text({ model, prompt }, { signal })).text,
      notice: async (message, request) => { if (request.requestID) await registration.events.emit("progress", { message, requestID: request.requestID, sessionID: request.sessionID }) },
    }, ctx.options, ctx.location.directory)
    const registration = await ctx.rpc.register(Predictions, {
      predict: (input, context) => service.predict(input as Request, context.signal),
      status: (_input, context) => service.inspect(context.signal),
    })
    return () => registration.dispose()
  },
})
