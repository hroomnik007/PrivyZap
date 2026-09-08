import { useRef } from 'react'
import { Info } from 'lucide-react'
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
}: {
  text: string
  width?: number
  iconSize?: number
  className?: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const tooltip = useTapTooltip(ref)
  return (
    <span
      ref={ref}
      className={className ? `info-tooltip ${className}` : 'info-tooltip'}
      onPointerEnter={tooltip.onPointerEnter}
      onPointerLeave={tooltip.onPointerLeave}
      onClick={tooltip.onClick}
    >
      <Info size={iconSize} color="#6b7280" style={{ flexShrink: 0, cursor: 'help', display: 'block' }} />
      {tooltip.open && (
        <span className="info-tooltip-pop" role="tooltip" style={{ width }}>
          {text}
        </span>
      )}
    </span>
  )
}
