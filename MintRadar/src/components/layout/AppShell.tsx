import { useState, useEffect, useRef, useCallback } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import { useAuthStore } from '@/stores/auth.store'
import { useWatchlistStore } from '@/stores/watchlist.store'
import { useWatchlistSync } from '@/hooks/useWatchlistSync'
import { initBunkerQR } from '@/core/nostr/client'
import { NavLogo } from './NavLogo'
import './AppShell.css'

const IcClose = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
  </svg>
)
const IcShield = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
    <path d="M7 1.5L2 3.5v3.5C2 9.8 4.2 12.3 7 13c2.8-.7 5-3.2 5-6V3.5L7 1.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
    <polyline points="4.5,7 6.2,8.7 9.5,5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)
// Logout glyph — only rendered on the mobile navbar, where the "Disconnect"
// label is dropped so the profile chip + button fit on the logo's row.
const IcLogout = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path d="M5.5 1.5H2.5v11h3M8.5 4l3.5 3-3.5 3M12 7H5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

// Method badges — Tabler icon paths (MIT), stroke-only to match the project's
// hand-drawn icon set (see LearnIcons.tsx / WalletIcons.tsx).
const svgProps = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.75, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}
const IcPuzzle = () => (
  <svg {...svgProps}>
    <path d="M4 7h3a1 1 0 0 0 1 -1v-1a2 2 0 0 1 4 0v1a1 1 0 0 0 1 1h3a1 1 0 0 1 1 1v3a1 1 0 0 0 1 1h1a2 2 0 0 1 0 4h-1a1 1 0 0 0 -1 1v3a1 1 0 0 1 -1 1h-3a1 1 0 0 1 -1 -1v-1a2 2 0 0 0 -4 0v1a1 1 0 0 1 -1 1h-3a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h1a2 2 0 0 0 0 -4h-1a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1" />
  </svg>
)
const IcKey = () => (
  <svg {...svgProps}>
    <path d="M16.555 3.843l3.602 3.602a2.877 2.877 0 0 1 0 4.069l-2.643 2.643a2.877 2.877 0 0 1 -4.069 0l-.301 -.301l-6.558 6.558a2 2 0 0 1 -1.239 .578l-.175 .008h-1.977a1 1 0 0 1 -.993 -.883l-.007 -.117v-1.977a2 2 0 0 1 .467 -1.284l.119 -.13l.414 -.414h2v-2h2v-2l2.144 -2.144l-.301 -.301a2.877 2.877 0 0 1 0 -4.069l2.643 -2.643a2.877 2.877 0 0 1 4.069 0z" />
    <path d="M15 9h.01" />
  </svg>
)
const IcQrcode = () => (
  <svg {...svgProps}>
    <path d="M4 4m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z" />
    <path d="M7 17l0 .01" />
    <path d="M4 15m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z" />
    <path d="M17 7l0 .01" />
    <path d="M14 4m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z" />
    <path d="M14 14l0 .01" /><path d="M14 17l3 0" /><path d="M17 17l0 .01" />
    <path d="M14 20l6 0" /><path d="M20 14l0 6" />
  </svg>
)
const IcCopy = () => (
  <svg {...svgProps}>
    <path d="M8 8m0 2a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2z" />
    <path d="M16 8v-2a2 2 0 0 0 -2 -2h-8a2 2 0 0 0 -2 2v8a2 2 0 0 0 2 2h2" />
  </svg>
)
const IcBack = () => (
  <svg {...svgProps} width="14" height="14">
    <path d="M5 12l14 0" /><path d="M5 12l6 6" /><path d="M5 12l6 -6" />
  </svg>
)

// nostrconnect:// URIs are long; show a head…tail preview in the copy field.
function shortenPairingUri(uri: string): string {
  if (uri.length <= 44) return uri
  return `${uri.slice(0, 26)}…${uri.slice(-12)}`
}

// Method-specific heading + subheading shown once a method is picked and the
// three-way list collapses to the focused view.
const FOCUS_COPY = {
  nip07: {
    title: 'Nostr extension',
    subtitle: 'Sign in with Alby, nos2x or any NIP-07 signer — your key never leaves the extension.',
  },
  nsec: {
    title: 'Nostr key (nsec)',
    subtitle: 'Your key is held only in this browser, in memory for this session.',
  },
  'remote-signer': {
    title: 'Connect a remote signer',
    subtitle: 'Your key stays in your signer. This site can never see it.',
  },
} as const

// Short label for the navbar profile badge.
const METHOD_BADGE: Record<'nip07' | 'nsec' | 'remote-signer', string> = {
  nip07: 'Extension',
  nsec: 'nsec',
  'remote-signer': 'Remote signer',
}

