import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"

test("packed contents include working entries and exclude local data and install-time builds", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"))
  const { stdout } = await promisify(execFile)("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"])
  const files = JSON.parse(stdout)[0].files.map(file => file.path)
  for (const path of [...Object.values(pkg.exports), pkg.bin["opencode-predictions-pilot"]]) assert.ok(files.includes(path.replace(/^\.\//, "")), path)
  assert.ok(files.includes("LICENSE") && files.includes("README.md"))
  assert.ok(files.includes("readme-demo.svg"), "README interaction diagram must ship with the package")
  assert.equal(files.some(path => /^(tests|src|node_modules|\.test-artifacts|\.env)(\/|$)/.test(path)), false)
  // npm also prepares Git dependencies when a "build" script exists, even with prebuilt bundles.
  for (const hook of ["preinstall", "install", "postinstall", "prepare", "prepack", "build"]) assert.equal(pkg.scripts[hook], undefined)
  assert.equal(Object.values(pkg.dependencies).some(value => /git|github:|file:/.test(value)), false)
  for (const [entry, id] of [[".", "opencode-predictions"], ["./tui", "opencode-predictions.tui"]]) {
    const definition = (await import(pathToFileURL(resolve(pkg.exports[entry])).href)).default
    assert.equal(typeof definition.setup, "function")
    assert.equal(definition.id, id)
  }
  assert.equal(typeof (await import(pathToFileURL(resolve(pkg.exports["./rpc"])).href)).Predictions.methods.predict, "object")
})

test("packed setup surface: inspection-only RPC, no network Save or proof signing, writer only in the server bundle", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"))
  const rpc = (await import(pathToFileURL(resolve(pkg.exports["./rpc"])).href)).Predictions
  assert.deepEqual(Object.keys(rpc.methods).sort(), ["predict", "previewSettings", "settings", "status"], "no public Save, challenge or proof-signing method")
  const gui = await readFile(pkg.exports["./gui-experimental"], "utf8")
  const server = await readFile(pkg.exports["."], "utf8")
  // The config writer and its recovery copy belong to the server bundle alone.
  for (const marker of [".predictions-backup", ".predictions.tmp-", ".predictions-setup.lock", "editSetting", "jsonc-parser"]) {
    assert.ok(server.includes(marker), `server bundle owns ${marker}`)
    assert.equal(gui.includes(marker), false, `GUI bundle must not contain ${marker}`)
  }
  // The Desktop main-process bridge is the only Node socket client; window modules perform no Node I/O.
  assert.match(gui, /require\("node:net"\)/, "private-socket client ships for the Desktop main process")
  assert.match(gui, /main:/, "the Desktop main entry is registered")
  for (const file of ["gui.ts", "setup-gui.ts", "setup-gui-api.ts", "setup-copy.ts", "setup.ts", "client.ts", "feedback.ts"]) {
    assert.equal(/from "node:/.test(await readFile(`src/${file}`, "utf8")), false, `${file} runs in the window and must not import Node modules`)
  }
  const tui = await readFile(pkg.exports["./tui"], "utf8")
  assert.match(tui, /predictions\.setup/, "the CLI setup command ships")
  assert.equal(tui.includes(".predictions-backup"), false, "the CLI never writes the configuration itself")
})
