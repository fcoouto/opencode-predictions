import { Rpc } from "@opencode/plugin/rpc"

const notice = {
  type: "object",
  properties: { code: { type: "string" }, severity: { type: "string", enum: ["info", "warning", "error"] }, title: { type: "string" }, message: { type: "string" }, persistent: { type: "boolean" } },
  required: ["code", "severity", "title", "message"], additionalProperties: false,
} as const

const escalation = {
  type: "object",
  properties: {
    token: { type: "string", minLength: 1 }, group: { type: "integer", minimum: 1 }, name: { type: "string" },
    model: { type: "object", properties: { providerID: { type: "string" }, id: { type: "string" }, variant: { type: "string" } }, required: ["providerID", "id"], additionalProperties: false },
  },
  required: ["token", "group", "name", "model"], additionalProperties: false,
} as const

export const Predictions = Rpc.define({
  id: "fcoouto.predictions",
  methods: {
    predict: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string", minLength: 5 }, completion: { type: "number", minimum: 0 }, requestID: { type: "string", minLength: 1 }, manual: { type: "boolean" }, escalation: { type: "string", minLength: 1 } },
        required: ["sessionID", "completion", "requestID"], additionalProperties: false,
      },
      output: { type: "object", properties: { text: { type: "string" }, reason: { type: "string" }, notice, escalation }, additionalProperties: false },
    },
    status: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object" },
    },
  },
  events: {
    progress: {
      schema: { type: "object", properties: { requestID: { type: "string" }, sessionID: { type: "string" }, message: { type: "string" }, notice }, required: ["requestID", "sessionID", "message"], additionalProperties: false },
    },
  },
})
