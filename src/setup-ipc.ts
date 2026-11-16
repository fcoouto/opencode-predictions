import { Ipc } from "@opencode/plugin/gui"
import { Schema } from "effect"

// Preserve unknown input keys so main and server validation can reject them, rather than silently stripping them.
const open = <Fields extends Schema.Struct.Fields>(fields: Fields) => Schema.StructWithRest(Schema.Struct(fields), [Schema.Record(Schema.String, Schema.Unknown)])
const location = open({ directory: Schema.String, workspaceID: Schema.optionalKey(Schema.String) })
const fields = Schema.Record(Schema.String, Schema.Unknown)
const issue = Schema.Struct({
  field: Schema.Literals(["models", "enabled", "automatic", "escalation", "timeoutMs", "contextTurns", "debug", "includeGithubPRContext"]),
  group: Schema.optionalKey(Schema.Number), entry: Schema.optionalKey(Schema.Number),
  severity: Schema.Literals(["error", "warning"]), code: Schema.String, message: Schema.String,
})
const snapshot = Schema.Struct({
  revision: Schema.String, source: Schema.optionalKey(Schema.String), scope: Schema.Literal("global"), writable: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String), fields,
  effective: Schema.Unknown,
  catalog: Schema.Array(Schema.Struct({ providerID: Schema.String, id: Schema.String, name: Schema.optionalKey(Schema.String), enabled: Schema.Boolean, variants: Schema.Array(Schema.Struct({ id: Schema.String })) })),
  issues: Schema.Array(issue), serviceVersion: Schema.String,
  localAuthority: Schema.optionalKey(Schema.Struct({ id: Schema.String })),
})
const saved = Schema.Struct({ kind: Schema.Literal("saved"), revision: Schema.String, serviceVersion: Schema.String })
const notActive = Schema.Struct({ kind: Schema.Literal("saved_not_active"), revision: Schema.String, message: Schema.String })
const invalid = Schema.Struct({ kind: Schema.Literal("invalid"), issues: Schema.Array(issue) })
const refused = Schema.Struct({ kind: Schema.Literals(["conflict", "read_only", "failed"]), message: Schema.String })
export const SetupLocal = Ipc.define({
  id: "opencode-predictions.setup",
  methods: {
    read: { input: open({ serverID: Schema.String, location }), output: snapshot },
    save: { input: open({ serverID: Schema.String, location, input: open({ revision: Schema.String, fields, removeModels: Schema.optionalKey(Schema.Literal(true)) }) }), output: Schema.Union([saved, notActive, invalid, refused]) },
  },
})
