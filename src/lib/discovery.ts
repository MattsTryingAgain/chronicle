/**
 * discovery.ts
 *
 * Opt-in discovery relay support.
 * Publishes and searches minimal kind 30085 discovery events.
 * No ancestry data is included — only a name fragment, pubkey, and relay address.
 *
 * Discovery is entirely opt-in. Nothing is published without explicit user action.
 */

import { hexToNpub } from './keys.js'

export interface DiscoveryEvent {
  npub: string
  nameFragment: string
  relay: string
  createdAt: number
}

export interface DiscoverySearchResult {
  npub: string
  nameFragment: string
  relay: string
  score: number // 0-1, how well the result matches the query
}

// ---------------------------------------------------------------------------
// Event building helpers
// ---------------------------------------------------------------------------

/**
 * Build the tags array for a kind 30085 discovery event.
 */
export function buildDiscoveryTags(nameFragment: string, relayUrl: string): string[][] {
  return [
    ['name_fragment', normaliseNameFragment(nameFragment)],
    ['relay', relayUrl],
    ['v', '1'],
  ]
}

/**
 * Normalise a name fragment for indexing/matching.
 * Strips diacritics, lowercases, removes non-alpha characters.
 */
export function normaliseNameFragment(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '') // keep alphanumeric only
    .slice(0, 32) // cap length
}

/**
 * Parse a raw Nostr event object into a DiscoveryEvent. Returns null if invalid.
 */
export function parseDiscoveryEvent(raw: {
  kind: number
  pubkey: string
  tags: string[][]
  created_at: number
}): DiscoveryEvent | null {
  if (raw.kind !== 30085) return null
  const nameTag = raw.tags.find(t => t[0] === 'name_fragment')
  const relayTag = raw.tags.find(t => t[0] === 'relay')
  if (!nameTag || !relayTag) return null
  if (!relayTag[1].startsWith('ws://') && !relayTag[1].startsWith('wss://')) return null
  return {
    npub: hexToNpub(raw.pubkey),
    nameFragment: nameTag[1],
    relay: relayTag[1],
    createdAt: raw.created_at,
  }
}

// ---------------------------------------------------------------------------
// Search / matching
// ---------------------------------------------------------------------------

/**
 * Score a discovery event against a search query (0 = no match, 1 = perfect).
 * Returns 0 if the event should be excluded from results.
 */
export function scoreDiscoveryResult(event: DiscoveryEvent, query: string): number {
  const norm = normaliseNameFragment(query)
  if (!norm) return 0
  const frag = event.nameFragment

  if (frag === norm) return 1.0
  if (frag.startsWith(norm)) return 0.9
  if (frag.includes(norm)) return 0.7
  if (norm.startsWith(frag) && frag.length >= 3) return 0.5
  return 0
}

/**
 * Filter and rank a list of discovery events against a search query.
 * Returns only events with score > 0, sorted descending by score.
 */
export function searchDiscoveryResults(
  events: DiscoveryEvent[],
  query: string,
  limit = 20,
): DiscoverySearchResult[] {
  const results: DiscoverySearchResult[] = []
  for (const ev of events) {
    const score = scoreDiscoveryResult(ev, query)
    if (score > 0) {
      results.push({ npub: ev.npub, nameFragment: ev.nameFragment, relay: ev.relay, score })
    }
  }
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit)
}

/**
 * Deduplicate discovery results by npub, keeping the highest-scored entry.
 */
export function deduplicateDiscoveryResults(
  results: DiscoverySearchResult[],
): DiscoverySearchResult[] {
  const seen = new Map<string, DiscoverySearchResult>()
  for (const r of results) {
    const existing = seen.get(r.npub)
    if (!existing || r.score > existing.score) {
      seen.set(r.npub, r)
    }
  }
  return Array.from(seen.values()).sort((a, b) => b.score - a.score)
}
