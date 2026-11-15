import { createCandidate, type ProbeHost } from "./persistence-candidate.ts"

process.once("message", async (input: { host: ProbeHost; revision: string; patch: Record<string, unknown>; hold: boolean }) => {
  try {
    const store = createCandidate(input.host, { afterLock: async () => {
      process.send!({ kind: "locked" })
      if (input.hold) await new Promise(resolve => process.once("message", resolve))
    } })
    process.send!({ kind: "started" })
    process.send!({ kind: "result", result: await store.write(input.revision, input.patch) })
    process.disconnect!()
  } catch (error) { console.error(error); process.exit(1) }
})
