import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PlayerCommand, PlayerState, PlayerTrack, Upscaler } from '@shared/types'
import { formatClock, UPSCALERS } from '../format'

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
  }, [state.volume, state.fullscreen, state.hasNext, state.upscaler, nvidia])

  const duration = state.duration ?? 0
  const shownPos = seekPreview ?? state.timePos
  const hideBars = state.fullscreen && idle

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
          {state.buffering && !state.error && <span className="pill pill-downloading">Buffering…</span>}
        </div>
      )}

      <div className="player-video" ref={videoRef} onClick={onVideoClick} onDoubleClick={onVideoDoubleClick} />

      {state.error && <div className="player-error">{state.error}</div>}

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
            style={{ ['--pct' as string]: `${duration ? (Math.min(shownPos, duration) / duration) * 100 : 0}%` }}
          />
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
