import { useState } from 'react'

interface Props {
  url: string
  iconUrl?: string | null
  size?: number
  radius?: number
  className?: string
}

export function MintFavicon({ url, iconUrl, size = 22, radius = 5, className = '' }: Props) {
  const hostname = (() => { try { return new URL(url).hostname } catch { return url } })()
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

  const iconSize = size * 0.64

  return (
    <div
      className={className}
      style={{
        width: size, height: size, minWidth: size,
        borderRadius: radius, background: 'var(--bg3)',
        border: '0.5px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 24 24"
        role="img"
        aria-label={`${hostname} mint icon placeholder`}
      >
        <circle cx="12" cy="12" r="9" fill="var(--copper-soft)" stroke="var(--copper)" strokeWidth="1.5" />
        <circle cx="12" cy="12" r="6.2" fill="none" stroke="var(--copper)" strokeWidth="1" opacity="0.45" />
        <path d="M7 15.5a6.9 6.9 0 0 0 10 0" fill="none" stroke="var(--copper)" strokeWidth="1" strokeLinecap="round" opacity="0.3" />
      </svg>
    </div>
  )
}
