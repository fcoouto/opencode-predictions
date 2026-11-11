import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { cp, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createFixture } from "./fixture.mjs"

test("OpenCode installs prebuilt Git packages without invoking dependency preparation", { timeout: 180000 }, async () => {
  const packagePath = process.env.PREDICTIONS_PACKAGE ?? resolve(".")
  await using fixture = await createFixture(packagePath)
  const repository = join(fixture.root, "git-package")
  await mkdir(repository)
  for (const file of ["package.json", "README.md", "LICENSE", "dist"]) await cp(join(packagePath, file), join(repository, file), { recursive: true })
  const run = promisify(execFile)
  await run("git", ["init", "-b", "main"], { cwd: repository })
  await run("git", ["add", "."], { cwd: repository })
  await run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Fixture"], { cwd: repository })
  const { stdout } = await run(process.env.OPENCODE_BIN ?? "opencode", ["plugin", "add", `git+file://${repository}#main`], { cwd: fixture.directory, env: { ...fixture.env, npm_config_fetch_retries: "0", npm_config_fetch_timeout: "20000" }, timeout: 150000, maxBuffer: 1024 * 1024 })
  assert.match(stdout, /installed and added/)
})
