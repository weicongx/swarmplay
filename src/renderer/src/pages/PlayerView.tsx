import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PlayerCommand, PlayerState, PlayerTrack, Upscaler } from '@shared/types'
import { errorMessage, formatClock, formatSpeed, UPSCALERS } from '../format'

const HIDE_CONTROLS_MS = 3000

/**
 * The in-app player. The video itself is mpv drawing into a separate window that
 * the main process keeps exactly over the `.player-video` box, so nothing can be
 * drawn on top of it: status and controls live in the bars around it. That window
 * lets the mouse through, so clicks on the video arrive here as usual.
 */
export default function PlayerView({ state }: { state: PlayerState }): JSX.Element {
  const videoRef = useRef<HTMLDivElement>(null)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [seekPreview, setSeekPreview] = useState<number | null>(null)
  const [idle, setIdle] = useState(false)
  const [nvidia, setNvidia] = useState(false)
  const send = (cmd: PlayerCommand): void => void window.api.playerCommand(cmd)

  useEffect(() => {
    window.api.getPlayerInfo().then((i) => setNvidia(i.nvidia))
  }, [])

  // Click pauses, double-click toggles fullscreen; wait briefly so a double-click
  // doesn't also pause and unpause.
  const onVideoClick = (): void => {
    if (clickTimer.current) clearTimeout(clickTimer.current)
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null
      send({ type: 'toggle-pause' })
    }, 220)
  }
  const onVideoDoubleClick = (): void => {
    if (clickTimer.current) clearTimeout(clickTimer.current)
    clickTimer.current = null
    send({ type: 'fullscreen' })
  }

  // Tell the main process where the video goes, whenever the box moves or resizes.
  useLayoutEffect(() => {
    const el = videoRef.current
    if (!el) return
    const report = (): void => {
      const r = el.getBoundingClientRect()
      window.api.setVideoBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
      window.api.setVideoBounds(null)
    }
  }, [])

  // In fullscreen, hide the bars (and cursor) after a few seconds without mouse movement.
  useEffect(() => {
    if (!state.fullscreen) {
      setIdle(false)
      return
    }
    let timer = setTimeout(() => setIdle(true), HIDE_CONTROLS_MS)
    const wake = (): void => {
      setIdle(false)
      clearTimeout(timer)
      timer = setTimeout(() => setIdle(true), HIDE_CONTROLS_MS)
    }
    window.addEventListener('mousemove', wake)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('mousemove', wake)
    }
  }, [state.fullscreen])

  useEffect(() => () => {
    if (clickTimer.current) clearTimeout(clickTimer.current)
  }, [])

  // Keyboard shortcuts while the page has focus (mpv handles them when the video does).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return
      if (e.target instanceof HTMLSelectElement) return
      const handled: Record<string, () => void> = {
        ' ': () => send({ type: 'toggle-pause' }),
        k: () => send({ type: 'toggle-pause' }),
        ArrowLeft: () => send({ type: 'seek-by', seconds: e.shiftKey ? -30 : -5 }),
        ArrowRight: () => send({ type: 'seek-by', seconds: e.shiftKey ? 30 : 5 }),
        ArrowUp: () => send({ type: 'volume', value: state.volume + 5 }),
        ArrowDown: () => send({ type: 'volume', value: state.volume - 5 }),
        m: () => send({ type: 'toggle-mute' }),
        f: () => send({ type: 'fullscreen' }),
        n: () => state.hasNext && send({ type: 'next' }),
        s: () => state.skip && send({ type: 'skip-chapter' }),
        u: () => {
          // Cycle the upscaler, for quick before/after comparisons.
          const modes = UPSCALERS.filter((x) => x.id !== 'rtx' || nvidia).map((x) => x.id)
          send({ type: 'upscaler', mode: modes[(modes.indexOf(state.upscaler) + 1) % modes.length] })
        },
        Escape: () => (state.fullscreen ? send({ type: 'fullscreen', on: false }) : send({ type: 'close' }))
      }
      const fn = handled[e.key]
      if (fn) {
        e.preventDefault()
        fn()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state.volume, state.fullscreen, state.hasNext, state.skip, state.upscaler, nvidia])

  const duration = state.duration ?? 0
  const shownPos = seekPreview ?? state.timePos
  const hideBars = state.fullscreen && idle
  const played = duration ? (Math.min(shownPos, duration) / duration) * 100 : 0

  return (
    <div className={`player ${state.fullscreen ? 'fullscreen' : ''} ${hideBars ? 'idle' : ''}`}>
      {!hideBars && (
        <div className="player-top">
          <button className="player-back" onClick={() => send({ type: 'close' })} title="Back (Esc)">
            ← Back
          </button>
          <div className="player-title">
            <span className="player-series">{state.series ?? 'Unsorted'}</span>
            {state.episodeLabel && <span className="player-episode"> · {state.episodeLabel}</span>}
            <span className="player-file muted">{state.title}</span>
          </div>
          {state.buffering && !state.error && (
            <span className="pill pill-downloading" title="Download speed and peers of this stream">
              Buffering…
              {!state.local &&
                ` ↓ ${formatSpeed(state.downloadSpeed)} · ${state.numPeers} peer${state.numPeers === 1 ? '' : 's'}`}
            </span>
          )}
        </div>
      )}

      <div className="player-video" ref={videoRef} onClick={onVideoClick} onDoubleClick={onVideoDoubleClick} />

      {state.error && <div className="player-error">{state.error}</div>}
      <SlowReleaseBar state={state} />

      {!hideBars && (
        <div className="player-controls">
          <button className="ctl" onClick={() => send({ type: 'toggle-pause' })} title={state.paused ? 'Play (Space)' : 'Pause (Space)'}>
            {state.paused ? '▶' : '❚❚'}
          </button>
          {state.hasNext && (
            <button className="ctl" onClick={() => send({ type: 'next' })} title="Next episode (N)">
              ⏭
            </button>
          )}
          <span className="player-time">
            {formatClock(shownPos)} / {duration ? formatClock(duration) : '--:--'}
          </span>
          <input
            className="player-seek"
            type="range"
            min={0}
            max={duration || 1}
            step={0.5}
            value={Math.min(shownPos, duration || 1)}
            disabled={!duration}
            onChange={(e) => setSeekPreview(Number(e.target.value))}
            onPointerUp={() => {
              if (seekPreview != null) send({ type: 'seek', seconds: seekPreview })
              setSeekPreview(null)
            }}
            onKeyUp={() => {
              if (seekPreview != null) send({ type: 'seek', seconds: seekPreview })
              setSeekPreview(null)
            }}
            style={{ ['--pct' as string]: `${played}%`, ['--fetched' as string]: fetchedGradient(state.fetched) }}
            title={state.local ? undefined : 'The lighter parts are already fetched and play without waiting'}
          />
          {state.skip && (
            <button className="primary player-skip" onClick={() => send({ type: 'skip-chapter' })} title="Skip (S)">
              {state.skip.kind === 'opening' ? 'Skip intro' : 'Skip credits'}
            </button>
          )}
          <button className="ctl" onClick={() => send({ type: 'toggle-mute' })} title="Mute (M)">
            {state.muted || state.volume === 0 ? '🔇' : '🔊'}
          </button>
          <input
            className="player-volume"
            type="range"
            min={0}
            max={100}
            value={state.muted ? 0 : Math.min(state.volume, 100)}
            onChange={(e) => send({ type: 'volume', value: Number(e.target.value) })}
            title={`Volume ${Math.round(state.volume)}%`}
          />
          <TrackSelect
            label="Audio"
            tracks={state.audioTracks}
            onPick={(id) => id != null && send({ type: 'audio', id })}
          />
          <TrackSelect label="Subtitles" tracks={state.subTracks} allowOff onPick={(id) => send({ type: 'sub', id })} />
          <select
            className="player-track"
            title="Upscaling (U cycles through)"
            value={state.upscaler}
            onChange={(e) => send({ type: 'upscaler', mode: e.target.value as Upscaler })}
          >
            {UPSCALERS.filter((u) => u.id !== 'rtx' || nvidia).map((u) => (
              <option key={u.id} value={u.id}>
                Upscale: {u.short}
              </option>
            ))}
          </select>
          <button className="ctl" onClick={() => send({ type: 'fullscreen' })} title="Fullscreen (F, or double-click the video)">
            {state.fullscreen ? '🗗' : '⛶'}
          </button>
        </div>
      )}
    </div>
  )
}

