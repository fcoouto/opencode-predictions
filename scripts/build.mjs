import { build } from "esbuild"
import { build as viteBuild } from "vite"
import { gui } from "@opencode/plugin/gui/vite"
import { chmod } from "node:fs/promises"

await build({ entryPoints: ["src/index.ts", "src/tui.ts", "src/rpc.ts", "src/pilot.ts"], outdir: "dist", bundle: true, format: "esm", platform: "node", target: "es2023", packages: "external", sourcemap: true })
await viteBuild({ configFile: false, plugins: [gui({ entry: "src/gui.ts", outFile: "dist/gui-experimental.cjs" })] })
await chmod("dist/pilot.js", 0o755)
