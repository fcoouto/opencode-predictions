// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
var notice = {
  type: "object",
  properties: { code: { type: "string" }, severity: { type: "string", enum: ["info", "warning", "error"] }, title: { type: "string" }, message: { type: "string" }, persistent: { type: "boolean" } },
  required: ["code", "severity", "title", "message"],
  additionalProperties: false
};
var escalation = {
  type: "object",
  properties: {
    token: { type: "string", minLength: 1 },
    group: { type: "integer", minimum: 1 },
    name: { type: "string" },
    model: { type: "object", properties: { providerID: { type: "string" }, id: { type: "string" }, variant: { type: "string" } }, required: ["providerID", "id"], additionalProperties: false }
  },
  required: ["token", "group", "name", "model"],
  additionalProperties: false
};
var settingsFields = {
  type: "object",
  properties: { models: {}, enabled: {}, automatic: {}, escalation: {}, timeoutMs: {}, contextTurns: {}, debug: {}, includeGithubPRContext: {} },
  additionalProperties: false
};
var setupIssue = {
  type: "object",
  properties: {
    field: { type: "string", enum: ["models", "enabled", "automatic", "escalation", "timeoutMs", "contextTurns", "debug", "includeGithubPRContext"] },
    group: { type: "integer", minimum: 0 },
    entry: { type: "integer", minimum: 0 },
    severity: { type: "string", enum: ["error", "warning"] },
    code: { type: "string" },
    message: { type: "string" }
  },
  required: ["field", "severity", "code", "message"],
  additionalProperties: false
};
var candidate = {
  type: "object",
  properties: { providerID: { type: "string" }, id: { type: "string" }, name: { type: "string" }, variant: { type: "string" } },
  required: ["providerID", "id", "name"],
  additionalProperties: false
};
var catalogModel = {
  type: "object",
  properties: {
    providerID: { type: "string" },
    id: { type: "string" },
    name: { type: "string" },
    enabled: { type: "boolean" },
    variants: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } }
  },
  required: ["providerID", "id", "enabled", "variants"],
  additionalProperties: false
};
var effectiveOptions = {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
    automatic: { type: "boolean" },
    debug: { type: "boolean" },
    includeGithubPRContext: { type: "boolean" },
    contextFile: { type: "string" },
    escalation: { type: "string", enum: ["off", "manual", "automatic"] },
    timeoutMs: { type: "integer", minimum: 1, maximum: 2147483647 },
    contextTurns: { type: "integer", minimum: 1, maximum: 5 },
    models: { type: "array", items: { type: "string" } }
  },
  required: ["enabled", "automatic", "debug", "includeGithubPRContext", "escalation", "timeoutMs", "contextTurns"],
  additionalProperties: false
};
var Predictions = Rpc.define({
  id: "fcoouto.predictions",
  methods: {
    predict: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string", minLength: 5 }, completion: { type: "number", minimum: 0 }, requestID: { type: "string", minLength: 1 }, manual: { type: "boolean" }, escalation: { type: "string", minLength: 1 } },
        required: ["sessionID", "completion", "requestID"],
        additionalProperties: false
      },
      output: { type: "object", properties: { text: { type: "string" }, reason: { type: "string" }, modelName: { type: "string" }, notice, escalation }, additionalProperties: false }
    },
    status: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object" }
    },
    settings: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          revision: { type: "string" },
          source: { type: "string" },
          scope: { type: "string", enum: ["global"] },
          writable: { type: "boolean" },
          reason: { type: "string" },
          fields: settingsFields,
          localAuthority: { type: "object", properties: { id: { type: "string", minLength: 16, maxLength: 16 } }, required: ["id"], additionalProperties: false },
          effective: { anyOf: [{ type: "null" }, effectiveOptions] },
          catalog: { type: "array", items: catalogModel },
          issues: { type: "array", items: setupIssue },
          serviceVersion: { type: "string" }
        },
        required: ["revision", "scope", "writable", "fields", "effective", "catalog", "issues", "serviceVersion"],
        additionalProperties: false
      }
    },
    previewSettings: {
      // Preserve unknown nested keys so server validation can reject them instead of decoder stripping.
      input: { type: "object", properties: { fields: { ...settingsFields, additionalProperties: true } }, required: ["fields"], additionalProperties: false },
      output: {
        type: "object",
        properties: {
          groups: { type: "array", items: { type: "object", properties: { selectors: { type: "array", items: { type: "string" } }, candidates: { type: "array", items: candidate } }, required: ["selectors", "candidates"], additionalProperties: false } },
          issues: { type: "array", items: setupIssue }
        },
        required: ["groups", "issues"],
        additionalProperties: false
      }
    }
  },
  events: {
    progress: {
      schema: { type: "object", properties: { requestID: { type: "string" }, sessionID: { type: "string" }, message: { type: "string" }, modelName: { type: "string" }, notice }, required: ["requestID", "sessionID", "message"], additionalProperties: false }
    }
  }
});
export {
  Predictions
};
//# sourceMappingURL=rpc.js.map
