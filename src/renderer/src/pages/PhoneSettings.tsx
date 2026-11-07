import { useEffect, useRef, useState } from 'react'
import { sessionTitle, type CompanionPairing, type CompanionStatus } from '@shared/companion'
import { errorMessage, formatAge, formatClock } from '../format'

// Settings → Phone: turn the phone companion on, pair phones with a QR code,
// and remove them again.

const KIND_LABEL = { home: 'Home network', tailscale: 'Tailscale', other: 'Other' } as const

export default function PhoneSettings(): JSX.Element | null {
  const [status, setStatus] = useState<CompanionStatus | null>(null)
  const [pairing, setPairing] = useState<CompanionPairing | null>(null)
  const [pick, setPick] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [paired, setPaired] = useState<string | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)
  const [now, setNow] = useState(Date.now())
  /** Devices there when the code was made: a new one is the phone that paired */
  const before = useRef<Set<number>>(new Set())
  const pairingRef = useRef<CompanionPairing | null>(null)
  pairingRef.current = pairing

  useEffect(() => {
    window.api.getCompanion().then(setStatus)
    return window.api.onCompanionUpdate(setStatus)
  }, [])

  // Leaving Settings drops a code nobody used.
  useEffect(
    () => () => {
      if (pairingRef.current) void window.api.cancelPairing()
    },
    []
  )

  // The code was used, ran out of tries, or the companion was turned off.
  useEffect(() => {
    if (!pairing || !status) return
    if (status.pairing?.code === pairing.code) return
    const added = status.devices.find((d) => !before.current.has(d.id))
    if (added) setPaired(added.name)
    setPairing(null)
  }, [status, pairing])

  useEffect(() => {
    if (!pairing) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pairing])
  const left = pairing ? Math.max(0, pairing.expiresAt - now) : 0
  useEffect(() => {
    if (pairing && left === 0) setPairing(null)
  }, [pairing, left])

  if (!status) return null

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const pair = (): Promise<void> =>
    run(async () => {
      before.current = new Set(status.devices.map((d) => d.id))
      setPaired(null)
      const p = await window.api.pairPhone()
      // Tailscale reaches the PC at home and away, so the phone keeps one address.
      const ts = p.links.findIndex((l) => l.address.kind === 'tailscale')
      setPick(ts >= 0 ? ts : 0)
      setNow(Date.now())
      setPairing(p)
    })

  const link = pairing?.links[Math.min(pick, pairing.links.length - 1)]

  return (
    <section className="phone-settings">
      <h2>Phone</h2>
      <label className="inline">
        <input
          type="checkbox"
          checked={status.enabled}
          disabled={busy}
          onChange={(e) => void run(() => window.api.setCompanionEnabled(e.target.checked).then(setStatus))}
        />
        <span>Let my phone use Swarmplay</span>
      </label>
      <small className="muted block">
        Browse the library on your phone and watch in VLC. This PC does the streaming, so it stays on while you watch.
      </small>
      {status.error && <small className="error-text block">{status.error}</small>}

      <label className="indented">
        <span>Port</span>
        <input
          type="number"
          className="short"
          min={1024}
          max={65535}
          key={status.port}
          defaultValue={status.port}
          onBlur={(e) => {
            const v = Math.round(Number(e.target.value))
            if (v === status.port) return
            void run(async () => {
              try {
                setStatus(await window.api.setCompanionPort(v))
              } catch (err) {
                e.target.value = String(status.port)
                throw err
              }
            })
          }}
        />
      </label>

      {status.session && (
        <div className="phone-playing">
          <span>
            Playing on <b>{status.session.deviceName}</b>: {sessionTitle(status.session)}
            {status.session.starting && <span className="muted"> (getting it ready)</span>}
          </span>
          <button onClick={() => void run(() => window.api.stopPhone())}>Stop</button>
        </div>
      )}

      {status.running && (
        <div className="pairing">
          {!pairing ? (
            <button className="primary" disabled={busy} onClick={() => void pair()}>
              Pair a phone
            </button>
          ) : link ? (
            <div className="pair-box">
              <div className="qr" dangerouslySetInnerHTML={{ __html: link.qrSvg }} />
              <div className="pair-info">
                <div className="muted">Scan with the phone's camera, or open the address and type the code.</div>
                <div className="pair-code">
                  {pairing.code.slice(0, 4)} {pairing.code.slice(4)}
                </div>
                <div className="pair-url">{link.url.replace(/#.*$/, '')}</div>
                {pairing.links.length > 1 && (
                  <select value={pick} onChange={(e) => setPick(Number(e.target.value))}>
                    {pairing.links.map((l, i) => (
                      <option key={l.url} value={i}>
                        {KIND_LABEL[l.address.kind]}: {l.address.address} ({l.address.adapter})
                      </option>
                    ))}
                  </select>
                )}
                <div className="muted">Works once. Expires in {formatClock(left / 1000)}.</div>
                <div className="row">
                  <button
                    onClick={() => {
                      setPairing(null)
                      void window.api.cancelPairing()
                    }}
                  >
                    Cancel
                  </button>
                  <button disabled={busy} onClick={() => void pair()}>
                    New code
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <small className="error-text block">
              This PC has no network address a phone could use. Connect to Wi-Fi or start Tailscale, then try again.
            </small>
          )}
          {paired && !pairing && <small className="green-text block">{paired} is paired.</small>}
        </div>
      )}
      {error && <small className="error-text block">{error}</small>}

      {status.devices.length > 0 && (
        <div className="devices">
          <div className="devices-head">
            <b>Paired phones</b>
            {status.devices.length > 1 &&
              (confirmAll ? (
                <span className="row">
                  <span className="muted">Remove every phone?</span>
                  <button
                    className="danger"
                    onClick={() => {
                      setConfirmAll(false)
                      void run(() => window.api.removeAllPhones())
                    }}
                  >
                    Remove all
                  </button>
                  <button onClick={() => setConfirmAll(false)}>Cancel</button>
                </span>
              ) : (
                <button onClick={() => setConfirmAll(true)}>Remove all</button>
              ))}
          </div>
          <ul>
            {status.devices.map((d) => (
              <li key={d.id}>
                <div>
                  <div>{d.name}</div>
                  <small className="muted">
                    Paired {new Date(d.createdAt).toLocaleDateString()}
                    {d.lastSeenAt != null && ` · last used ${formatAge(new Date(d.lastSeenAt).toISOString())}`}
                    {d.lastIp && ` from ${d.lastIp}`}
                  </small>
                </div>
                <button onClick={() => void run(() => window.api.removePhone(d.id))}>Remove</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="phone-howto">
        <summary>How it works</summary>
        <ul>
          <li>
            The phone needs to reach this PC: on the same Wi-Fi, or from anywhere with{' '}
            <a href="https://tailscale.com/download" target="_blank" rel="noreferrer">
              Tailscale
            </a>{' '}
            on both. Pairing decides which phones may use it; remove a phone here to lock it out at once.
          </li>
          <li>
            Phone can't connect? Check it's on the same Wi-Fi, then check Windows Firewall. Windows marks each network
            Private or Public, and home Wi-Fi is often marked Public. Set yours to Private (Windows Settings → Network &
            internet → Wi-Fi → your network's properties), then allow Swarmplay on Private networks (Windows Security →
            Firewall & network protection → Allow an app through firewall). Leave Public unticked, so Swarmplay can't be
            reached on café or airport Wi-Fi.
          </li>
          <li>
            Each address pairs on its own. The Tailscale address works at home too, so pairing with it gives the phone one
            address for everywhere.
          </li>
          <li>On the home network the connection isn't encrypted; through Tailscale it is.</li>
          <li>Videos open in VLC for iOS (free on the App Store). Infuse, or copying the link, also works.</li>
          <li>Adding the page to the Home Screen? It keeps its own sign-in, so pair again inside it with a new code.</li>
        </ul>
      </details>
    </section>
  )
}
