import { useState } from 'react'
import { mintFaviconInitials, mintHostname } from '@/utils/mintFormatting'

interface Props {
  url: string
  iconUrl?: string | null
  size?: number
  radius?: number
  className?: string
}

export function MintFavicon({ url, iconUrl, size = 22, radius = 5, className = '' }: Props) {
  const hostname = mintHostname(url)
  const [imgFailed, setImgFailed] = useState(false)

  // `iconUrl` is treated as a boolean hint ("this mint has an icon") ONLY — the
  // bytes are always fetched through the backend's SSRF-guarded proxy, never
  // straight from a mint-controlled host. A hostile icon_url in a mint's
  // /v1/info can't turn a page view into an IP / User-Agent tracking beacon
  // (2026-09-07 security audit). The proxy 404s anything unsafe/unfetchable and
  // onError drops us to the SVG placeholder below.
  const proxiedSrc = iconUrl ? `/api/mint/icon?url=${encodeURIComponent(url)}` : null

  if (proxiedSrc && !imgFailed) {
    return (
      <img
        src={proxiedSrc}
        alt=""
        loading="lazy"
        width={size}
        height={size}
        className={className}
        style={{
          width: size, height: size, minWidth: size,
          borderRadius: radius, objectFit: 'contain',
          background: 'var(--bg3)', border: '0.5px solid var(--border)',
        }}
        onError={() => setImgFailed(true)}
      />
    )
  }

  // No icon (or the proxied one failed): a two-letter monogram derived from the
  // hostname, so each mint gets a distinct placeholder rather than an identical
  // generic glyph.
  const initials = mintFaviconInitials(url)

  return (
    <div
      className={className}
      role="img"
      aria-label={`${hostname} mint icon placeholder`}
      style={{
        width: size, height: size, minWidth: size,
        borderRadius: radius, background: 'var(--copper-soft)',
        border: '0.5px solid var(--copper)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
        color: 'var(--copper)',
        fontFamily: 'var(--font-mono)',
        fontWeight: 700,
        fontSize: Math.round(size * 0.42),
        lineHeight: 1,
        letterSpacing: '0.02em',
        userSelect: 'none',
      }}
    >
      {initials}
    </div>
  )
}
