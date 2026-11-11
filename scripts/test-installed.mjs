import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp } from "node:fs/promises"
import { resolve, join } from "node:path"

await mkdir(".test-artifacts", { recursive: true })
const root = await mkdtemp(resolve(".test-artifacts/install-"))
const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], { encoding: "utf8" }))[0]
execFileSync("npm", ["install", "--prefix", root, "--ignore-scripts", "--no-audit", "--no-fund", join(root, packed.filename)], { stdio: "inherit" })
execFileSync(process.execPath, ["--test", "tests/host/server.test.ts", "tests/host/terminal.test.ts", "tests/host/desktop.test.ts", "tests/host/git.test.ts"], { stdio: "inherit", env: { ...process.env, PREDICTIONS_PACKAGE: join(root, "node_modules", "opencode-predictions") } })
console.log("Installed artifact verified:", packed.filename)
