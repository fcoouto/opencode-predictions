import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { cp, mkdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createFixture } from "./fixture.mjs"
import { Predictions } from "../../src/rpc.ts"
import type { SetupSnapshot } from "../../src/setup.ts"

test("OpenCode installs prebuilt Git packages without invoking dependency preparation", { timeout: 180000 }, async () => {
  const packagePath = process.env.PREDICTIONS_PACKAGE ?? resolve(".")
  await using fixture = await createFixture(packagePath, {}, {}, { projectConfig: true, seedPreferences: false })
  const repository = join(fixture.root, "git-package")
  await mkdir(repository)
  for (const file of ["package.json", "README.md", "LICENSE", "dist"]) await cp(join(packagePath, file), join(repository, file), { recursive: true })
  const run = promisify(execFile)
  await run("git", ["init", "-b", "main"], { cwd: repository })
  await run("git", ["add", "."], { cwd: repository })
  await run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Fixture"], { cwd: repository })
  const { stdout } = await run(process.env.OPENCODE_BIN ?? "opencode", ["plugin", "add", `git+file://${repository}#main`], { cwd: fixture.directory, env: { ...fixture.env, npm_config_fetch_retries: "0", npm_config_fetch_timeout: "20000" }, timeout: 150000, maxBuffer: 1024 * 1024 })
  assert.match(stdout, /installed and added/)
  await fixture.writeConfig({ ...fixture.config, plugins: [`git+file://${repository}#main`] })
  await fixture.restart()
  const location = { directory: fixture.directory }, rpc = fixture.api.rpc(Predictions)
  const before = await rpc.settingsV2({}, { location }) as SetupSnapshot
  assert.equal(before.writable, true)
  const loaded = (await fixture.api.plugin.list({ location })).data.find(plugin => plugin.id === "opencode-predictions")!
  assert.equal(loaded.source.type, "package", "exercise the installed Git source, not the source-linked local entry")
  const paths = (await fixture.api.config.get({ location })).flatMap(entry => entry.type === "document" && entry.path?.startsWith(fixture.root) ? [entry.path] : [])
  const originals = await Promise.all(paths.map(async path => [path, await readFile(path)] as const))
  assert.equal((await rpc.saveSettings({ revision: before.revision, fields: { debug: true } }, { location }) as any).kind, "saved")
  assert.deepEqual(JSON.parse(await readFile(fixture.preferencesFile, "utf8")).settings, { debug: true })
  for (const [path, bytes] of originals) assert.deepEqual(await readFile(path), bytes)
  assert.deepEqual(fixture.calls, [])
})
