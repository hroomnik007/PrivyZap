import cron from 'node-cron'
import pLimit from 'p-limit'
import { getKnownMints, probeMintToDb, pruneOldHistory, pruneUnvalidatedMints, revalidateMints, backfillServerLocations } from './prober.js'
import { discoverMintsFromNostr, discoverMintsFromApi } from './discovery.js'
import { refreshAllMintReviews } from './reviewsSync.js'
import { refreshTrustMoversRollup } from './trustMoversRollup.js'
import { refreshReviewSurgeBaseline } from './reviewSurgeRollup.js'
import { pruneOldNotificationSubscriptions } from './db.js'
import { publishServiceProfile } from './nostrService.js'
import { fetchLatestUpstreamVersions } from './versionCatalog.js'

const KNOWN_MINTS = [
  'https://mint.minibits.cash/Bitcoin',
  'https://stablenut.umint.cash',
  'https://mint.coinos.io',
  'https://legend.lnbits.com/cashu/api/v1/4gr9Xcmz3XEkUNwiBiQGoC',
  'https://mint.lnwallet.app/cashu',
  'https://cashu.mutinywallet.com',
  'https://mint.macadamia.cash',
  'https://mint.cubo.cash',
  'https://testnut.cashu.space',
  'https://mint.swiss-enigma.ch/Bitcoin',
  'https://mint.plebs.tech/Bitcoin',
  'https://8333.space:3338',
  'https://mint.bananapeel.xyz',
  'https://mint.proxymana.ge/Bitcoin',
  'https://mint.laisee.org/Bitcoin',
  'https://mint.nerd.bet/Bitcoin',
  'https://mint.walletofsatoshi.com/Bitcoin',
  'https://npub.cash/Bitcoin',
]

export async function seedKnownMints(upsertMint: (url: string, name: undefined, isKnown: boolean) => Promise<void>): Promise<void> {
  for (const url of KNOWN_MINTS) {
    await upsertMint(url, undefined, true)
  }
}

export function startCron(): void {
  // Probe all known mints every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      const mints = await getKnownMints()
      const limit = pLimit(10)
      await Promise.allSettled(mints.map(url => limit(() => probeMintToDb(url))))
      // Refresh the Trust Score Movers snapshots right after probes, so
      // mints.last_trust_score and the newest history rows are already current.
      await refreshTrustMoversRollup()
    } catch (err) {
      if (process.env['NODE_ENV'] !== 'production') {
        console.error('[cron] probe error:', err)
      }
    }
  })

  // Prune old history every day at 3am
  cron.schedule('0 3 * * *', async () => {
    try {
      await pruneOldHistory()
    } catch (err) {
      if (process.env['NODE_ENV'] !== 'production') {
        console.error('[cron] prune error:', err)
      }
    }
  })

  // Prune mint candidates that never passed a validating probe, every day at 3:15am
  cron.schedule('15 3 * * *', async () => {
    try {
      const deleted = await pruneUnvalidatedMints()
      console.log(`[cron] pruned ${deleted} unvalidated mint candidate(s)`)
    } catch (err) {
      if (process.env['NODE_ENV'] !== 'production') {
        console.error('[cron] unvalidated mint prune error:', err)
      }
    }
  })

  // Revalidate every mint's Cashu content once a day (4:15am) and reap any that
  // has served non-Cashu content continuously for a week — catches a mint URL
  // repointed (DNS change / redirect) to a non-mint host AFTER it first passed
  // the one-time submit/discovery validation, so the 5-min probe stops issuing
  // recurring requests to an attacker-chosen host indefinitely (confused-deputy).
  // Once a day is enough: the 5-min probe already flips such a mint offline
  // within minutes (dropping it from recommendations / marking it degraded);
  // this job is what eventually removes it from the rotation entirely.
  cron.schedule('15 4 * * *', async () => {
    try {
      const { checked, invalid, reaped } = await revalidateMints()
      console.log(`[cron] revalidated ${checked} mint(s): ${invalid} not a valid Cashu mint, ${reaped} reaped`)
    } catch (err) {
      if (process.env['NODE_ENV'] !== 'production') {
        console.error('[cron] revalidation error:', err)
      }
    }
  })

  // Prune notification subscriptions not updated in 30 days, every day at 3:30am
  cron.schedule('30 3 * * *', async () => {
    try {
      const deleted = await pruneOldNotificationSubscriptions()
      console.log(`[cron] pruned ${deleted} stale notification subscription(s)`)
    } catch (err) {
      if (process.env['NODE_ENV'] !== 'production') {
        console.error('[cron] notification subscription prune error:', err)
      }
    }
    // Cheap, idempotent replaceable event — safe to repeat daily, keeps the
    // service profile fresh on relays with short retention.
    await publishServiceProfile()
  })

  // Advance the rolling ~1-week-ago review_count snapshot every day at 4:45am —
  // feeds the informational "recent review surge" flag (reviewSurge.ts). Runs
  // after the 6h reviews sync has had all night to populate review_count.
  cron.schedule('45 4 * * *', async () => {
    try {
      await refreshReviewSurgeBaseline()
    } catch (err) {
      if (process.env['NODE_ENV'] !== 'production') {
        console.error('[cron] review surge baseline error:', err)
      }
    }
  })

  // Refresh the software_versions cache (latest Nutshell/cdk releases from GitHub)
  // every day at 3:45am — feeds versionFreshnessScore (shared/trustScore.ts).
  cron.schedule('45 3 * * *', async () => {
    try {
      await fetchLatestUpstreamVersions()
    } catch (err) {
      if (process.env['NODE_ENV'] !== 'production') {
        console.error('[cron] version catalog update error:', err)
      }
    }
  })

  // Discovery: run once after 10s, then every 6h. The mint-reviews sync
  // (reviewsSync.ts) piggy-backs on the same cadence — it fetches kind:38000
  // reviews for every known mint into `mint_reviews` so Mint Detail can serve
  // review count / avg rating / list from the DB instead of a live relay query
  // on every page open. It's single-flight internally and logs its own summary.
  setTimeout(async () => {
    console.log('[cron] running initial discovery...')
    await discoverMintsFromNostr()
    await discoverMintsFromApi()
    try {
      await refreshAllMintReviews()
    } catch (err) {
      if (process.env['NODE_ENV'] !== 'production') {
        console.error('[cron] initial reviews sync error:', err)
      }
    }
  }, 10_000)

  // Backfill server_location for mints that were never resolved (one-time catch-up)
  setTimeout(() => { void backfillServerLocations() }, 30_000)

  // Prime the Trust Score Movers rollup shortly after boot so a fresh
  // deploy/restart serves real data before the first 5-minute probe tick.
  setTimeout(() => { void refreshTrustMoversRollup() }, 15_000)
  // Seed / advance the review-count baseline shortly after boot too. review_count
  // persists across restarts, so on a normal redeploy most mints already have a
  // value and get their baseline set without waiting for the 4:45am slot.
  setTimeout(() => { void refreshReviewSurgeBaseline() }, 60_000)
  setInterval(async () => {
    console.log('[cron] running scheduled discovery...')
    await discoverMintsFromNostr()
    await discoverMintsFromApi()
    try {
      await refreshAllMintReviews()
    } catch (err) {
      if (process.env['NODE_ENV'] !== 'production') {
        console.error('[cron] scheduled reviews sync error:', err)
      }
    }
  }, 6 * 60 * 60 * 1000)
}
