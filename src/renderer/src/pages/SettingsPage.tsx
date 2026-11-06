import { useEffect, useState } from 'react'
import { NYAA_CATEGORIES, NYAA_FILTERS, type PlayerInfo, type Settings, type Upscaler } from '@shared/types'
import { UPSCALERS } from '../format'

export default function SettingsPage(): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)
  const [player, setPlayer] = useState<PlayerInfo | null>(null)
  const [version, setVersion] = useState('')

  useEffect(() => {
    window.api.getSettings().then(setSettings)
    window.api.getPlayerInfo().then(setPlayer)
    window.api.getVersion().then(setVersion)
  }, [])

  if (!settings) return <div className="page" />

  async function update(patch: Partial<Settings>): Promise<void> {
    setSettings(await window.api.setSettings(patch))
    if ('mpvPath' in patch) setPlayer(await window.api.getPlayerInfo())
    setSaved(true)
    setTimeout(() => setSaved(false), 1200)
  }

  return (
    <div className="page settings">
      <h1>
        Settings {saved && <span className="muted saved">Saved</span>}
      </h1>

      <label>
        <span>Library folder</span>
        <div className="row">
          <input value={settings.libraryRoot} readOnly />
          <button
            onClick={async () => {
              const dir = await window.api.pickFolder()
              if (dir) update({ libraryRoot: dir })
            }}
          >
            Choose…
          </button>
        </div>
        <small className="muted">Each series gets its own subfolder here.</small>
      </label>

      <label>
        <span>mpv player</span>
        <div className="row">
          <input value={settings.mpvPath} placeholder="Find automatically" readOnly />
          <button
            onClick={async () => {
              const exe = await window.api.pickMpv()
              if (exe) update({ mpvPath: exe })
            }}
          >
            Choose…
          </button>
          {settings.mpvPath && <button onClick={() => update({ mpvPath: '' })}>Auto</button>}
        </div>
        <small className={player?.mpvPath ? 'muted' : 'error-text'}>
          {player === null
            ? ''
            : player.mpvPath
              ? `Using ${player.mpvPath}`
              : 'mpv not found. Install it with "winget install shinchiro.mpv" or choose mpv.exe.'}
        </small>
      </label>

      <label>
        <span>Upscaling</span>
        <select value={settings.upscaler} onChange={(e) => update({ upscaler: e.target.value as Upscaler })}>
          {UPSCALERS.filter((u) => u.id !== 'rtx' || player?.nvidia || settings.upscaler === 'rtx').map((u) => (
            <option key={u.id} value={u.id}>
              {u.label}
            </option>
          ))}
        </select>
        <small className="muted">
          {UPSCALERS.find((u) => u.id === settings.upscaler)?.note} Sharpens the picture to fit your screen while it
          plays; it can't add detail that isn't in the release. Press U in the player to compare.
        </small>
      </label>

      <label className="inline">
        <input
          type="checkbox"
          checked={settings.autoplayNext}
          onChange={(e) => update({ autoplayNext: e.target.checked })}
        />
        <span>Play the next episode automatically</span>
      </label>

      <label className="inline">
        <input
          type="checkbox"
          checked={settings.closeToTray}
          onChange={(e) => update({ closeToTray: e.target.checked })}
        />
        <span>Keep running in the tray when the window is closed</span>
      </label>

      <label className="inline">
        <input
          type="checkbox"
          checked={settings.notifyOnDownload}
          onChange={(e) => update({ notifyOnDownload: e.target.checked })}
        />
        <span>Notify me when an episode finishes downloading</span>
      </label>

      <label className="inline">
        <input
          type="checkbox"
          checked={settings.notifyNewEpisodes}
          onChange={(e) => update({ notifyNewEpisodes: e.target.checked })}
        />
        <span>Notify me when a series I follow gets a new episode</span>
      </label>

      <label>
        <span>nyaa address</span>
        <input
          defaultValue={settings.nyaaBaseUrl}
          onBlur={(e) => {
            const v = e.target.value.trim().replace(/\/+$/, '')
            if (/^https?:\/\/.+/.test(v) && v !== settings.nyaaBaseUrl) update({ nyaaBaseUrl: v })
          }}
        />
        <small className="muted">Change this if nyaa.si is blocked and you use a mirror.</small>
      </label>

      <label>
        <span>Default category</span>
        <select
          value={settings.defaultCategory}
          onChange={(e) => update({ defaultCategory: e.target.value })}
        >
          {NYAA_CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>

      <label>
        <span>Default filter</span>
        <select
          value={settings.defaultFilter}
          onChange={(e) => update({ defaultFilter: Number(e.target.value) })}
        >
          {NYAA_FILTERS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </label>

      <label className="inline">
        <input
          type="checkbox"
          checked={settings.seedAfterDownload}
          onChange={(e) => update({ seedAfterDownload: e.target.checked })}
        />
        <span>Keep seeding after a download finishes</span>
      </label>

      <div className="limits">
        <LimitInput
          label="Download limit"
          value={settings.downloadLimitKiB}
          onSave={(v) => update({ downloadLimitKiB: v })}
        />
        <LimitInput
          label="Upload limit"
          value={settings.uploadLimitKiB}
          onSave={(v) => update({ uploadLimitKiB: v })}
        />
      </div>

      {version && <p className="muted version">Swarmplay {version}</p>}
    </div>
  )
}

function LimitInput({
  label,
  value,
  onSave
}: {
  label: string
  value: number
  onSave: (v: number) => void
}): JSX.Element {
  return (
    <label>
      <span>{label}</span>
      <div className="row">
        <input
          type="number"
          min={0}
          defaultValue={value || ''}
          placeholder="Unlimited"
          onBlur={(e) => {
            const v = Math.max(0, Math.round(Number(e.target.value) || 0))
            if (v !== value) onSave(v)
          }}
        />
        <span className="muted unit">KiB/s</span>
      </div>
    </label>
  )
}
