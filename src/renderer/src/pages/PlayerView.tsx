import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from 'react'
import type { PlayerCommand, PlayerState, PlayerTrack, Upscaler } from '@shared/types'
import { errorMessage, formatClock, formatSpeed, UPSCALERS } from '../format'

const HIDE_CONTROLS_MS = 3000
/** How long the seek bar keeps showing a seek's target while playback gets there. */
const SEEK_HOLD_MS = 8000
/** The cursor rests this long on the seek bar before a stream starts fetching the spot under it. */
const PREVIEW_REST_MS = 200
/** Moves smaller than this (seconds) keep fetching the same spot. */
const PREVIEW_STEP_SEC = 2

/**
 * Episodes already switched to another upload automatically, so a slow replacement
 * doesn't start a chain of switches. Kept here so it outlasts switching between
 * the full and mini player.
 */
const autoTried = new Set<string>()

/**
 * The in-app player. The video itself is mpv drawing into a separate window that
 * the main process keeps exactly over the `.player-video` box, so nothing can be
 * drawn on top of it: status and controls live in the bars around it. That window
 * lets the mouse through, so clicks on the video arrive here as usual.
 */
export default function PlayerView({
  state,
  onMinimize
}: {
  state: PlayerState
  onMinimize: () => void
}): JSX.Element {
  const videoRef = useRef<HTMLDivElement>(null)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [seekPreview, setSeekPreview] = useState<number | null>(null)
  const [seekTarget, setSeekTarget] = useState<{ to: number; at: number } | null>(null)
  const seekDirty = useRef(false)
  const preview = useRef<{ timer: ReturnType<typeof setTimeout> | null; sent: number | null }>({ timer: null, sent: null })
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

  useVideoBounds(videoRef)

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
        i: () => !state.fullscreen && onMinimize(),
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
  }, [state.volume, state.fullscreen, state.hasNext, state.skip, state.upscaler, nvidia, onMinimize])

  // A seek goes where the slider is when it's let go: its own value, not the
  // preview state, which can still hold the previous click's spot at that moment.
  const commitSeek = (el: HTMLInputElement): void => {
    if (!seekDirty.current) return
    seekDirty.current = false
    const to = Number(el.value)
    // The seek takes over from any fetch under the cursor; one still waiting to start would follow it.
    const p = preview.current
    if (p.timer) clearTimeout(p.timer)
    p.timer = null
    p.sent = null
    send({ type: 'seek', seconds: to })
    setSeekTarget({ to, at: Date.now() })
    setSeekPreview(null)
  }

  // Resting the cursor on the seek bar (or dragging it) starts fetching that spot
  // of a stream, so the seek is ready sooner when the bar is let go.
  const previewAt = (seconds: number | null): void => {
    const p = preview.current
    if (p.timer) clearTimeout(p.timer)
    p.timer = null
    if (seconds == null) {
      if (p.sent != null) send({ type: 'seek-preview', seconds: null })
      p.sent = null
      return
    }
    if (state.local || (p.sent != null && Math.abs(seconds - p.sent) < PREVIEW_STEP_SEC)) return
    p.timer = setTimeout(() => {
      p.timer = null
      p.sent = seconds
      send({ type: 'seek-preview', seconds })
    }, PREVIEW_REST_MS)
  }
  const previewUnder = (e: PointerEvent<HTMLInputElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    if (!state.duration || r.width <= 0) return
    previewAt(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * state.duration)
  }
  useEffect(() => () => previewAt(null), [])
  // Another episode starts with no fetch under the cursor (the main process drops it), so the next move sends one.
  useEffect(() => {
    const p = preview.current
    if (p.timer) clearTimeout(p.timer)
    p.timer = null
    p.sent = null
  }, [state.torrentId, state.fileIndex])

  // Until playback reaches the new spot (a stream may still be fetching it), keep
  // showing where it's going rather than snapping back to the old position.
  useEffect(() => {
    if (seekTarget && Math.abs(state.timePos - seekTarget.to) < 3) setSeekTarget(null)
  }, [state.timePos, seekTarget])
  useEffect(() => {
    if (!seekTarget) return
    const t = setTimeout(() => setSeekTarget(null), SEEK_HOLD_MS)
    return () => clearTimeout(t)
  }, [seekTarget])

  const duration = state.duration ?? 0
  const shownPos = seekPreview ?? seekTarget?.to ?? state.timePos
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
          {!state.fullscreen && (
            <button className="player-mini-btn" onClick={onMinimize} title="Keep watching in a corner while you browse (I)">
              Mini player
            </button>
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
            onChange={(e) => {
              seekDirty.current = true
              setSeekPreview(Number(e.target.value))
            }}
            onPointerMove={previewUnder}
            onPointerLeave={() => previewAt(null)}
            onPointerUp={(e) => commitSeek(e.currentTarget)}
            onKeyUp={(e) => commitSeek(e.currentTarget)}
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

/** Tell the main process where the video goes, whenever the box moves or resizes. */
function useVideoBounds(ref: React.RefObject<HTMLDivElement>): void {
  useLayoutEffect(() => {
    const el = ref.current
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
  }, [ref])
}

/**
 * The player shrunk into a corner, so browsing the app doesn't stop the episode.
 * Clicking the video (or the sidebar's Now streaming) brings the full player back.
 */
export function MiniPlayer({ state, onExpand }: { state: PlayerState; onExpand: () => void }): JSX.Element {
  const videoRef = useRef<HTMLDivElement>(null)
  const send = (cmd: PlayerCommand): void => void window.api.playerCommand(cmd)
  useVideoBounds(videoRef)
  const duration = state.duration ?? 0
  const played = duration ? (Math.min(state.timePos, duration) / duration) * 100 : 0
  return (
    <div className="mini-player">
      <div className="mini-video" ref={videoRef} onClick={onExpand} title="Back to the full player" />
      <div className="mini-progress">
        <div style={{ width: `${played}%` }} />
      </div>
      {state.error && <div className="player-error">{state.error}</div>}
      <SlowReleaseBar state={state} />
      <div className="mini-bar">
        <button className="ctl" onClick={() => send({ type: 'toggle-pause' })} title={state.paused ? 'Play' : 'Pause'}>
          {state.paused ? '▶' : '❚❚'}
        </button>
        <div className="mini-title" title={state.title}>
          <span className="player-series">{state.series ?? 'Unsorted'}</span>
          {state.episodeLabel && <span className="muted"> · {state.episodeLabel}</span>}
          <div className="muted mini-status">
            {state.buffering && !state.error
              ? `Buffering…${state.local ? '' : ` ↓ ${formatSpeed(state.downloadSpeed)}`}`
              : `${formatClock(state.timePos)} / ${duration ? formatClock(duration) : '--:--'}`}
          </div>
        </div>
        <button className="ctl" onClick={onExpand} title="Full player">
          ⤢
        </button>
        <button className="ctl" onClick={() => send({ type: 'close' })} title="Stop">
          ✕
        </button>
      </div>
    </div>
  )
}

// The bar's state outlives the bar, which remounts when the player switches
// between full and mini: a switch in progress, a dismissal and its result carry over.
interface SlowBar {
  /** The title the bar was dismissed for */
  dismissed: string | null
  busy: boolean
  message: { text: string; error: boolean } | null
  /** The title the state above belongs to */
  title: string | null
}
let slowBar: SlowBar = { dismissed: null, busy: false, message: null, title: null }
const slowBarListeners = new Set<() => void>()
let messageTimer: ReturnType<typeof setTimeout> | null = null

function setSlowBar(patch: Partial<SlowBar>): void {
  slowBar = { ...slowBar, ...patch }
  if ('message' in patch) {
    if (messageTimer) clearTimeout(messageTimer)
    messageTimer = patch.message && !patch.message.error ? setTimeout(() => setSlowBar({ message: null }), 6000) : null
  }
  slowBarListeners.forEach((l) => l())
}

function useSlowBar(): SlowBar {
  return useSyncExternalStore(
    (l) => {
      slowBarListeners.add(l)
      return () => slowBarListeners.delete(l)
    },
    () => slowBar
  )
}

async function tryAnother(auto = false): Promise<void> {
  if (slowBar.busy) return
  setSlowBar({ busy: true, message: null })
  try {
    const name = await window.api.tryAnotherRelease()
    setSlowBar({ message: { text: `${auto ? 'The release was slow, so switched' : 'Switched'} to ${name}`, error: false } })
  } catch (err) {
    setSlowBar({ message: { text: errorMessage(err), error: true } })
  } finally {
    setSlowBar({ busy: false })
  }
}

/** Offers another upload of the episode when this one is stuck buffering or has no peers. */
function SlowReleaseBar({ state }: { state: PlayerState }): JSX.Element | null {
  const { dismissed, busy, message } = useSlowBar()

  // A new episode (or release) starts fresh; a remount of the same one doesn't.
  useEffect(() => {
    if (slowBar.title === state.title) return
    setSlowBar({ title: state.title, dismissed: null })
    if (!slowBar.busy && slowBar.message?.error) setSlowBar({ message: null })
  }, [state.title])

  // With the setting on, the first slow spell of an episode switches without asking.
  const episodeKey = `${state.series ?? ''}|${state.episodeLabel ?? state.title}`
  useEffect(() => {
    if (!state.slow || state.error || busy || autoTried.has(episodeKey)) return
    let cancelled = false
    window.api.getSettings().then((s) => {
      if (cancelled || !s.autoTryAnother || autoTried.has(episodeKey)) return
      autoTried.add(episodeKey)
      void tryAnother(true)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.slow, state.error, busy, episodeKey])

  if (busy) return <div className="player-slow">Looking for another upload of this episode…</div>
  if (message) {
    return (
      <div className={`player-slow ${message.error ? 'failed' : 'done'}`}>
        <span className="player-slow-text">{message.text}</span>
        <button className="link" onClick={() => setSlowBar({ message: null })}>
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
      <button className="primary" onClick={() => tryAnother()}>
        Try another
      </button>
      <button onClick={() => setSlowBar({ dismissed: state.title })}>Dismiss</button>
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
