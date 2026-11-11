import { Rpc } from "@opencode/plugin/rpc"

export const Predictions = Rpc.define({
  id: "fcoouto.predictions",
  methods: {
    predict: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string", minLength: 5 }, completion: { type: "number", minimum: 0 }, requestID: { type: "string", minLength: 1 } },
        required: ["sessionID", "completion", "requestID"], additionalProperties: false,
      },
      output: { type: "object", properties: { text: { type: "string" }, reason: { type: "string" } }, additionalProperties: false },
    },
    status: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object" },
    },
  },
  events: {
    progress: {
      schema: { type: "object", properties: { requestID: { type: "string" }, sessionID: { type: "string" }, message: { type: "string" } }, required: ["requestID", "sessionID", "message"], additionalProperties: false },
    },
  },
})
