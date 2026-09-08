import { WALLETS } from '@/constants/wallets'
import type { WalletInfo } from '@/constants/wallets'
import { WalletPlatformIcon } from '@/components/wallets/WalletIcons'
import { LearnHero } from '@/components/learn/LearnIcons'
import './Wallets.css'

function hostname(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

function WalletCard({ w }: { w: WalletInfo }) {
  return (
    <a
      key={w.name}
      className="wallet-card"
      href={w.url}
      target="_blank"
      rel="noopener noreferrer"
    >
      <div className="wallet-card-head">
        <WalletPlatformIcon platform={w.platforms[0]} />
        <div className="wallet-platforms">
          {w.platforms.map(p => (
            <span key={p} className="wallet-platform-tag">{p}</span>
          ))}
        </div>
      </div>

      <div className="wallet-name">{w.name}</div>

      <p className="wallet-blurb">{w.blurb}</p>

      <span className="wallet-link">{hostname(w.url)} ↗</span>
    </a>
  )
}

export default function Wallets() {
  const wallets = WALLETS.filter(w => !w.selfHost)
  const selfHost = WALLETS.filter(w => w.selfHost)

  return (
    <div className="wallets-page">
      <div className="wallets-header">
        <div className="wallets-title">Wallets</div>
        <div className="wallets-subtitle">Cashu-compatible wallets — a plain list, no ranking or reviews</div>
      </div>

      <div className="wallets-hero" aria-hidden="true">
        <LearnHero />
      </div>

      <div className="wallets-grid">
        {wallets.map(w => <WalletCard key={w.name} w={w} />)}
      </div>

      {selfHost.length > 0 && (
        <div className="wallets-selfhost">
          <div className="wallets-selfhost-title">Run your own mint</div>
          <div className="wallets-selfhost-sub">Not a consumer wallet — the reference implementation, for operators and scripting.</div>
          <div className="wallets-grid wallets-grid-selfhost">
            {selfHost.map(w => <WalletCard key={w.name} w={w} />)}
          </div>
        </div>
      )}

      <div className="wallets-footnote">
        Listing a wallet here is not an endorsement. Always verify you trust a wallet before putting funds in it.
      </div>
    </div>
  )
}
