// A release's notes from GitHub, written in Markdown: headings, bulleted and
// numbered lists, paragraphs, **bold**, `code` and [links](https://…). Built
// as React elements, never as HTML, so nothing in the notes can run in the app.
import type { ReactNode } from 'react'

type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }

function parse(md: string): Block[] {
  const blocks: Block[] = []
  let para: string[] = []
  const endPara = (): void => {
    if (para.length) blocks.push({ kind: 'para', text: para.join(' ') })
    para = []
  }
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    const item = /^(?:([-*+])|\d+[.)])\s+(.*)$/.exec(line)
    if (!line) {
      endPara()
    } else if (heading) {
      endPara()
      blocks.push({ kind: 'heading', text: heading[1] })
    } else if (item) {
      endPara()
      const ordered = !item[1]
      const last = blocks[blocks.length - 1]
      if (last?.kind === 'list' && last.ordered === ordered) last.items.push(item[2])
      else blocks.push({ kind: 'list', ordered, items: [item[2]] })
    } else {
      const last = blocks[blocks.length - 1]
      // A wrapped line continues the list item above it.
      if (!para.length && last?.kind === 'list' && /^\s/.test(raw)) last.items[last.items.length - 1] += ' ' + line
      else para.push(line)
    }
  }
  endPara()
  return blocks
}

const INLINE = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let at = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index > at) out.push(text.slice(at, m.index))
    const key = m.index
    if (m[1] != null) out.push(<strong key={key}>{m[1]}</strong>)
    else if (m[2] != null) out.push(<code key={key}>{m[2]}</code>)
    else
      out.push(
        // Opens in the system browser (the main process denies new windows and opens http(s) links outside).
        <a key={key} href={m[4]} target="_blank" rel="noreferrer">
          {m[3]}
        </a>
      )
    at = m.index + m[0].length
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}

export default function ReleaseNotes({ notes }: { notes: string }): JSX.Element {
  return (
    <div className="update-notes">
      {parse(notes).map((b, i) =>
        b.kind === 'heading' ? (
          <h4 key={i}>{inline(b.text)}</h4>
        ) : b.kind === 'para' ? (
          <p key={i}>{inline(b.text)}</p>
        ) : b.ordered ? (
          <ol key={i}>
            {b.items.map((t, j) => (
              <li key={j}>{inline(t)}</li>
            ))}
          </ol>
        ) : (
          <ul key={i}>
            {b.items.map((t, j) => (
              <li key={j}>{inline(t)}</li>
            ))}
          </ul>
        )
      )}
    </div>
  )
}
