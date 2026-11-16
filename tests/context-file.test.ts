import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { homedir, tmpdir } from "node:os"
import { join, relative } from "node:path"
import { readContextFile } from "../src/context-file.ts"

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "prediction-context-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, path: join(directory, "preferences.md"), signal: new AbortController().signal }
}

test("context reader preserves UTF-8 Markdown and expands explicit home-relative paths", async t => {
  const f = await fixture(t)
  const text = "# Preferences\n日本語 😀\nUse XLSX.\n"
  await writeFile(f.path, text)
  assert.equal(await readContextFile(f.path, f.signal), text)
  assert.equal(await readContextFile("~/" + relative(homedir(), f.path), f.signal), text)
  await writeFile(f.path, " \t\r\n")
  assert.equal(await readContextFile(f.path, f.signal), "")
  await writeFile(f.path, "")
  assert.equal(await readContextFile(f.path, f.signal), "")
})

test("context reader accepts 8192 UTF-8 bytes and rejects an extra byte without truncating", async t => {
  const f = await fixture(t)
  const text = "😀".repeat(2048)
  await writeFile(f.path, text)
  assert.equal(await readContextFile(f.path, f.signal), text)
  await writeFile(f.path, text + "x")
  await assert.rejects(readContextFile(f.path, f.signal), { code: "context_file_too_large" })
})

test("context reader rejects missing, directory, relative, invalid UTF-8 and binary inputs", async t => {
  const f = await fixture(t)
  await assert.rejects(readContextFile(f.path, f.signal))
  await assert.rejects(readContextFile(f.directory, f.signal))
  await assert.rejects(readContextFile("preferences.md", f.signal))
  for (const text of [Buffer.from([0xc3, 0x28]), Buffer.from("hello\u0000"), Buffer.from("hello\u001b[2J"), Buffer.from("hello\u009b")]) {
    await writeFile(f.path, text)
    await assert.rejects(readContextFile(f.path, f.signal), { code: "context_file_invalid" })
  }
  await writeFile(f.path, "Recovered.")
  assert.equal(await readContextFile(f.path, f.signal), "Recovered.")
})

test("context reader rejects named pipes without waiting for a writer", { skip: process.platform === "win32", timeout: 1000 }, async t => {
  const f = await fixture(t)
  execFileSync("mkfifo", [f.path])
  await assert.rejects(readContextFile(f.path, f.signal))
})

test("context reader honors cancellation before opening a file", async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(readContextFile(f.path, controller.signal), { name: "AbortError" })
})
