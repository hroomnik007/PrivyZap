import { useRef } from 'react'
import { Info, AlertTriangle } from 'lucide-react'
import { useTapTooltip } from '@/hooks/useTapTooltip'
import './InfoTooltip.css'

// Small ⓘ affordance that reveals a short explanatory tooltip on desktop hover
// and on a single mobile tap (useTapTooltip handles the pointer-type gating and
// outside-tap dismissal). Promoted out of Tools.tsx — the DLEQ / NUT-07 icons
// there, the Audit "what is this" icon, and the Community-Rating caveat all want
// exactly this. The popup carries its own co-located CSS so it renders the same
// wherever it's mounted, independent of which page stylesheet is loaded.
export function InfoTooltip({
  text,
  width = 220,
  iconSize = 12,
  className,
  tone = 'info',
  label,
}: {
  text: string
  width?: number
  iconSize?: number
  className?: string
  // 'warn' swaps the ⓘ for a quiet amber ⚠ — used for soft advisory signals
  // (e.g. the recent-review-surge flag) that shouldn't read as neutral help.
  tone?: 'info' | 'warn'
  label?: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const tooltip = useTapTooltip(ref)
  const Icon = tone === 'warn' ? AlertTriangle : Info
  return (
    <span
      ref={ref}
      className={className ? `info-tooltip ${className}` : 'info-tooltip'}
      onPointerEnter={tooltip.onPointerEnter}
      onPointerLeave={tooltip.onPointerLeave}
      onClick={tooltip.onClick}
      aria-label={label}
      role={label ? 'button' : undefined}
      tabIndex={label ? 0 : undefined}
    >
      <Icon
        size={iconSize}
        color={tone === 'warn' ? 'var(--amber)' : '#6b7280'}
        style={{ flexShrink: 0, cursor: 'help', display: 'block' }}
      />
      {tooltip.open && (
        <span className="info-tooltip-pop" role="tooltip" style={{ width }}>
          {text}
        </span>
      )}
    </span>
  )
}
