import { test } from "node:test"
import assert from "node:assert/strict"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createTerminalAdapter } from "../src/adapters/terminal.ts"

test("native terminal ghost is visible but absent from the draft and inserts without submission", async () => {
  await using screen = await createTestRenderer({ width: 60, height: 8 })
  let submissions = 0
  const editor = new TextareaRenderable(screen.renderer, { width: 60, height: 4, placeholder: "Original placeholder", onSubmit: () => { submissions++ } })
  editor.traits = Object.assign({ capture: ["tab"] as const }, { owner: "opencode", role: "prompt" })
  screen.renderer.root.add(editor)
  editor.focus()
  const adapter = createTerminalAdapter(screen.renderer)
  assert.equal(adapter.eligible(), true)
  assert.equal(adapter.paint("Run tests.\nExplain failures. 😀"), true)
  await screen.renderOnce()
  assert.ok(screen.captureCharFrame().includes("Run tests."))
  assert.equal(editor.plainText, "")
  assert.equal(adapter.insert("Run tests.\nExplain failures. 😀"), true)
  assert.equal(editor.plainText, "Run tests.\nExplain failures. 😀")
  assert.equal(submissions, 0)
  adapter.dispose()
  assert.equal(editor.placeholder, "Original placeholder")
})

test("shell/menu traits, a different editor, and typed input prevent native ghost acceptance", async () => {
  await using screen = await createTestRenderer({ width: 40, height: 6 })
  const editor = new TextareaRenderable(screen.renderer, { width: 40, height: 2 })
  editor.traits = Object.assign({ capture: ["tab"] as const }, { owner: "opencode", role: "prompt" })
  screen.renderer.root.add(editor)
  editor.focus()
  const adapter = createTerminalAdapter(screen.renderer)
  editor.insertText("my input")
  assert.equal(adapter.paint("must not appear"), false)
  assert.equal(adapter.insert("overwrite"), false)
  assert.equal(editor.plainText, "my input")
  editor.setText("")
  editor.traits = Object.assign({ status: "SHELL" }, { owner: "opencode", role: "prompt" })
  assert.equal(adapter.eligible(), false)
  editor.traits = Object.assign({ capture: ["tab", "escape"] as const }, { owner: "opencode", role: "prompt" })
  assert.equal(adapter.eligible(), false)
  editor.traits = Object.assign({ capture: ["tab"] as const }, { owner: "other", role: "search" })
  assert.equal(adapter.eligible(), false)
  assert.equal(createTerminalAdapter({ currentFocusedEditor: {} }).eligible(), false)
  adapter.dispose()
})
