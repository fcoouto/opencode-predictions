import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { dirname, resolve } from "node:path"
import { builtinModules } from "node:module"
import { runInNewContext } from "node:vm"

test("packed contents include working entries and exclude local data and install-time builds", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"))
  const { stdout } = await promisify(execFile)("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"])
  const files = JSON.parse(stdout)[0].files.map(file => file.path)
  for (const path of [...Object.values(pkg.exports), pkg.bin["opencode-predictions-pilot"]]) assert.ok(files.includes(path.replace(/^\.\//, "")), path)
  assert.ok(files.includes("LICENSE") && files.includes("README.md"))
  assert.ok(pkg.keywords.includes("opencode-plugin"), "opencode.im discovers plugins by this keyword")
  assert.match(await readFile("README.md", "utf8"), new RegExp(`"${pkg.name}"`), "README shows the npm install entry")
  assert.ok(files.includes("assets/predictions-desktop.gif"), "README Desktop demo must ship with the package")
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

test("packed setup surface: selected-server Save, no local bridge, writer only in the server bundle", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"))
  const rpc = (await import(pathToFileURL(resolve(pkg.exports["./rpc"])).href)).Predictions
  assert.deepEqual(Object.keys(rpc.methods).sort(), ["contextFileStatus", "predict", "previewSettings", "saveSettings", "settingsV2", "status"], "only the selected-server settings contract is public")
  const gui = await readFile(pkg.exports["./gui-experimental"], "utf8")
  const server = await readFile(pkg.exports["."], "utf8")
  const tui = await readFile(pkg.exports["./tui"], "utf8")
  // Clients may name predictions.json in help text, but only the server constructs the write paths.
  assert.ok(server.includes("predictions.json"))
  assert.match(server, /new URL\("\.\.\/dist\/predictions-verifier\.exe", import\.meta\.url\)/)
  assert.doesNotMatch(server, /powershell\.exe|Add-Type -ReferencedAssemblies/)
  for (const client of [gui, tui]) assert.doesNotMatch(client, /predictions-verifier\.exe/)
  for (const marker of [".predictions.tmp-", ".backup", "node:fs/promises"]) {
    assert.ok(server.includes(marker), `server bundle owns ${marker}`)
    assert.equal(gui.includes(marker), false, `GUI bundle must not contain ${marker}`)
    assert.equal(tui.includes(marker), false, `CLI bundle must not contain ${marker}`)
  }
  for (const marker of [".predictions-backup", ".predictions-setup.lock", "createConfigStore", "editSetting", "createStandaloneSetupOrigin", "createDesktopSetupOrigin", "localAuthority", "node:net"]) {
    for (const [entry, code] of [["server", server], ["GUI", gui], ["CLI", tui]]) assert.equal(code.includes(marker), false, `${entry} must not retain ${marker}`)
  }
  // Evaluate the actual GUI artifact with only the app's shared modules, rejecting any filesystem/socket import.
  const shared = {
    "@opencode/plugin/gui": { Plugin: { define: value => value }, Command: {}, SettingsPage: {}, createKeyed() {} },
    "@opencode/plugin/rpc": await import("@opencode/plugin/rpc"),
    "solid-js": await import("solid-js"),
    "solid-js/web": await import("solid-js/web"),
  }
  const module = { exports: {} }
  runInNewContext(gui, { module, exports: module.exports, TextEncoder, require(name) { assert.ok(Object.hasOwn(shared, name), `GUI attempted an unshared import: ${name}`); return shared[name] } })
  assert.equal(typeof module.exports.default.setup, "function")
  assert.equal(module.exports.default.main, undefined, "settings do not register a Desktop main-process bridge")
  // Walk every local import, including parent-relative and dynamic imports.
  const seen = new Set(), pending = ["src/gui.ts"]
  // Every import specifier counts: static, side-effect, dynamic and require, across lines, with single or double quotes.
  const builtin = new Set([...builtinModules, ...builtinModules.map(name => "node:" + name)])
  const specifiers = source => [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g)].map(match => match[1])
  while (pending.length) {
    const file = pending.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const source = await readFile(file, "utf8")
    for (const specifier of specifiers(source)) assert.equal(builtin.has(specifier) || specifier.startsWith("node:"), false, `${file} runs in the window and must not import ${specifier}`)
    for (const local of specifiers(source).filter(name => name.startsWith("."))) pending.push(resolve(dirname(file), local))
  }
  for (const file of ["src/gui.ts", "src/setup-gui.ts", "src/setup-gui-api.ts", "src/setup.ts"]) assert.ok(seen.has(file) || seen.has(resolve(file)), `${file} is part of the window graph`)
  assert.equal(seen.has(resolve("src/preferences-store.ts")), false, "the window never owns the preference writer")
  assert.match(tui, /predictions\.setup/, "the CLI setup command ships")
})
