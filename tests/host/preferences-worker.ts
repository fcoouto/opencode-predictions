import { join } from "node:path"
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { createPreferencesStore } from "../../src/preferences-store.ts"

const [home, phase, fields] = process.argv.slice(2)
const file = join(home, "config", "opencode", "predictions.json")
const store = createPreferencesStore({ home, platform: process.platform, env: { XDG_CONFIG_HOME: join(home, "config") }, systemPaths: [join(home, "managed")] })
const original = fs.rename
fs.rename = async (from, to) => {
  if (String(to) === file && phase === "prepared") await pause()
  await original(from, to)
  if (String(to) === file && phase === "committed") await pause()
}
syncBuiltinESMExports()
async function pause() {
  await new Promise<void>(resolve => { process.once("message", () => resolve()); process.send!({ phase }) })
}
const snapshot = await store.read(new AbortController().signal)
const result = await store.write(snapshot.revision, { fields: JSON.parse(fields) }, new AbortController().signal)
process.send!({ result }, () => process.disconnect!())
