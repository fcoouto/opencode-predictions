export type Composer = { text(): string; focused(): boolean; quotable(): boolean; setText(text: string): void; focus(): void }
// DOM anchoring is the only private Desktop surface; draft writes use the host Composer API.
export function createDesktopAdapter(document: Document, composer: () => Composer | undefined) {
  const window = document.defaultView!
  let composing = false
  let overlay: HTMLDivElement | undefined
  let placeholder: HTMLElement | undefined
  let originalVisibility = ""
  const visible = (element: Element) => element.getClientRects().length > 0 && window.getComputedStyle(element).visibility !== "hidden"
  const anchor = (): HTMLElement | undefined => {
    const matches = [...document.querySelectorAll<HTMLElement>('[data-component="composer-editor"][contenteditable="true"]')].filter(visible)
    return matches.length === 1 && matches[0] === document.activeElement ? matches[0] : undefined
  }
  const clear = () => {
    overlay?.remove(); overlay = undefined
    if (placeholder?.style.visibility === "hidden") placeholder.style.visibility = originalVisibility
    placeholder = undefined
  }
  const eligible = () => {
    const current = composer()
    const element = anchor()
    const selection = document.getSelection()
    return !!current && !!element && !composing && current.quotable() && current.focused() && current.text() === "" && !(element.textContent ?? "").replace(/\u200B/g, "") && (!selection || selection.isCollapsed) &&
      ![...document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"], [data-component="composer-suggestions"]')].some(visible)
  }
  const compositionStart = () => { composing = true; clear() }
  const compositionEnd = () => { composing = false }
  document.addEventListener("compositionstart", compositionStart, true)
  document.addEventListener("compositionend", compositionEnd, true)
  return {
    eligible,
    read: () => composer()?.text() ?? "",
    paint(text: string | undefined): boolean {
      if (!text || !eligible()) { clear(); return false }
      const element = anchor()!
      const bounds = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      if (!overlay) {
        overlay = document.createElement("div")
        overlay.setAttribute("data-opencode-prediction", "")
        overlay.setAttribute("aria-hidden", "true")
        document.body.append(overlay)
        const next = element.nextElementSibling as HTMLElement | null
        if (next && window.getComputedStyle(next).pointerEvents === "none") {
          placeholder = next; originalVisibility = next.style.visibility; next.style.visibility = "hidden"
        }
      }
      overlay.textContent = text
      Object.assign(overlay.style, {
        position: "fixed", pointerEvents: "none", userSelect: "none", zIndex: "20", overflow: "hidden",
        left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px`,
        boxSizing: "border-box", padding: style.padding, font: style.font, lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing, direction: style.direction, textAlign: style.textAlign, whiteSpace: "pre-wrap",
        color: "var(--v2-text-text-muted, #888)", opacity: "0.7",
      })
      return true
    },
    insert(text: string): boolean {
      if (!eligible()) return false
      const current = composer()!
      clear()
      current.setText(text)
      current.focus()
      return true
    },
    dispose() {
      clear()
      document.removeEventListener("compositionstart", compositionStart, true)
      document.removeEventListener("compositionend", compositionEnd, true)
    },
  }
}
