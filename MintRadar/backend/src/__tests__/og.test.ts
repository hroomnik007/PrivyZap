import { describe, it, expect } from 'vitest'
import { escapeHtml, mintStatusLabel, renderMintOgHtml, type OgMintData } from '../og.js'

describe('escapeHtml', () => {
  it('escapes all five HTML-significant characters', () => {
    expect(escapeHtml(`<script>alert("x")&'y'</script>`))
      .toBe('&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;y&#39;&lt;/script&gt;')
  })

  it('leaves plain text untouched', () => {
    expect(escapeHtml('Minibits Mint')).toBe('Minibits Mint')
  })
})

describe('mintStatusLabel', () => {
  it('is Degraded when degraded, regardless of online value', () => {
    expect(mintStatusLabel({ online: true, degraded: true })).toBe('Degraded')
  })

  it('is Online when online and not degraded', () => {
    expect(mintStatusLabel({ online: true, degraded: false })).toBe('Online')
  })

  it('is Offline when online is false and not degraded', () => {
    expect(mintStatusLabel({ online: false, degraded: false })).toBe('Offline')
  })

  it('is Offline when online is null (never probed) and not degraded', () => {
    expect(mintStatusLabel({ online: null, degraded: false })).toBe('Offline')
  })
})

describe('renderMintOgHtml', () => {
  const mintUrl = 'https://mint.example.com'

  it('renders name, trust score and status into title/description for a known mint', () => {
    const mint: OgMintData = { name: 'Example Mint', trustScore: 87, online: true, degraded: false }
    const html = renderMintOgHtml(mint, mintUrl)

    expect(html).toContain('<title>Example Mint — MintRadar</title>')
    expect(html).toContain('property="og:title" content="Example Mint — MintRadar"')
    expect(html).toContain('content="Trust Score: 87% · Online"')
    expect(html).toContain(`property="og:url" content="https://mintradar.org/mint/${encodeURIComponent(mintUrl)}"`)
    expect(html).toContain('name="twitter:card" content="summary_large_image"')
    expect(html).toContain('property="og:image" content="https://mintradar.org/og-image.png"')
  })

  it('falls back to the mint URL as the display name when name is null', () => {
    const mint: OgMintData = { name: null, trustScore: 50, online: false, degraded: false }
    const html = renderMintOgHtml(mint, mintUrl)
    expect(html).toContain(`<title>${mintUrl} — MintRadar</title>`)
  })

  it('falls back to the mint URL when name is an empty/whitespace string', () => {
    const mint: OgMintData = { name: '   ', trustScore: 50, online: false, degraded: false }
    const html = renderMintOgHtml(mint, mintUrl)
    expect(html).toContain(`<title>${mintUrl} — MintRadar</title>`)
  })

  it('shows N/A when trustScore is null', () => {
    const mint: OgMintData = { name: 'Example Mint', trustScore: null, online: true, degraded: false }
    const html = renderMintOgHtml(mint, mintUrl)
    expect(html).toContain('content="Trust Score: N/A · Online"')
  })

  it('escapes a malicious mint name instead of injecting it raw', () => {
    const mint: OgMintData = { name: '<img src=x onerror=alert(1)>', trustScore: 10, online: true, degraded: false }
    const html = renderMintOgHtml(mint, mintUrl)
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('renders a generic MintRadar fallback when mint is null (unknown URL)', () => {
    const html = renderMintOgHtml(null, mintUrl)
    expect(html).toContain('<title>MintRadar - Cashu Mint Monitor</title>')
    expect(html).toContain('Real-time Trust Score, latency &amp; NUT monitoring for Cashu mints.')
    expect(html).toContain(`property="og:url" content="https://mintradar.org/mint/${encodeURIComponent(mintUrl)}"`)
  })

  it('falls back to the site homepage as og:url when no mint URL is given', () => {
    const html = renderMintOgHtml(null, '')
    expect(html).toContain('property="og:url" content="https://mintradar.org"')
  })

  it('always returns a well-formed HTML document (doctype + closing tags)', () => {
    const html = renderMintOgHtml(null, mintUrl)
    expect(html.trim().startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('</html>')
  })
})
