import { useState } from 'react'
import { type KnownMint } from '@/hooks/useKnownMints'
import { displayName as mintDisplayName, mintHostname as getHostname } from '@/utils/mintFormatting'
import './MintComparePicker.css'

// Shared "Compare with..." mint picker — opened from both Dashboard (per-card
// ⇄ Compare button) and MintDetail (header Compare button) ahead of
// ComparisonModal. `candidates` is the caller-filtered pool to pick from
// (base mint already excluded); selection/search state lives here so callers
// only need to hand back the final URLs via onConfirm.
export function MintComparePicker({
  candidates,
  baseLabel,
  maxSelect = 3,
  onClose,
  onConfirm,
}: {
  candidates: KnownMint[]
  baseLabel: string
  maxSelect?: number
  onClose: () => void
  onConfirm: (selectedUrls: string[]) => void
}) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const q = search.toLowerCase()
  const filtered = candidates.filter(m =>
    q === '' || mintDisplayName(m).toLowerCase().includes(q) || m.url.toLowerCase().includes(q)
  )

  return (
    <div className="cmp-overlay" onClick={onClose}>
      <div className="md-picker-modal" onClick={e => e.stopPropagation()}>
        <div className="md-picker-header">
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Compare with...</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 18 }}>×</button>
        </div>
        <div style={{ padding: '8px 16px 0' }}>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8 }}>
            Select 1–{maxSelect} mints to compare with <strong style={{ color: 'var(--text)' }}>{baseLabel}</strong>
          </div>
          <input
            className="md-picker-search"
            type="text"
            placeholder="Search mints..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
          />
        </div>
        <div className="md-picker-list">
          {filtered.slice(0, 50).map(m => {
            const isChecked = selected.has(m.url)
            const disabled = !isChecked && selected.size >= maxSelect
            return (
              <div
                key={m.url}
                className={`md-picker-item${isChecked ? ' checked' : ''}${disabled ? ' disabled' : ''}`}
                onClick={() => {
                  if (disabled) return
                  setSelected(prev => {
                    const next = new Set(prev)
                    if (next.has(m.url)) next.delete(m.url); else next.add(m.url)
                    return next
                  })
                }}
              >
                <div className={`card-checkbox${isChecked ? ' checked' : ''}`} style={{ width: 14, height: 14, borderRadius: 3, flexShrink: 0 }}>
                  {isChecked && <span style={{ fontSize: 10, lineHeight: 1 }}>✓</span>}
                </div>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: m.online === true ? 'var(--accent)' : '#ff4d4d', display: 'inline-block', flexShrink: 0 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mintDisplayName(m)}</div>
                  <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{getHostname(m.url)}</div>
                </div>
              </div>
            )
          })}
          {filtered.length === 0 && (
            <div style={{ padding: '16px', fontSize: 12, color: 'var(--text3)', textAlign: 'center' }}>No mints found</div>
          )}
        </div>
        <div className="md-picker-footer">
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>{selected.size} / {maxSelect} selected</span>
          <button
            className="md-picker-confirm"
            disabled={selected.size === 0}
            onClick={() => onConfirm([...selected])}
          >
            Compare ({selected.size + 1})
          </button>
        </div>
      </div>
    </div>
  )
}
