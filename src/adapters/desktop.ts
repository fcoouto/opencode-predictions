import { communicationText, type Communication } from "../controller.ts"

export type Composer = { text(): string; focused(): boolean; quotable(): boolean; setText(text: string): void; focus(): void }
// DOM anchoring is the only private Desktop surface; draft writes use the host Composer API.
export function createDesktopAdapter(document: Document, composer: () => Composer | undefined) {
  const window = document.defaultView!
  let composing = false
  let overlay: HTMLDivElement | undefined
  let status = false
  let announcement: HTMLDivElement | undefined
  let placeholder: HTMLElement | undefined
  let originalVisibility = ""
  let sizing: { element: HTMLElement; value: string; priority: string; applied: string; minimum: number } | undefined
  let resize: ResizeObserver | undefined
  const visible = (element: Element) => element.getClientRects().length > 0 && window.getComputedStyle(element).visibility !== "hidden"
  const anchor = (focused = true): HTMLElement | undefined => {
    const matches = [...document.querySelectorAll<HTMLElement>('[data-component="composer-editor"][contenteditable="true"]')].filter(visible)
    return matches.length === 1 && (!focused || matches[0] === document.activeElement) ? matches[0] : undefined
  }
  const clear = () => {
    resize?.disconnect(); resize = undefined
    overlay?.remove(); overlay = undefined
    if (sizing && sizing.element.style.minHeight === sizing.applied && sizing.element.style.getPropertyPriority("min-height") === "important") {
      if (sizing.value) sizing.element.style.setProperty("min-height", sizing.value, sizing.priority)
      else sizing.element.style.removeProperty("min-height")
    }
    sizing = undefined
    if (placeholder?.style.visibility === "hidden") placeholder.style.visibility = originalVisibility
    placeholder = undefined
  }
  const announce = (message: string) => {
    if (!announcement) {
      announcement = document.createElement("div")
      announcement.setAttribute("data-opencode-announcement", "")
      announcement.setAttribute("role", "status")
      announcement.setAttribute("aria-live", "polite")
      Object.assign(announcement.style, { position: "fixed", width: "1px", height: "1px", overflow: "hidden", clipPath: "inset(50%)" })
      document.body.append(announcement)
    }
    if (announcement.textContent !== message) announcement.textContent = message
  }
  const eligible = () => {
    const current = composer()
    const element = anchor()
    const selection = document.getSelection()
    return !!current && !!element && !composing && current.quotable() && current.focused() && current.text() === "" && !(element.textContent ?? "").replace(/\u200B/g, "") && (!selection || selection.isCollapsed) &&
      ![...document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"], [data-component="composer-suggestions"]')].some(visible)
  }
  const draw = (text: string, isStatus: boolean): boolean => {
    const element = anchor(!isStatus)
    if (!element || composing || !composer()?.quotable() || composer()?.text() || (!isStatus && !eligible())) { clear(); return false }
    if (!isStatus && status) announce("Prediction ready.")
    if (overlay && (status !== isStatus || (sizing && sizing.element !== element))) clear()
    if (sizing && (element.style.minHeight !== sizing.applied || element.style.getPropertyPriority("min-height") !== "important")) sizing = undefined
    status = isStatus
    const bounds = element.getBoundingClientRect()
    const style = window.getComputedStyle(element)
    if (!overlay) {
      overlay = document.createElement("div")
      overlay.setAttribute(isStatus ? "data-opencode-communication" : "data-opencode-prediction", "")
      overlay.setAttribute("aria-hidden", "true")
      const visual = document.createElement("span")
      visual.setAttribute("aria-hidden", "true")
      overlay.append(visual)
      document.body.append(overlay)
      const next = element.nextElementSibling as HTMLElement | null
      if (next && window.getComputedStyle(next).pointerEvents === "none") {
        placeholder = next; originalVisibility = next.style.visibility; next.style.visibility = "hidden"
      }
    }
    const visual = overlay.firstElementChild as HTMLElement
    if (visual.textContent !== text) visual.textContent = text
    if (!isStatus) Object.assign(visual.style, { display: "-webkit-box", webkitBoxOrient: "vertical", webkitLineClamp: "6", overflow: "hidden" })
    Object.assign(overlay.style, {
      position: "fixed", pointerEvents: "none", userSelect: "none", zIndex: "20", overflow: "hidden",
      left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, minHeight: isStatus ? `${bounds.height}px` : "0px",
      boxSizing: "border-box", padding: style.padding, font: style.font, lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing, direction: style.direction, textAlign: style.textAlign, whiteSpace: "pre-wrap", overflowWrap: "anywhere",
      color: "var(--v2-text-text-muted, #888)", opacity: "0.7",
    })
    if (!isStatus) {
      sizing ??= { element, value: element.style.minHeight, priority: element.style.getPropertyPriority("min-height"), applied: "", minimum: bounds.height }
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
      const height = Math.max(sizing.minimum, overlay.getBoundingClientRect().height + border)
      sizing.applied = `${Math.ceil(height - (style.boxSizing === "border-box" ? 0 : padding + border))}px`
      element.style.setProperty("min-height", sizing.applied, "important")
      // Growing a bottom-anchored composer moves the editor; align after reserving space.
      const current = element.getBoundingClientRect()
      Object.assign(overlay.style, { left: `${current.left}px`, top: `${current.top}px`, width: `${current.width}px` })
      if (!resize) {
        resize = new window.ResizeObserver(() => { if (overlay && !status) draw(overlay.textContent ?? "", false) })
        resize.observe(element)
      }
    }
    return true
  }
  const compositionStart = () => { composing = true; clear() }
  const compositionEnd = () => { composing = false }
  const input = (event: Event) => { if (event.target === anchor(false) && overlay) { clear(); announce("Prediction dismissed.") } }
  document.addEventListener("input", input, true)
  document.addEventListener("compositionstart", compositionStart, true)
  document.addEventListener("compositionend", compositionEnd, true)
  return {
    eligible,
    read: () => composer()?.text() ?? "",
    communicate(value: Communication | undefined) {
      const text = value && communicationText(value, window.matchMedia("(prefers-reduced-motion: reduce)").matches, /Mac|iPhone|iPad/.test(window.navigator.platform) ? "Option+Shift+P" : "Alt+Shift+P")
      if (!text) { if (status && overlay) { clear(); announce("Prediction finished.") } return }
      if (draw(text, true) && overlay) {
        const label = value!.activity ? value!.activity.kind === "alternative" ? `Requesting prediction from ${value!.activity.name}.` : "Requesting prediction." : text
        if (overlay.getAttribute("aria-label") !== label) overlay.setAttribute("aria-label", label)
        announce(label)
      }
    },
    paint(text: string | undefined): boolean {
      if (!text) { if (!status) clear(); return false }
      return draw(text, false)
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
      announcement?.remove(); announcement = undefined
      document.removeEventListener("input", input, true)
      document.removeEventListener("compositionstart", compositionStart, true)
      document.removeEventListener("compositionend", compositionEnd, true)
    },
  }
}
