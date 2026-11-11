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
  assert.equal(files.some(path => /^(tests|src|node_modules|\.test-artifacts|\.env)(\/|$)/.test(path)), false)
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) assert.equal(pkg.scripts[hook], undefined)
  assert.equal(Object.values(pkg.dependencies).some(value => /git|github:|file:/.test(value)), false)
  for (const entry of [".", "./tui"]) assert.equal(typeof (await import(pathToFileURL(resolve(pkg.exports[entry])).href)).default.setup, "function")
  assert.equal(typeof (await import(pathToFileURL(resolve(pkg.exports["./rpc"])).href)).Predictions.methods.predict, "object")
})
