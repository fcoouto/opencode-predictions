const prefix = "[opencode-predictions]"

export function log(show: (message: string) => void, message: string) {
  show(message.startsWith(prefix) ? message : `${prefix} ${message}`)
}
