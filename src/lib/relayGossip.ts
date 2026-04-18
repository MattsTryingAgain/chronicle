/**
 * relayGossip.ts
 *
 * Relay gossip between connected peers.
 *
 * Chronicle peers share known relay addresses with each other over time.
 * This allows the network to discover new relays without a central directory.
 * Gossip events carry a list of known relay URLs signed by the publishing peer.
 *
 * Gossip is rate-limited per peer — one gossip event per peer per TTL window.
 * All relay addresses are validated before storing.
 */

export const KIND_RELAY_GOSSIP = 30093 // Chronicle extension

export interface RelayGossipEntry {
  /** URL of the relay being gossiped */
  url: string
  /** npub of the peer who first announced this relay */
  sourcePubkey: string
  /** When this entry was first seen (ms) */
  firstSeen: number
  /** When this entry was last refreshed (ms) */
  lastSeen: number
  /** How many peers have mentioned this relay */
  mentionCount: number
}

// ---------------------------------------------------------------------------
// Tag builders / parsers
// ---------------------------------------------------------------------------

/**
 * Build tags for a gossip event carrying known relay URLs.
 */
export function buildRelayGossipTags(relayUrls: string[]): string[][] {
  const valid = relayUrls.filter(u => u.startsWith('ws://') || u.startsWith('wss://'))
  return [
    ...valid.map(u => ['relay', u]),
    ['v', '1'],
  ]
}

/**
 * Extract relay URLs from a gossip event's tags.
 */
export function parseRelayGossipUrls(tags: string[][]): string[] {
  return tags
    .filter(t => t[0] === 'relay' && t[1])
    .map(t => t[1])
    .filter(u => u.startsWith('ws://') || u.startsWith('wss://'))
}

// ---------------------------------------------------------------------------
// Relay table — aggregates known relays from all peers
// ---------------------------------------------------------------------------

export class RelayTable {
  private entries: Map<string, RelayGossipEntry> = new Map()
  /** Track last gossip time per peer to rate-limit processing */
  private lastGossip: Map<string, number> = new Map()

  /**
   * Ingest a gossip event from a peer.
   * Returns the list of newly discovered relay URLs.
   */
  ingestGossip(
    peerNpub: string,
    relayUrls: string[],
    gossipTtlMs = 5 * 60 * 1000, // 5-min rate limit per peer
  ): string[] {
    const now = Date.now()
    const last = this.lastGossip.get(peerNpub) ?? 0
    if (now - last < gossipTtlMs) return [] // rate limited
    this.lastGossip.set(peerNpub, now)

    const newUrls: string[] = []
    for (const url of relayUrls) {
      if (!url.startsWith('ws://') && !url.startsWith('wss://')) continue
      const existing = this.entries.get(url)
      if (existing) {
        existing.lastSeen = now
        existing.mentionCount++
      } else {
        this.entries.set(url, {
          url,
          sourcePubkey: peerNpub,
          firstSeen: now,
          lastSeen: now,
          mentionCount: 1,
        })
        newUrls.push(url)
      }
    }
    return newUrls
  }

  /** Add a relay URL directly (e.g. from user input or invite code) */
  addKnown(url: string, sourcePubkey: string): void {
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) return
    if (!this.entries.has(url)) {
      const now = Date.now()
      this.entries.set(url, { url, sourcePubkey, firstSeen: now, lastSeen: now, mentionCount: 1 })
    }
  }

  getAll(): RelayGossipEntry[] {
    return Array.from(this.entries.values())
  }

  get(url: string): RelayGossipEntry | undefined {
    return this.entries.get(url)
  }

  /** Return relay URLs sorted by mention count (most-mentioned first) */
  getRanked(): string[] {
    return this.getAll()
      .sort((a, b) => b.mentionCount - a.mentionCount)
      .map(e => e.url)
  }

  /** Remove stale entries not seen within staleTtlMs */
  pruneStale(staleTtlMs = 30 * 24 * 60 * 60 * 1000): void {
    const cutoff = Date.now() - staleTtlMs
    for (const [url, entry] of this.entries) {
      if (entry.lastSeen < cutoff) this.entries.delete(url)
    }
  }

  has(url: string): boolean {
    return this.entries.has(url)
  }

  size(): number {
    return this.entries.size
  }

  /** Pick up to n relay URLs to share with a peer (most-mentioned first) */
  selectForGossip(n = 10): string[] {
    return this.getRanked().slice(0, n)
  }
}
