import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { basename, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { windowsScript } from "../../src/preferences-windows-script.ts"

const [stage, compiler, serialization] = process.argv.slice(2)
const checkOnly = stage === "--check"
assert.ok(checkOnly || process.platform === "win32" && process.env.GITHUB_ACTIONS === "true"
  && isAbsolute(stage) && /^predictions-ci-[a-f0-9]{32}$/.test(basename(stage))
  && isAbsolute(compiler) && isAbsolute(serialization), "Use this experiment only on the disposable Windows runner.")

const body = windowsScript.match(/ -TypeDefinition @'\n([\s\S]+?)\n'@/)[1]
const transport = new URL("../../src/preferences-windows.ts", import.meta.url)
const original = await readFile(transport, "utf8")
const launcher = 'spawn(win32.join(powershell, "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", bootstrap], {'
assert.equal(original.split(launcher).length, 2, "Unexpected Windows launcher.")
assert.match(original, /const limit = 65536, wireLimit = 192 \* 1024/)
assert.match(original, /const inputPrefix = "OPENCODE_PREDICTIONS_IO_"/)
assert.match(original, /const inputChunk = 16 \* 1024/)

if (!checkOnly) {
  const source = join(stage, "predictions-verifier.cs")
  const exe = join(stage, "predictions-verifier.exe")
  const cwd = fileURLToPath(new URL("../../", import.meta.url))
  // Keep the same payload and verifier. Replace only the shell entry point.
  await writeFile(source, body + `
public static class TestEntry {
    public static int Main() {
        try {
            var packet = new StringBuilder();
            for (int i = 0; i < 12; i++) {
                var key = "OPENCODE_PREDICTIONS_IO_" + i;
                var value = Environment.GetEnvironmentVariable(key);
                if (value == null) break;
                Environment.SetEnvironmentVariable(key, null);
                packet.Append(value);
            }
            var parts = packet.ToString().Split('\\n');
            if (packet.Length > 192 * 1024 || parts.Length != 2) return 1;
            Console.OutputEncoding = new UTF8Encoding(false);
            Console.WriteLine(PredictionsPreferences.Execute(parts[1]));
            return 0;
        } catch { return 1; }
    }
}
`)
  execFileSync(compiler, ["/nologo", "/optimize+", "/platform:x64", "/target:exe", `/out:${exe}`, `/reference:${serialization}`, source], { stdio: "inherit" })
  try {
    await writeFile(transport, original.replace(launcher, () => `spawn(${JSON.stringify(exe)}, [], {`))
    execFileSync(process.execPath, ["scripts/build.mjs"], { cwd, stdio: "inherit" })
  } finally { await writeFile(transport, original) }
}

console.log(checkOnly ? "Precompiled experiment anchors verified." : "Built an experiment-only bundle and staged its verifier outside the package.")