// npub1abc…xyz789 — same head/tail truncation idiom used for keys elsewhere.
function shortNpub(npub: string): string {
  if (npub.length <= 20) return npub
  return `${npub.slice(0, 12)}…${npub.slice(-6)}`
}

export function AppShell() {
  const { pathname } = useLocation()
  useEffect(() => { window.scrollTo(0, 0) }, [pathname])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName
      const editable = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable
      if (e.key === '/') {
        if (editable) return
        e.preventDefault()
        document.querySelector<HTMLInputElement>('[data-search-input]')?.focus()
      }
      if (e.key === 'Escape') {
        window.dispatchEvent(new CustomEvent('mintradar:escape'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useWatchlistSync()
  const profile = useAuthStore(state => state.profile)
  const authMethod = useAuthStore(state => state.method)
  // Follow recommendations (kind:3 + kind:38000 over up to 500 authors — the
  // heaviest Nostr query in the app) are no longer prefetched on login here.
  // They load lazily from the Watchlist page's own useFollowRecommendations()
  // so they don't contend for relay sockets with the login profile bootstrap.
  const login = useAuthStore(state => state.login)
  const loginNsec = useAuthStore(state => state.loginNsec)
  const loginBunker = useAuthStore(state => state.loginBunker)
  const logout = useAuthStore(state => state.logout)
  const isLoading = useAuthStore(state => state.isLoading)
  const authError = useAuthStore(state => state.error)
  const watchlistCount = useWatchlistStore(state => state.mints.length)

  const [copiedNpub, setCopiedNpub] = useState(false)
  const [showLoginModal, setShowLoginModal] = useState(false)
  const [loginMethod, setLoginMethod] = useState<'nip07' | 'nsec' | 'remote-signer'>('nip07')
  // false → the three-method picker is shown; true → collapsed to the focused
  // view for `loginMethod`, with a "Back" link to return to the picker.
  const [methodPicked, setMethodPicked] = useState(false)
  const [nsecInput, setNsecInput] = useState('')
  const [nsecError, setNsecError] = useState('')
  const [bunkerInput, setBunkerInput] = useState('')
  const [bunkerError, setBunkerError] = useState('')
  const [qrUri, setQrUri] = useState('')
  const [copiedUri, setCopiedUri] = useState(false)
  const qrCancelRef = useRef<(() => void) | null>(null)

  const [nip07Available, setNip07Available] = useState(false)
  useEffect(() => {
    const check = () => setNip07Available(typeof window !== 'undefined' && !!window.nostr)
    check()
    const timer = setTimeout(check, 500)
    return () => clearTimeout(timer)
  }, [])

  // Close the modal and reset all its local state — single close path used by
  // overlay click, X button, Cancel, Escape, and successful login.
  const closeLoginModal = useCallback(() => {
    setShowLoginModal(false)
    setNsecInput('')
    setNsecError('')
    setLoginMethod('nip07')
    setMethodPicked(false)
    setBunkerInput('')
    setBunkerError('')
    setQrUri('')
    setCopiedUri(false)
    qrCancelRef.current?.()
    qrCancelRef.current = null
  }, [])

  // Close modal on Escape key
  useEffect(() => {
    if (!showLoginModal) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') closeLoginModal() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [showLoginModal, closeLoginModal])

  // Allow any page to open the login modal via custom event
  useEffect(() => {
    const handler = () => setShowLoginModal(true)
    window.addEventListener('mintradar:open-login', handler)
    return () => window.removeEventListener('mintradar:open-login', handler)
  }, [])

  function handleLogout() {
    logout()
    useWatchlistStore.getState().resetInMemory()
  }

  // Start a fresh nostrconnect pairing: opens the websockets, shows the QR, and
  // begins the 120s timeout. Any prior attempt is aborted first. Stale promise
  // callbacks bail out by comparing qrCancelRef against their own `cancel`.
  const startPairing = useCallback(() => {
    qrCancelRef.current?.()
    const { uri, loginPromise, cancel } = initBunkerQR()
    qrCancelRef.current = cancel
    setQrUri(uri)
    setCopiedUri(false)
    setBunkerError('')
    void loginPromise
      .then(p => {
        if (qrCancelRef.current !== cancel) return
        qrCancelRef.current = null
        useAuthStore.setState({ profile: p, method: 'remote-signer', isLoading: false, error: null })
        closeLoginModal()
      })
      .catch((err: unknown) => {
        if (qrCancelRef.current !== cancel || !(err instanceof Error)) return
        if (err.name !== 'AbortError' && !err.message.includes('subscription closed')) {
          setBunkerError(err.message || 'Pairing failed')
        }
      })
  }, [closeLoginModal])

  // Abort a live pairing if the component ever unmounts.
  useEffect(() => () => { qrCancelRef.current?.() }, [])

  // Tear down a live Remote-signer pairing (websockets + QR state). Shared by the
  // "Back" link and any other path that leaves the focused Remote-signer view.
  const teardownPairing = useCallback(() => {
    qrCancelRef.current?.()
    qrCancelRef.current = null
    setQrUri('')
    setCopiedUri(false)
    setBunkerError('')
  }, [])

  // NIP-07 needs no further input from the user — window.nostr is either there or
  // it isn't — so picking it fires the connect straight away. On success the
  // modal closes; on failure the focused view stays up with the error + an
  // install link to recover from.
  const connectNip07 = useCallback(async () => {
    await login()
    if (useAuthStore.getState().profile !== null) closeLoginModal()
  }, [login, closeLoginModal])

  // Pick a method from the list: collapse to its focused view. Remote signer
  // auto-starts QR pairing; Nostr extension auto-fires the connect (see above).
  // Nostr key is the only one that then waits for a Connect click.
  function selectMethod(id: 'nip07' | 'nsec' | 'remote-signer') {
    setLoginMethod(id)
    setMethodPicked(true)
    if (id === 'remote-signer') startPairing()
    else if (id === 'nip07' && nip07Available) void connectNip07()
  }

  // "Back" from a focused view to the three-method picker.
  function backToPicker() {
    if (loginMethod === 'remote-signer') teardownPairing()
    setNsecError('')
    setBunkerError('')
    setMethodPicked(false)
  }

  async function handleModalConnect() {
    if (loginMethod === 'nip07') {
      await login()
    } else if (loginMethod === 'nsec') {
      const trimmed = nsecInput.trim()
      if (!trimmed) { setNsecError('Please enter your nsec key'); return }
      setNsecInput('')
      await loginNsec(trimmed)
      if (useAuthStore.getState().error) {
        setNsecError(useAuthStore.getState().error ?? 'Login failed')
        return
      }
    } else if (loginMethod === 'remote-signer') {
      const trimmed = bunkerInput.trim()
      if (!trimmed) { setBunkerError('Please enter a bunker:// URI or NIP-05 identifier'); return }
      setBunkerError('')
      await loginBunker(trimmed)
      if (useAuthStore.getState().error) {
        setBunkerError(useAuthStore.getState().error ?? 'Connection failed')
        return
      }
    }
    if (useAuthStore.getState().profile !== null) closeLoginModal()
  }

  return (
    <div className="app-shell">
      <nav className="navbar">
       <div className="navbar-inner">
        <NavLink to="/" className="navbar-brand nav-logo">
          <NavLogo />
          <span>Mint<span style={{color:'var(--accent)'}}>Radar</span></span>
        </NavLink>

        <div className="navbar-spacer" style={{flex:1}}/>

        {/* Tab segment group */}
        <div className="navbar-tabs">
          <NavLink to="/" end className={({isActive}) => `nav-tab${isActive ? ' active' : ''}`}>
            Dashboard
          </NavLink>
          <NavLink to="/watchlist" className={({isActive}) => `nav-tab${isActive ? ' active' : ''}`}>
            Watchlist
            {profile !== null && watchlistCount > 0 && <span className="nav-tab-badge">{watchlistCount}</span>}
          </NavLink>
          <NavLink to="/stats" className={({isActive}) => `nav-tab${isActive ? ' active' : ''}`}>
            Stats
          </NavLink>
          <NavLink to="/tools" className={({isActive}) => `nav-tab${isActive ? ' active' : ''}`}>
            Tools
          </NavLink>
          <NavLink to="/wallets" className={({isActive}) => `nav-tab${isActive ? ' active' : ''}`}>
            Wallets
          </NavLink>
          <NavLink to="/learn" className={({isActive}) => `nav-tab${isActive ? ' active' : ''}`}>
            Learn
          </NavLink>
        </div>

        <div className="navbar-auth">
          {profile === null ? (
            <button type="button" className="navbar-login-btn" onClick={() => setShowLoginModal(true)}>
              ⚡ Login via Nostr
            </button>
          ) : (
            <>
              <div className="navbar-profile">
                {/* https:// only — same guard as the other two profile.picture
                    call sites (review list, "Signing with" row). This one is
                    the logged-in user's own kind:0 so the risk is minimal, but
                    keep it consistent (2026-09-07 audit hardening). */}
                {profile.picture?.startsWith('https://') ? (
                  <img src={profile.picture} alt=""
                    className="navbar-avatar"
                    onError={(e) => { e.currentTarget.style.display = 'none' }}
                  />
                ) : (
                  // Reserve the avatar slot while the kind:0 metadata is still
                  // loading in the background — prevents a layout shift when the
                  // real avatar pops in a second or two after login.
                  <span className="navbar-avatar navbar-avatar--placeholder" aria-hidden="true" />
                )}
                <div className="navbar-profile-text">
                  <div className="navbar-profile-name-row">
                    <span className="navbar-username">
                      {profile.name ?? `${profile.pubkey.slice(0,8)}...`}
                    </span>
                    {authMethod !== null && (
                      <span className="navbar-method-badge">{METHOD_BADGE[authMethod]}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="navbar-npub"
                    title="Copy full npub"
                    onClick={() => {
                      void navigator.clipboard.writeText(profile.npub)
                      setCopiedNpub(true)
                      setTimeout(() => setCopiedNpub(false), 2000)
                    }}
                  >
                    {copiedNpub ? 'Copied' : shortNpub(profile.npub)}
                  </button>
                </div>
              </div>
              <button type="button" className="navbar-disconnect-btn" onClick={handleLogout} aria-label="Disconnect">
                <IcLogout />
                <span className="navbar-disconnect-label">Disconnect</span>
              </button>
            </>
          )}
        </div>
       </div>
      </nav>

      {/* Nostr login modal */}
      {showLoginModal && (
        <div className="nostr-modal-overlay" onClick={closeLoginModal}>
          <div className="nostr-modal" onClick={e => e.stopPropagation()}>
            {!methodPicked ? (
              <>
                <div className="nostr-modal-header">
                  <div className="nostr-modal-icon">⚡</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="nostr-modal-title">Connect with Nostr</div>
                    <div className="nostr-modal-subtitle">MintRadar uses your Nostr identity to save watchlists and post reviews. No email, no password.</div>
                  </div>
                  <button type="button" className="nostr-modal-close" onClick={closeLoginModal}>
                    <IcClose />
                  </button>
                </div>

                <div className="nostr-modal-methods">
                  {([
                    { id: 'nip07', title: 'Nostr extension', desc: 'Sign in with Alby, nos2x or any NIP-07 signer', icon: <IcPuzzle /> },
                    { id: 'nsec', title: 'Nostr key (nsec)', desc: 'Paste a private key — stored only in this browser', icon: <IcKey /> },
                    { id: 'remote-signer', title: 'Remote signer', desc: 'Sign in with Amber, Primal or any NIP-46 signer — your key stays on your phone', icon: <IcQrcode /> },
                  ] as const).map(m => (
                    <div
                      key={m.id}
                      className="nostr-method-card"
                      role="button"
                      tabIndex={0}
                      onClick={() => selectMethod(m.id)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectMethod(m.id) } }}
                    >
                      <div className="nostr-method-icon">{m.icon}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="nostr-method-title">{m.title}</div>
                        <div className="nostr-method-desc">{m.desc}</div>
                      </div>
                      <div className="nostr-method-chevron" aria-hidden="true">›</div>
                    </div>
                  ))}
                </div>

                <div className="nostr-modal-footer">
                  <div className="nostr-privacy-note">
                    <IcShield /> Your keys stay yours. MintRadar only ever requests signatures — it can&apos;t read or store your private key.
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="nostr-focus-top">
                  <button type="button" className="nostr-back-btn" onClick={backToPicker}>
                    <IcBack /> Back
                  </button>
                  <button type="button" className="nostr-modal-close" onClick={closeLoginModal}>
                    <IcClose />
                  </button>
                </div>
                <div className="nostr-modal-header nostr-modal-header--focus">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="nostr-modal-title">{FOCUS_COPY[loginMethod].title}</div>
                    <div className="nostr-modal-subtitle">{FOCUS_COPY[loginMethod].subtitle}</div>
                  </div>
                </div>

                {loginMethod === 'nsec' && (
                  <div className="nostr-nsec-wrap">
                    <div className="nostr-nsec-security-warn">
                      <p style={{ margin: 0 }}>
                        ⚠️ Security notice: Entering your nsec key in a browser is inherently risky. On desktop, we recommend using a NIP-07 extension (Alby, nos2x) instead — your key never leaves the extension. On mobile, only use nsec login on a trusted personal device with no suspicious apps installed.
                      </p>
                    </div>
                    <input
                      className="nostr-nsec-input"
                      type="password"
                      placeholder="nsec1... or 64-char hex private key"
                      value={nsecInput}
                      onChange={e => { setNsecInput(e.target.value); setNsecError('') }}
                      autoFocus
                    />
                    {nsecError && <div className="nostr-nsec-error">{nsecError}</div>}
                  </div>
                )}

                {loginMethod === 'nip07' && !nip07Available && (
                  <div className="nostr-warn">
                    No Nostr extension detected.{' '}
                    <a href="https://getalby.com" target="_blank" rel="noreferrer">Install Alby</a> or nos2x to continue.
                  </div>
                )}

                {loginMethod === 'nip07' && nip07Available && !authError && (
                  <div className="nostr-warn">Connecting to your Nostr extension…</div>
                )}

                {loginMethod === 'remote-signer' && (
                  <div className="nostr-remote-wrap">
                    {qrUri && (
                      <div className="nostr-qr-wrap">
                        {/* #17251f === var(--surface); qrcode.react renders bgColor as an
                            SVG fill attribute, where CSS custom properties don't resolve */}
                        <QRCodeSVG value={qrUri} size={192} bgColor="#17251f" fgColor="#f2f7f4" />
                      </div>
                    )}
                    <div className="nostr-qr-caption">
                      <span>Scan this with your signer app, or copy the link and paste it there.</span>
                      <button type="button" className="nostr-qr-refresh" onClick={startPairing}>
                        New QR
                      </button>
                    </div>
                    {qrUri && (
                      <button
                        type="button"
                        className="nostr-qr-copy"
                        title="Copy pairing link"
                        onClick={() => {
                          void navigator.clipboard.writeText(qrUri)
                          setCopiedUri(true)
                          setTimeout(() => setCopiedUri(false), 2000)
                        }}
                      >
                        {copiedUri
                          ? <span className="nostr-qr-copy-uri">Copied</span>
                          : <><span className="nostr-qr-copy-uri">{shortenPairingUri(qrUri)}</span><IcCopy /></>}
                      </button>
                    )}
                    <p className="nostr-remote-hint">
                      Works with any NIP-46 signer: nsec.app, Amber, your own bunker.
                    </p>
                    <div className="nostr-remote-divider"><span>Or paste the connection link your signer gave you</span></div>
                    <div className="nostr-remote-paste-row">
                      <input
                        className="nostr-nsec-input"
                        type="text"
                        placeholder="bunker://..."
                        value={bunkerInput}
                        onChange={e => { setBunkerInput(e.target.value); setBunkerError('') }}
                      />
                      <button
                        type="button"
                        className="nostr-connect-btn nostr-remote-connect"
                        disabled={isLoading || !bunkerInput.trim()}
                        onClick={() => { void handleModalConnect() }}
                      >
                        {isLoading ? '…' : 'Connect'}
                      </button>
                    </div>
                    {qrUri && !bunkerError && (
                      <div className="nostr-remote-status">
                        Waiting for your signer
                        <span className="nostr-remote-status-sub">This can take up to 2 minutes.</span>
                      </div>
                    )}
                    {bunkerError && <div className="nostr-nsec-error">{bunkerError}</div>}
                  </div>
                )}

                {authError && loginMethod === 'nip07' && (
                  <div className="nostr-auth-error">{authError}</div>
                )}

                <div className="nostr-modal-footer">
                  <div className="nostr-privacy-note">
                    <IcShield /> {loginMethod === 'nip07'
                      ? <>Your key never leaves your extension. MintRadar only requests signatures — it can&apos;t read your private key.</>
                      : loginMethod === 'remote-signer'
                      ? <>Your key stays on your remote signer (e.g. Amber, nsec.app). Only a temporary session key is stored in this browser to relay requests — it can&apos;t sign anything on its own.</>
                      : <>Your key stays only in this browser&apos;s memory for this session — used to sign on your behalf, never sent anywhere, never saved to disk.</>}
                  </div>
                  {/* nsec always needs a Connect click. nip07 shows the actions only
                      to recover — no extension, or a failed/rejected attempt. On the
                      happy path it auto-connects with no buttons. remote-signer has
                      its own inline Connect in the paste row. */}
                  {(loginMethod === 'nsec' || (loginMethod === 'nip07' && (!nip07Available || authError !== null))) && (
                    <div className="nostr-modal-actions">
                      <button type="button" className="nostr-cancel-btn" onClick={closeLoginModal}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="nostr-connect-btn"
                        disabled={isLoading || (loginMethod === 'nip07' && !nip07Available)}
                        onClick={() => { void handleModalConnect() }}
                      >
                        {isLoading ? 'Connecting…' : (loginMethod === 'nip07' && authError !== null) ? <>⚡ Retry</> : <>⚡ Connect</>}
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <main className="app-content">
        <Outlet />
      </main>
    </div>
  )
}
