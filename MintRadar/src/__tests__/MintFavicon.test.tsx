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

  it('renders a two-letter hostname monogram (no <img>) when the mint has no icon', () => {
    const { container } = render(<MintFavicon url="https://minibits.cash" iconUrl={null} />)
    expect(container.querySelector('img')).toBeNull()
    const placeholder = screen.getByLabelText(/mint icon placeholder/)
    expect(placeholder).toBeInTheDocument()
    expect(placeholder).toHaveTextContent('MI')
  })

  it('gives different mints different monograms', () => {
    const a = render(<MintFavicon url="https://minibits.cash" iconUrl={null} />).container
    const b = render(<MintFavicon url="https://coinos.io" iconUrl={null} />).container
    expect(a.textContent).not.toBe(b.textContent)
    expect(a.textContent).toBe('MI')
    expect(b.textContent).toBe('CO')
  })

  it('falls back to the placeholder monogram when the proxied image fails to load', () => {
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
