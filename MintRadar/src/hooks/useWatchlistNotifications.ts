import { useEffect } from 'react'
import { useAuthStore } from '@/stores/auth.store'
import { useWatchlistStore } from '@/stores/watchlist.store'
import { sharedPool } from '@/core/nostr/pool'
import { db } from '@/db'
import type { NostrEvent, EventTemplate, UnsignedEvent } from 'nostr-tools'
import { nip44, generateSecretKey, finalizeEvent, getEventHash } from 'nostr-tools'

// Exported so the server subscribe/unsubscribe client (notificationSubscription.ts)
// can reuse it as a fallback when the user has no NIP-65 read relays — the task
// explicitly requires not inventing a second default list.
export const NOTIFICATION_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://purplepag.es',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://offchain.pub',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.nostr.band',
  'wss://nostr.bitcoiner.social',
  'wss://nostr.mom',
  'wss://nostr.oxtr.dev',
  'wss://relay.mostr.pub',
  'wss://relay.noswhere.com',
  'wss://pyramid.fiatjaf.com',
  'wss://nostr.lopp.social',
  'wss://nostr.cypherpunk.today',
]

// Track previous online states and trust scores to detect transitions
const prevStates = new Map<string, boolean>()
const prevTrustScores = new Map<string, number>()

export function useWatchlistNotifications(
  probeData: Record<string, { online: boolean; latencyMs: number | null } | undefined>,
  trustScoreData?: Record<string, number | null | undefined>,
  userReadRelays?: string[] | null
) {
  const profile = useAuthStore(s => s.profile)
  const { mints: watchlist } = useWatchlistStore()

  useEffect(() => {
    if (!profile?.pubkey) return
    if (!window.nostr) return

    const checkTransitions = async () => {
      for (const url of watchlist) {
        const current = probeData[url]
        if (!current) continue

        const prev = prevStates.get(url)
        const isOnline = current.online

        const dmRelays = userReadRelays ?? NOTIFICATION_RELAYS

        // Detect online → offline transition
        if (prev === true && isOnline === false) {
          const entry = await db.watchlist.get(url)
          if (entry?.notifyOnDown) {
            if (import.meta.env.DEV) console.log(`[notifications] mint down: ${url}`)
            await sendNostrDM(
              profile.pubkey,
              `⚠️ MintRadar Alert\n\nMint is down: ${url}\n\nCheck status: https://mintradar.org`,
              dmRelays
            )
          }
        }

        // Detect offline → online transition
        if (prev === false && isOnline === true) {
          const entry = await db.watchlist.get(url)
          if (entry?.notifyOnUp) {
            if (import.meta.env.DEV) console.log(`[notifications] mint recovered: ${url}`)
            await sendNostrDM(
              profile.pubkey,
              `✅ MintRadar Alert\n\nMint is back online: ${url}\n\nLatency: ${current.latencyMs}ms`,
              dmRelays
            )
          }
        }

        prevStates.set(url, isOnline)

        // Detect trust score changes ≥ 10 points
        if (trustScoreData) {
          const currentScore = trustScoreData[url]
          if (currentScore != null) {
            const prevScore = prevTrustScores.get(url)
            if (prevScore !== undefined && Math.abs(currentScore - prevScore) >= 10) {
              const mintId = encodeURIComponent(url)
              await sendNostrDM(
                profile.pubkey,
                `⚡ MintRadar Alert\n\nTrust Score for ${url} changed from ${prevScore}% to ${currentScore}%.\n\nCheck details: https://mintradar.org/mint/${mintId}`,
                dmRelays
              )
            }
            prevTrustScores.set(url, currentScore)
          }
        }
      }
    }

    checkTransitions()
  }, [probeData, trustScoreData, userReadRelays, watchlist, profile])
}

// NIP-59 recommends randomizing seal/wrap timestamps (up to 2 days in the
// past) so the real send time is not leaked through the gift wrap.
const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60
function randomizedTimestamp(): number {
  return Math.floor(Date.now() / 1000) - Math.floor(Math.random() * TWO_DAYS_SECONDS)
}

// Sends a private direct message using NIP-17 / NIP-59 gift wrapping with
// NIP-44 encryption (replaces legacy NIP-04 kind:4). The seal is signed by
// the user's NIP-07 extension; the outer gift wrap is signed by a throwaway
// ephemeral key so the sender's identity is not exposed on the relay.
async function sendNostrDM(recipientPubkey: string, content: string, relays: string[]) {
  try {
    if (!window.nostr?.nip44) {
      console.warn('[notifications] nip44 not available — skipping DM')
      return
    }

    const senderPubkey = await window.nostr.getPublicKey()

    // 1. Rumor — unsigned kind:14 chat message (NIP-17)
    const rumor: UnsignedEvent & { id?: string } = {
      kind: 14,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', recipientPubkey]],
      content,
      pubkey: senderPubkey,
    }
    rumor.id = getEventHash(rumor)

    // 2. Seal — kind:13, rumor NIP-44 encrypted to recipient, signed by sender
    const sealContent = await window.nostr.nip44.encrypt(recipientPubkey, JSON.stringify(rumor))
    const sealTemplate: EventTemplate = {
      kind: 13,
      created_at: randomizedTimestamp(),
      tags: [],
      content: sealContent,
    }
    const seal = await window.nostr.signEvent(sealTemplate) as NostrEvent
    if (!seal) return

    // 3. Gift wrap — kind:1059, seal NIP-44 encrypted from an ephemeral key
    const ephemeralKey = generateSecretKey()
    const conversationKey = nip44.getConversationKey(ephemeralKey, recipientPubkey)
    const wrapContent = nip44.encrypt(JSON.stringify(seal), conversationKey)
    const giftWrap = finalizeEvent({
      kind: 1059,
      created_at: randomizedTimestamp(),
      tags: [['p', recipientPubkey]],
      content: wrapContent,
    }, ephemeralKey)

    const publishPromises = sharedPool.publish(relays, giftWrap)
    publishPromises.forEach(p => p.catch(() => {}))
    await Promise.any(publishPromises)

    if (import.meta.env.DEV) console.log('[notifications] gift-wrapped DM sent successfully')
  } catch (err) {
    console.warn('[notifications] failed to send DM:', err)
  }
}
