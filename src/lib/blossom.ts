/**
 * Chronicle Blossom Media — Reference Management
 *
 * Blossom (https://github.com/hzrd149/blossom) is a protocol for storing
 * binary blobs on servers identified by their SHA-256 hash, with Nostr
 * keypair authentication.
 *
 * Stage 5 scope:
 *   - Building and parsing kind 30095 Blossom reference events
 *   - Local media cache tracking (in-memory for Stage 5; SQLite in Stage 6)
 *   - Hash verification of fetched media
 *   - Privacy-tier enforcement: private/family media is only fetched for
 *     users who hold the appropriate key
 *
 * What this module does NOT do (future stages):
 *   - Actually serve media (the embedded Blossom server is an Electron child
 *     process — started in the same pattern as the relay)
 *   - Upload media to remote Blossom servers
 *   - NIP-96 compatibility
 *
 * The local embedded Blossom server URL is: http://127.0.0.1:3035
 */

import type { BlossomRef, PrivacyTier } from '../types/chronicle'

// ─── Constants ────────────────────────────────────────────────────────────────

export const LOCAL_BLOSSOM_URL = 'http://127.0.0.1:3035'

/** Supported MIME types for Chronicle media. */
export const SUPPORTED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
] as const

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number]

// ─── BlossomRef construction ──────────────────────────────────────────────────

/**
 * Build a BlossomRef from upload metadata.
 * The hash must be the SHA-256 hex of the file content — callers are
 * responsible for computing and verifying this before calling.
 */
export function buildBlossomRef(params: {
  hash: string
  url: string
  mimeType: string
  size: number
  tier: PrivacyTier
  subjectNpub: string
}): BlossomRef {
  if (!/^[0-9a-f]{64}$/i.test(params.hash)) {
    throw new Error(`Invalid SHA-256 hash: ${params.hash}`)
  }
  if (params.size < 0) {
    throw new Error('Size must be non-negative')
  }
  if (!params.url.startsWith('http')) {
    throw new Error(`Invalid URL: ${params.url}`)
  }
  return { ...params }
}

/**
 * Build the canonical Blossom URL for a given hash on the local server.
 */
export function localBlossomUrl(hash: string): string {
  return `${LOCAL_BLOSSOM_URL}/${hash}`
}

// ─── Event tag encoding ───────────────────────────────────────────────────────

/**
 * Encode a BlossomRef as Nostr event tags for kind 30095.
 * Tags follow the Blossom protocol conventions:
 *   ["url", url]
 *   ["x", sha256hex]
 *   ["m", mimeType]
 *   ["size", bytes]
 *   ["subject", npub]
 *   ["tier", tier]
 */
export function blossomRefToTags(ref: BlossomRef): string[][] {
  return [
    ['url', ref.url],
    ['x', ref.hash],
    ['m', ref.mimeType],
    ['size', String(ref.size)],
    ['subject', ref.subjectNpub],
    ['tier', ref.tier],
  ]
}

/**
 * Parse a BlossomRef from Nostr event tags.
 * Returns null if required tags are missing or malformed.
 */
export function blossomRefFromTags(tags: string[][]): BlossomRef | null {
  const get = (key: string) => tags.find((t) => t[0] === key)?.[1]
  const url = get('url')
  const hash = get('x')
  const mimeType = get('m')
  const sizeStr = get('size')
  const subjectNpub = get('subject')
  const tier = get('tier') as PrivacyTier | undefined

  if (!url || !hash || !mimeType || !sizeStr || !subjectNpub || !tier) return null
  if (!/^[0-9a-f]{64}$/i.test(hash)) return null

  const size = parseInt(sizeStr, 10)
  if (isNaN(size) || size < 0) return null

  if (!['public', 'family', 'private'].includes(tier)) return null

  return { url, hash, mimeType, size, subjectNpub, tier }
}

// ─── Hash verification ────────────────────────────────────────────────────────

/**
 * Compute the SHA-256 hash of a Uint8Array in hex.
 * Works in both Node (crypto) and browser (SubtleCrypto).
 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isNode = typeof (globalThis as any).process?.versions?.node === 'string'
  if (isNode) {
    const { createHash } = await import('node:crypto')
    return createHash('sha256').update(data).digest('hex')
  }
  const hashBuf = await crypto.subtle.digest('SHA-256', data.buffer as ArrayBuffer)
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Verify that a downloaded blob matches the expected hash in a BlossomRef.
 * Returns true if the hash matches; false otherwise.
 */
export async function verifyBlossomHash(data: Uint8Array, ref: BlossomRef): Promise<boolean> {
  const actual = await sha256Hex(data)
  return actual.toLowerCase() === ref.hash.toLowerCase()
}

// ─── Local Media Cache (in-memory, Stage 5) ───────────────────────────────────

