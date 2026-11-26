import { build } from "esbuild"
import { build as viteBuild } from "vite"
import { gui } from "@opencode/plugin/gui/vite"
import { chmod, mkdir } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { join, resolve } from "node:path"

if (process.platform === "win32" && process.arch === "x64") {
  if (!process.env.SystemRoot) throw new Error("SystemRoot is required to build the Windows verifier.")
  await mkdir("dist", { recursive: true })
  const csc = join(process.env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe")
  execFileSync(csc, ["/nologo", "/optimize+", "/platform:x64", "/target:exe", `/out:${resolve("dist/predictions-verifier.exe")}`, resolve("src/preferences-windows.cs")], { stdio: "inherit" })
}

await build({ entryPoints: ["src/index.ts", "src/tui.ts", "src/rpc.ts", "src/pilot.ts"], outdir: "dist", bundle: true, format: "esm", platform: "node", target: "es2023", packages: "external", sourcemap: true })
await viteBuild({ configFile: false, plugins: [gui({ entry: "src/gui.ts", outFile: "dist/gui-experimental.cjs" })] })
await chmod("dist/pilot.js", 0o755)
