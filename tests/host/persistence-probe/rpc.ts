import { Rpc } from "@opencode/plugin/rpc"

export const PersistenceProbe = Rpc.define({
  id: "fcoouto.predictions.persistence-probe",
  methods: {
    read: { input: { type: "object" }, output: { type: "object" } },
    save: {
      input: { type: "object", properties: { revision: { type: "string" }, patch: { type: "object" }, removeModels: { type: "boolean" }, loseAck: { type: "boolean" }, markStarted: { type: "boolean" } }, required: ["revision", "patch"] },
      output: { type: "object" },
    },
  },
  events: {},
})
