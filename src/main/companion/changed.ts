// Something the PC shows about the companion changed: a session, a device, a code.
// One listener (companion/index.ts) turns it into a companion:update for the window.

let listener: (() => void) | null = null

export function onCompanionChange(fn: () => void): void {
  listener = fn
}

export function companionChanged(): void {
  listener?.()
}
