import assert from "node:assert/strict"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import { Predictions } from "../../src/rpc.ts"
import type { SaveResult, SetupSnapshot } from "../../src/setup.ts"
import { createFixture } from "./fixture.mjs"

assert.equal(process.platform, "win32", "This qualification test requires native Windows.")
const { APPDATA, OPENCODE_BIN, PREDICTIONS_PACKAGE } = process.env
for (const [name, value] of Object.entries({ APPDATA, OPENCODE_BIN, PREDICTIONS_PACKAGE })) {
  assert.ok(value && isAbsolute(value), `${name} must be an absolute Windows path.`)
}

async function entries(path: string): Promise<string[] | undefined> {
  try { return (await readdir(path)).sort() }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
}

for (const [windowsConfig, name] of [
  ["appdata", "default Windows profile saves and survives server restart"],
  ["override", "literal Windows config paths round-trip"],
] as const) {
  test(name, { timeout: 120000 }, async t => {
    await using f = await createFixture(pathToFileURL(PREDICTIONS_PACKAGE!).href, {}, {}, {
      windowsConfig, projectConfig: true, seedPreferences: false,
    })
    const root = windowsConfig === "appdata" ? APPDATA! : join(f.root, "O'Brien [测试]")
    const source = join(root, "opencode", "predictions.json")
    const config = join(f.directory, "opencode.jsonc")
    const configBytes = await readFile(config)
    const beforeRoot = await entries(root), beforeDir = await entries(dirname(source))
    await assert.rejects(readFile(source), { code: "ENOENT" })
    assert.equal(f.env.OPENCODE_DISABLE_PROJECT_CONFIG, undefined)
    assert.equal(f.env.XDG_CONFIG_HOME, windowsConfig === "appdata" ? undefined : root)
    const version = (await f.api.server.info()).version
    t.diagnostic(`Native Windows OpenCode ${version}`)
    assert.equal(version, "2.2.6")

    const location = { directory: f.directory }
    const read = async () => await f.api.rpc(Predictions).settingsV2({}, { location }) as SetupSnapshot
    const before = await read()
    assert.deepEqual(await entries(root), beforeRoot)
    assert.deepEqual(await entries(dirname(source)), beforeDir)
    assert.equal(before.source, source)
    assert.equal(before.writable, true, before.reason ?? "The Windows server must permit first Save.")

    const save = await f.api.rpc(Predictions).saveSettings({ revision: before.revision, fields: { automatic: false } }, { location }) as SaveResult
    assert.equal(save.kind, "saved", JSON.stringify(save))
    assert.deepEqual(JSON.parse(await readFile(source, "utf8")), { version: 1, settings: { automatic: false } })
    const saved = await read()
    assert.equal(saved.activeRevision, saved.revision)
    assert.equal(saved.revision, save.revision)
    assert.deepEqual(await readFile(config), configBytes)

    const prior = JSON.stringify({ version: 1, future: "keep", settings: { automatic: false } }) + "\n"
    await writeFile(source, prior)
    const edited = await read()
    const second = await f.api.rpc(Predictions).saveSettings({ revision: edited.revision, fields: { debug: true } }, { location }) as SaveResult
    assert.equal(second.kind, "saved", JSON.stringify(second))
    assert.equal(await readFile(source + ".backup", "utf8"), prior)
    assert.deepEqual(JSON.parse(await readFile(source, "utf8")), { version: 1, future: "keep", settings: { automatic: false, debug: true } })
    assert.deepEqual(await readFile(config), configBytes)

    await f.restart()
    const restarted = await read()
    assert.equal(restarted.activeRevision, restarted.revision)
    assert.equal(restarted.effective?.automatic, false)
    assert.equal(restarted.effective?.debug, true)
    assert.deepEqual(f.calls, [])
  })
}
