import { useEffect, useState } from 'react'
import { NYAA_CATEGORIES, NYAA_FILTERS, type Settings } from '@shared/types'

export default function SettingsPage(): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    window.api.getSettings().then(setSettings)
  }, [])

  if (!settings) return <div className="page" />

  async function update(patch: Partial<Settings>): Promise<void> {
    setSettings(await window.api.setSettings(patch))
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