/** Offers another upload of the episode when this one is stuck buffering or has no peers. */
function SlowReleaseBar({ state }: { state: PlayerState }): JSX.Element | null {
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)

  // A new episode (or release) starts fresh.
  useEffect(() => {
    setDismissed(null)
    if (!busy) setMessage((m) => (m?.error ? null : m))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.title])
  useEffect(() => {
    if (!message || message.error) return
    const t = setTimeout(() => setMessage(null), 6000)
    return () => clearTimeout(t)
  }, [message])

  const tryAnother = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      setMessage({ text: `Switched to ${await window.api.tryAnotherRelease()}`, error: false })
    } catch (err) {
      setMessage({ text: errorMessage(err), error: true })
    } finally {
      setBusy(false)
    }
  }

  if (busy) return <div className="player-slow">Looking for another upload of this episode…</div>
  if (message) {
    return (
      <div className={`player-slow ${message.error ? 'failed' : 'done'}`}>
        <span className="player-slow-text">{message.text}</span>
        <button className="link" onClick={() => setMessage(null)}>
          OK
        </button>
      </div>
    )
  }
  if (!state.slow || state.error || dismissed === state.title) return null
  return (
    <div className="player-slow">
      <span className="player-slow-text">
        This release is slow{state.numPeers === 0 ? ' (no peers)' : ''}. Try another?
      </span>
      <button className="primary" onClick={tryAnother}>
        Try another
      </button>
      <button onClick={() => setDismissed(state.title)}>Dismiss</button>
    </div>
  )
}