export type FetchStatus = 'pending' | 'cached' | 'failed' | 'unavailable'

export interface MediaCacheEntry {
  ref: BlossomRef
  status: FetchStatus
  /** Local blob URL (browser) or file path (Electron) — set when cached */
  localUrl?: string
  fetchedAt?: number
  error?: string
}

/**
 * Minimal interface for the SQLite media cache backend.
 * Implemented by SqliteStore; allows blossom.ts to remain free of a hard
 * dependency on better-sqlite3 (which requires native compilation).
 *
 * Note: getMediaCache returns a raw row (for backwards compat with tests);
 * getAllMediaCache returns MediaCacheEntry[] for in-memory hydration.
 */
export interface MediaCacheBackend {
  upsertMediaCache(ref: BlossomRef, localPath?: string, fetchStatus?: string): void
  updateMediaFetchStatus(url: string, fetchStatus: string, localPath?: string): void
  getAllMediaCache(): MediaCacheEntry[]
}

/**
 * Media cache — in-memory by default, with optional SQLite persistence.
 * Keyed by hash. When running inside Electron, the main process injects a
 * SqliteStore backend via mediaCache.setBackend() so entries survive restarts.
 */
export class MediaCache {
  private cache: Map<string, MediaCacheEntry> = new Map()
  private backend: MediaCacheBackend | null = null

  /** Inject a persistent backend (SqliteStore in Electron). */
  setBackend(b: MediaCacheBackend): void {
    this.backend = b
    for (const entry of b.getAllMediaCache()) {
      this.cache.set(entry.ref.hash, entry)
    }
  }

  /** Record a BlossomRef as pending fetch. */
  register(ref: BlossomRef): void {
    if (!this.cache.has(ref.hash)) {
      this.cache.set(ref.hash, { ref, status: 'pending' })
      this.backend?.upsertMediaCache(ref, undefined, 'pending')
    }
  }

  /** Mark a hash as successfully cached with a local URL. */
  markCached(hash: string, localUrl: string): void {
    const entry = this.cache.get(hash)
    if (entry) {
      this.cache.set(hash, {
        ...entry,
        status: 'cached',
        localUrl,
        fetchedAt: Math.floor(Date.now() / 1000),
      })
      this.backend?.updateMediaFetchStatus(entry.ref.url, 'cached', localUrl)
    }
  }

  /** Mark a hash fetch as failed. */
  markFailed(hash: string, error: string): void {
    const entry = this.cache.get(hash)
    if (entry) {
      this.cache.set(hash, { ...entry, status: 'failed', error })
      this.backend?.updateMediaFetchStatus(entry.ref.url, 'failed')
    }
  }

  /** Mark media as unavailable (removed from Blossom server). */
  markUnavailable(hash: string): void {
    const entry = this.cache.get(hash)
    if (entry) {
      this.cache.set(hash, { ...entry, status: 'unavailable' })
      this.backend?.updateMediaFetchStatus(entry.ref.url, 'unavailable')
    }
  }

  get(hash: string): MediaCacheEntry | undefined {
    return this.cache.get(hash)
  }

  isCached(hash: string): boolean {
    return this.cache.get(hash)?.status === 'cached'
  }

  /** All entries for a given subject (by npub). */
  forSubject(subjectNpub: string): MediaCacheEntry[] {
    return Array.from(this.cache.values()).filter(
      (e) => e.ref.subjectNpub === subjectNpub,
    )
  }

  /** All cached entries accessible at the given tier. */
  forTier(tier: PrivacyTier): MediaCacheEntry[] {
    return Array.from(this.cache.values()).filter((e) => e.ref.tier === tier)
  }

  size(): number {
    return this.cache.size
  }

  /** Remove all entries — for testing. */
  clear(): void {
    this.cache.clear()
    this.backend = null
  }
}

/** App-wide singleton media cache. */
export const mediaCache = new MediaCache()

// ─── Access control ───────────────────────────────────────────────────────────

/**
 * Determine whether the current user can fetch a BlossomRef given their
 * held keys. Mirrors canAccessTier() in privacyTier.ts but scoped to media.
 */
export function canFetchMedia(ref: BlossomRef, hasFamilyKey: boolean): boolean {
  if (ref.tier === 'public') return true
  if (ref.tier === 'family') return hasFamilyKey
  // 'private' — caller must pass explicit per-resource check
  return false
}

/**
 * Return a display placeholder URL for media that cannot be fetched.
 * The actual placeholder asset lives in /assets/media-unavailable.svg.
 */
export function placeholderUrl(ref: BlossomRef): string {
  if (ref.tier === 'private') return '/assets/placeholder-private.svg'
  if (ref.tier === 'family') return '/assets/placeholder-family.svg'
  return '/assets/placeholder-unavailable.svg'
}
