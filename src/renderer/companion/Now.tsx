import { useCallback, useEffect, useRef, useState } from 'react'
import type { PhoneNow, PhoneSession } from '@shared/companion'
import { RESUME_MIN_SEC } from '@shared/types'
import { formatClock, formatSpeed } from '../src/format'
import { get, post } from './api'
import type { Pending, PlayRequest } from './App'
import { copyText, infuseLink, vlcPlainLink } from './vlc'

// Now playing: what the PC is sending this phone, polled every 2 s while the
// screen is in view, with the links that open it in VLC.

const POLL_MS = 2000

interface Props {
  active: boolean
  pending: Pending | null
  onClearPending: () => void
  onPlay: (req: PlayRequest, title: string) => Promise<void>
  onNext: () => Promise<void>
  onError: (err: unknown) => string
}

type Ended = NonNullable<PhoneNow['ended']>

export default function Now({ active, pending, onClearPending, onPlay, onNext, onError }: Props): JSX.Element {
  const [now, setNow] = useState<PhoneNow | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      setNow(await get<PhoneNow>('/api/now'))
      setError(null)
    } catch (err) {
      setError(onError(err))
    } finally {
      inFlight.current = false
    }
  }, [onError])

  useEffect(() => {
    if (!active) return
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, POLL_MS)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [active, load])

  // The PC has answered a Play: show its session from here on.
  useEffect(() => {
    if (!pending?.result) return
    get<PhoneNow>('/api/now').then(
      (n) => {
        setNow(n)
        onClearPending()
      },
      () => onClearPending()
    )
  }, [pending?.result, onClearPending])

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setActionError(null)
    try {
      await fn()
    } catch (err) {
      setActionError(onError(err))
    }
    await load()
  }
  const setWatched = (torrentId: number, fileIndex: number, watched: boolean): Promise<void> =>
    act(() => post('/api/watched', { torrentId, fileIndex, watched }))

  let body: JSX.Element
  if (pending && !pending.result && !pending.error) {
    body = (
      <div className="card">
        <p className="spinner" aria-hidden="true" />
        <p>
          Getting <strong>{pending.title}</strong> ready on the PC…
        </p>
        <p className="muted small">A stream can take a minute to find peers.</p>
      </div>
    )
  } else if (pending?.error) {
    body = (
      <div className="card">
        <p className="note error">{pending.error}</p>
        <button className="secondary wide" onClick={onClearPending}>
          OK
        </button>
      </div>
    )
  } else if (now?.session) {
    body = (
      <Session
        s={now.session}
        onStop={() => act(() => post('/api/stop'))}
        onWatched={(w) => setWatched(now.session!.torrentId, now.session!.fileIndex, w)}
        onNext={() => act(onNext)}
      />
    )
  } else if (now?.ended) {
    const e = now.ended
    body = (
      <div className="card">
        <h2 className="ended-title">{e.title}</h2>
        <p className={e.reason === 'error' ? 'note error' : 'muted'}>{endedText(e)}</p>
        <div className="actions">
          {e.next && (
            <button className={e.watched ? 'primary wide' : 'secondary wide'} onClick={() => void act(onNext)}>
              Play next: {e.next.label}
            </button>
          )}
          {e.reason !== 'removed' && (
            <button
              className={e.next && e.watched ? 'secondary wide' : 'primary wide'}
              onClick={() => void onPlay({ torrentId: e.torrentId, fileIndex: e.fileIndex }, e.title)}
            >
              Play again
            </button>
          )}
          {e.reason !== 'removed' && (
            <button className="secondary wide" onClick={() => void setWatched(e.torrentId, e.fileIndex, !e.watched)}>
              {e.watched ? 'Mark as not watched' : 'Mark as watched'}
            </button>
          )}
        </div>
      </div>
    )
  } else {
    body = (
      <div className="card">
        <p className="muted">{now ? 'Nothing is playing on this phone. Pick an episode in Library or Search.' : 'Loading…'}</p>
      </div>
    )
  }

  return (
    <div className="page">
      <h1>Now playing</h1>
      {error && <p className="note error">{error}</p>}
      {now?.busy && !now.session && (
        <p className="note warn">
          {now.busy === 'pc' ? 'The PC is playing something.' : 'Another phone is playing.'} Playing here stops it.
        </p>
      )}
      {body}
      {actionError && <p className="note error">{actionError}</p>}
    </div>
  )
}