/** The fetched parts of the file as a gradient layer under the seek bar's played part. */
function fetchedGradient(ranges: [number, number][]): string {
  if (ranges.length === 0) return 'none'
  const stops = ranges.flatMap(([a, b]) => {
    const [from, to] = [(a * 100).toFixed(2), (b * 100).toFixed(2)]
    return [`transparent ${from}%`, `var(--fetched-color) ${from}%`, `var(--fetched-color) ${to}%`, `transparent ${to}%`]
  })
  return `linear-gradient(to right, ${stops.join(', ')})`
}

function TrackSelect({
  label,
  tracks,
  allowOff = false,
  onPick
}: {
  label: string
  tracks: PlayerTrack[]
  allowOff?: boolean
  onPick: (id: number | null) => void
}): JSX.Element | null {
  if (tracks.length === 0 || (tracks.length === 1 && !allowOff)) return null
  const selected = tracks.find((t) => t.selected)
  return (
    <select
      className="player-track"
      title={label}
      value={selected ? String(selected.id) : 'off'}
      onChange={(e) => onPick(e.target.value === 'off' ? null : Number(e.target.value))}
    >
      {allowOff && <option value="off">{label}: off</option>}
      {tracks.map((t) => (
        <option key={t.id} value={t.id}>
          {label}: {trackName(t)}
        </option>
      ))}
    </select>
  )
}

function trackName(t: PlayerTrack): string {
  const lang = t.lang ? t.lang.toUpperCase() : null
  if (t.title && lang) return `${t.title} (${lang})`
  return t.title ?? lang ?? `Track ${t.id}`
}
