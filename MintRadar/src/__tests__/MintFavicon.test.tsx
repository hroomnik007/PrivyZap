import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MintFavicon } from '@/components/mint/MintFavicon'

// Regression coverage for the 2026-09-07 audit finding: a mint-controlled
// icon_url used to be rendered as <img src={iconUrl}> directly, so a hostile
// operator could point it at a tracker and harvest every viewer's IP / UA.
// The favicon now always loads through the backend's SSRF-guarded proxy.

describe('MintFavicon', () => {
  it('loads the icon through the backend proxy, never from the mint-supplied URL', () => {
    const { container } = render(
      <MintFavicon
        url="https://mint.example"
        iconUrl="https://tracker.evil.example/px.png?u=victim"
      />,
    )
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe('/api/mint/icon?url=https%3A%2F%2Fmint.example')
    // The attacker-controlled URL must not appear anywhere in the rendered output.
    expect(container.innerHTML).not.toContain('tracker.evil.example')
  })

  it('URL-encodes the mint url into the proxy query', () => {
    const { container } = render(
      <MintFavicon url="https://mint.example:3338/Bitcoin" iconUrl="https://mint.example/i.png" />,
    )
    expect(container.querySelector('img')!.getAttribute('src')).toBe(
      `/api/mint/icon?url=${encodeURIComponent('https://mint.example:3338/Bitcoin')}`,
    )
  })

  it('renders the SVG placeholder (no <img>) when the mint has no icon', () => {
    const { container } = render(<MintFavicon url="https://mint.example" iconUrl={null} />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByLabelText(/mint icon placeholder/)).toBeInTheDocument()
  })

  it('falls back to the SVG placeholder when the proxied image fails to load', () => {
    const { container } = render(
      <MintFavicon url="https://mint.example" iconUrl="https://mint.example/i.png" />,
    )
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    fireEvent.error(img!)
    expect(screen.getByLabelText(/mint icon placeholder/)).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
  })
})