function Session({
  s,
  onStop,
  onWatched,
  onNext
}: {
  s: PhoneSession
  onStop: () => Promise<void>
  onWatched: (watched: boolean) => Promise<void>
  onNext: () => Promise<void>
}): JSX.Element {
  const linkInput = useRef<HTMLInputElement>(null)
  const [copied, setCopied] = useState<boolean | null>(null)
  const heading = s.series ?? s.title

  return (
    <div className="card">
      <h2 className="now-series">{heading}</h2>
      {s.episodeLabel && <p className="now-ep">{s.episodeLabel}</p>}
      {s.series && <p className="row-file wrap">{s.title}</p>}

      <p className="small status">{statusText(s)}</p>
      {!s.starting && <BufferBar s={s} />}
      {!s.starting && <p className="small muted">{positionText(s)}</p>}
      {s.subtitles && <p className="small muted">Subtitles: {s.subtitles}. You can pick others in VLC.</p>}
      {!s.starting && s.resumeSec >= RESUME_MIN_SEC && (s.positionSec == null || s.positionSec < s.resumeSec) && (
        <p className="small note">
          You stopped at {formatClock(s.resumeSec)} last time. VLC starts from the beginning, so drag ahead to{' '}
          {formatClock(s.resumeSec)}.
        </p>
      )}

      {s.vlcUrl && (
        <>
          <a className="button primary big" href={s.vlcUrl}>
            Open in VLC
          </a>
          <p className="small muted">
            Needs{' '}
            <a href="https://apps.apple.com/app/vlc-media-player/id650377962" target="_blank" rel="noreferrer">
              VLC media player
            </a>{' '}
            by VideoLAN, free on the App Store. Without it, Safari says the address is invalid.
          </p>
        </>
      )}
      {s.url && (
        <details className="other-players">
          <summary>Other ways to open it</summary>
          <a className="button secondary wide" href={vlcPlainLink(s.url)}>
            VLC, with its plain link
          </a>
          <a className="button secondary wide" href={infuseLink(s.url)}>
            Infuse
          </a>
          <div className="copy">
            <input ref={linkInput} readOnly value={s.url} aria-label="Video link" onFocus={(e) => e.target.select()} />
            <button
              className="secondary"
              onClick={() => void copyText(s.url!, linkInput.current).then((ok) => setCopied(ok))}
            >
              Copy link
            </button>
          </div>
          {copied === true && <p className="small green">Copied. Paste it into any player that opens network streams.</p>}
          {copied === false && <p className="small muted">Select the link above and copy it.</p>}
          <p className="small muted">The link works only for this phone, until it's removed on the PC.</p>
        </details>
      )}

      <div className="actions">
        {s.next && (
          <button className="secondary wide" onClick={() => void onNext()}>
            Next: {s.next.label}
          </button>
        )}
        <button className="secondary wide" onClick={() => void onWatched(!s.watched)}>
          {s.watched ? 'Mark as not watched' : 'Mark as watched'}
        </button>
        <button className="danger wide" onClick={() => void onStop()}>
          Stop
        </button>
      </div>
    </div>
  )
}

function statusText(s: PhoneSession): string {
  if (s.starting) return 'Getting it ready on the PC…'
  const vlc = s.connections > 0 ? 'VLC is reading it' : 'Waiting for VLC: tap Open in VLC'
  if (s.local) return `From the PC's disk · ${vlc}`
  const peers = `${s.numPeers} peer${s.numPeers === 1 ? '' : 's'}`
  return `Streaming · ${peers} · ${formatSpeed(s.downloadSpeed)} · ${vlc}`
}

function positionText(s: PhoneSession): string {
  if (s.positionSec != null && s.durationSec) return `About ${formatClock(s.positionSec)} of ${formatClock(s.durationSec)}`
  if (s.durationSec) return `${formatClock(s.durationSec)} long`
  return `VLC has read ${Math.round(s.readTo * 100)}% of the file`
}

function BufferBar({ s }: { s: PhoneSession }): JSX.Element {
  return (
    <div
      className="buffer"
      role="img"
      aria-label={`Fetched ${Math.round(s.fetched.reduce((n, [a, b]) => n + (b - a), 0) * 100)}% of the file`}
    >
      {s.fetched.map(([from, to], i) => (
        <span key={i} className="buffer-part" style={{ left: `${from * 100}%`, width: `${(to - from) * 100}%` }} />
      ))}
      {s.connections > 0 && <span className="buffer-head" style={{ left: `${s.readTo * 100}%` }} />}
    </div>
  )
}

function endedText(e: Ended): string {
  switch (e.reason) {
    case 'stop':
      return 'Stopped.'
    case 'takeover':
      return e.by === 'pc'
        ? 'The PC started playing something, so this stopped.'
        : 'Another phone started playing, so this stopped.'
    case 'removed':
      return 'This episode was removed from the library on the PC.'
    case 'grace':
      return 'VLC stopped reading the video, so after a few minutes the PC stopped sending it.'
    case 'idle':
      return 'VLC sat paused for a long time, so the PC stopped sending the video.'
    case 'quit':
      return 'Swarmplay was closed on the PC.'
    case 'error':
      return `It couldn't play: ${e.error ?? 'something went wrong on the PC.'}`
  }
}
