// Other ways to open a video URL on the phone. The main Open in VLC link comes
// from the server (VLC's x-callback-url, which streams straight away).

/** VLC's own scheme; VLC may ask whether to play or download */
export function vlcPlainLink(url: string): string {
  return `vlc://${url}`
}

export function infuseLink(url: string): string {
  return `infuse://x-callback-url/play?url=${encodeURIComponent(url)}`
}

/**
 * Copy to the clipboard. The page is plain http on the home network, which
 * isn't a secure context, so the Clipboard API may be missing; then select the
 * text in `input` and use the old copy command.
 */
export async function copyText(text: string, input: HTMLInputElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall back below
  }
  if (!input) return false
  input.focus()
  input.select()
  input.setSelectionRange(0, text.length)
  try {
    return document.execCommand('copy')
  } catch {
    return false
  }
}
