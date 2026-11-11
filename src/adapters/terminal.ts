import type { TextareaRenderable } from "@opentui/core"

// Host editor access is private to this adapter; the native placeholder never becomes draft text.
export function createTerminalAdapter(renderer: { readonly currentFocusedEditor: unknown }) {
  let painted: TextareaRenderable | undefined
  let original: TextareaRenderable["placeholder"]
  let ghost: string | undefined
  const editor = (): TextareaRenderable | undefined => {
    const value = renderer.currentFocusedEditor as TextareaRenderable | null
    if (!value || typeof value.plainText !== "string" || typeof value.insertText !== "function" || !("placeholder" in value)) return
    const traits = value.traits as { owner?: string; role?: string; status?: string; capture?: readonly string[] } | undefined
    if (traits?.owner !== "opencode" || traits.role !== "prompt" || traits.status || traits.capture?.length !== 1 || traits.capture[0] !== "tab") return
    return value
  }
  const clear = () => {
    if (painted && painted.placeholder === ghost) painted.placeholder = original
    painted = undefined
    ghost = undefined
  }
  return {
    eligible: () => editor()?.plainText === "",
    read: () => editor()?.plainText ?? "",
    paint(text: string | undefined): boolean {
      const current = editor()
      if (!text || !current || current.plainText !== "") { clear(); return false }
      if (painted !== current) { clear(); painted = current; original = current.placeholder }
      ghost = text
      if (current.placeholder !== text) current.placeholder = text
      return true
    },
    insert(text: string): boolean {
      const current = editor()
      if (!current || current.plainText !== "") return false
      clear()
      current.insertText(text)
      return true
    },
    dispose: clear,
  }
}
