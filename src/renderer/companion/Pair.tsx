import { useState } from 'react'
import { ApiError, errorText, post } from './api'

// Pairing: the PC's QR code opens /pair#CODE with the code filled in. The code
// can also be typed, which a Home Screen web app needs on iOS: it keeps its own
// cookies, apart from Safari's, so it pairs on its own.

function defaultName(): string {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad'
  if (/Android/.test(ua)) return 'Android phone'
  return 'Phone'
}

function codeFromHash(): string {
  const h = location.hash.replace(/^#/, '')
  return /^[A-Za-z0-9-]{8,9}$/.test(h) ? h.toUpperCase() : ''
}

export function standalone(): boolean {
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  )
}

export default function Pair({ removed, onPaired }: { removed: boolean; onPaired: () => void }): JSX.Element {
  const [name, setName] = useState(defaultName)
  const [code, setCode] = useState(codeFromHash)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await post('/api/pair', { code, name })
      onPaired()
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'bad-code' ? "That code didn't work. Check it, or make a new one on the PC." : errorText(err))
      setBusy(false)
    }
  }

  return (
    <div className="pair">
      <img className="pair-icon" src="/apple-touch-icon.png" alt="" width={72} height={72} />
      <h1>Pair with Swarmplay</h1>
      {removed ? (
        <p className="note warn">This phone was removed on the PC, or its pairing ran out. Pair it again.</p>
      ) : (
        <p className="muted">
          On the PC, open <strong>Settings → Phone</strong> and choose <strong>Pair a phone</strong>. Scan the QR code, or type
          the code here.
        </p>
      )}
      <form onSubmit={(e) => void submit(e)}>
        <label>
          <span>Pairing code</span>
          <input
            className="code-input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            autoCapitalize="characters"
            autoComplete="one-time-code"
            autoCorrect="off"
            spellCheck={false}
            maxLength={12}
            placeholder="ABCD2345"
            required
          />
        </label>
        <label>
          <span>Name this phone</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoCorrect="off" />
        </label>
        {error && <p className="note error">{error}</p>}
        <button className="primary big" type="submit" disabled={busy || code.replace(/[\s-]/g, '').length < 8}>
          {busy ? 'Pairing…' : 'Pair'}
        </button>
      </form>
      <p className="muted small">
        The code works once, for 5 minutes. The PC lists each paired phone in Settings, where you can remove it.
      </p>
      {!standalone() && (
        <p className="muted small">
          To open Swarmplay like an app, tap Share, then <strong>Add to Home Screen</strong>. The Home Screen app keeps its own
          sign-in, so make a new code on the PC and type it in there.
        </p>
      )}
    </div>
  )
}
