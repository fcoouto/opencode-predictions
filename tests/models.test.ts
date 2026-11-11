import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveModels } from "../src/models.ts"

const catalog = [
  { providerID: "opencode-go", id: "deepseek-v4-flash", name: "DeepSeek Flash", enabled: true, variants: [{ id: "low" }] },
  { providerID: "opencode-go", id: "beam", name: "Beam Free", enabled: true, variants: [{ id: "low" }] },
  { providerID: "opencode", id: "flash", name: "Outside Flash Free", enabled: true, variants: [] },
  { providerID: "opencode-go", id: "glm-flash", name: "GLM Flash", enabled: true, variants: [] },
]

test("wildcards match IDs and display names including spaces, without changing reasoning", () => {
  assert.deepEqual(resolveModels("opencode-go/deepseek-*-flash#low", catalog), [{ providerID: "opencode-go", id: "deepseek-v4-flash", name: "DeepSeek Flash", variant: "low" }])
  assert.deepEqual(resolveModels("opencode-go/* free*#low", catalog), [{ providerID: "opencode-go", id: "beam", name: "Beam Free", variant: "low" }])
  assert.equal(resolveModels("opencode-go/glm*#low", catalog).length, 0)
})

test("selector ordering is preserved, wildcard groups are stable, and candidates are deduplicated", () => {
  const matches = resolveModels("opencode/flash, opencode-go/*, opencode-go/beam", catalog)
  assert.deepEqual(matches.map(model => model.providerID + "/" + model.id), ["opencode/flash", "opencode-go/beam", "opencode-go/deepseek-v4-flash", "opencode-go/glm-flash"])
  assert.equal("variant" in matches[0], false)
})

test("only wildcard stars are special and disabled or nonmatching models are not called", () => {
  assert.equal(resolveModels("opencode-go/(beam|.*)", catalog).length, 0)
  assert.equal(resolveModels("opencode-go/BEAM#low", catalog).length, 1)
  assert.equal(resolveModels("opencode-go/beam", [{ ...catalog[1], enabled: false }]).length, 0)
})
