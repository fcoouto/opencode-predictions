import type { ModelRef } from "./options.ts"
export type CatalogModel = { providerID: string; id: string; name?: string; enabled: boolean; variants: readonly { id: string }[] }
export type Candidate = ModelRef & { name: string }
export function resolveModels(selectors: string, catalog: readonly CatalogModel[]): Candidate[] {
  const candidates: Candidate[] = []
  const seen = new Set<string>()
  const glob = (pattern: string) => new RegExp("^" + pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "iu")
  const sorted = [...catalog].sort((a, b) => (a.providerID + "/" + a.id).localeCompare(b.providerID + "/" + b.id, "en"))
  for (const entry of selectors.split(",")) {
    const [selector, variant] = entry.trim().split("#")
    const slash = selector.indexOf("/")
    const provider = glob(selector.slice(0, slash))
    const name = glob(selector.slice(slash + 1))
    for (const model of sorted) {
      const key = model.providerID + "/" + model.id + "#" + (variant ?? "")
      if (seen.has(key) || !model.enabled || !provider.test(model.providerID) || !(name.test(model.id) || name.test(model.name ?? model.id)) || (variant !== undefined && !model.variants.some(item => item.id === variant))) continue
      seen.add(key)
      candidates.push({ providerID: model.providerID, id: model.id, name: model.name ?? model.id, ...(variant === undefined ? {} : { variant }) })
    }
  }
  return candidates
}
