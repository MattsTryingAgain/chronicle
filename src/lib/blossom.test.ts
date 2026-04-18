/**
 * Tests for blossom.ts — Blossom media reference management
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildBlossomRef,
  localBlossomUrl,
  blossomRefToTags,
  blossomRefFromTags,
  sha256Hex,
  verifyBlossomHash,
  MediaCache,
  canFetchMedia,
  placeholderUrl,
  LOCAL_BLOSSOM_URL,
} from './blossom'
import type { BlossomRef } from '../types/chronicle'

const VALID_HASH = 'a'.repeat(64)  // 64 hex chars

const SAMPLE_REF: BlossomRef = {
  hash: VALID_HASH,
  url: `${LOCAL_BLOSSOM_URL}/${VALID_HASH}`,
  mimeType: 'image/jpeg',
  size: 12345,
  tier: 'public',
  subjectNpub: 'npub1subject',
}

// ─── buildBlossomRef ──────────────────────────────────────────────────────────

describe('buildBlossomRef', () => {
  it('builds a valid ref', () => {
    const ref = buildBlossomRef(SAMPLE_REF)
    expect(ref.hash).toBe(VALID_HASH)
    expect(ref.mimeType).toBe('image/jpeg')
    expect(ref.size).toBe(12345)
  })

  it('throws on invalid hash (too short)', () => {
    expect(() => buildBlossomRef({ ...SAMPLE_REF, hash: 'abc' })).toThrow()
  })

  it('throws on invalid hash (non-hex)', () => {
    expect(() => buildBlossomRef({ ...SAMPLE_REF, hash: 'z'.repeat(64) })).toThrow()
  })

  it('throws on negative size', () => {
    expect(() => buildBlossomRef({ ...SAMPLE_REF, size: -1 })).toThrow()
  })

  it('throws on invalid URL', () => {
    expect(() => buildBlossomRef({ ...SAMPLE_REF, url: 'not-a-url' })).toThrow()
  })

  it('allows size 0', () => {
    const ref = buildBlossomRef({ ...SAMPLE_REF, size: 0 })
    expect(ref.size).toBe(0)
  })
})

// ─── localBlossomUrl ──────────────────────────────────────────────────────────

describe('localBlossomUrl', () => {
  it('constructs the correct URL', () => {
    const url = localBlossomUrl(VALID_HASH)
    expect(url).toBe(`${LOCAL_BLOSSOM_URL}/${VALID_HASH}`)
  })
})

// ─── blossomRefToTags / blossomRefFromTags ────────────────────────────────────

describe('blossomRefToTags / blossomRefFromTags', () => {
  it('round-trips a public ref', () => {
    const tags = blossomRefToTags(SAMPLE_REF)
    const parsed = blossomRefFromTags(tags)
    expect(parsed).toEqual(SAMPLE_REF)
  })

  it('round-trips a family ref', () => {
    const ref = { ...SAMPLE_REF, tier: 'family' as const }
    const parsed = blossomRefFromTags(blossomRefToTags(ref))
    expect(parsed?.tier).toBe('family')
  })

  it('round-trips a private ref', () => {
    const ref = { ...SAMPLE_REF, tier: 'private' as const }
    const parsed = blossomRefFromTags(blossomRefToTags(ref))
    expect(parsed?.tier).toBe('private')
  })

  it('returns null if required tag missing', () => {
    const tags = blossomRefToTags(SAMPLE_REF).filter((t) => t[0] !== 'x')
    expect(blossomRefFromTags(tags)).toBeNull()
  })

  it('returns null for invalid hash in tags', () => {
    const tags = blossomRefToTags(SAMPLE_REF).map((t) =>
      t[0] === 'x' ? ['x', 'badhash'] : t,
    )
    expect(blossomRefFromTags(tags)).toBeNull()
  })

  it('returns null for negative size in tags', () => {
    const tags = blossomRefToTags(SAMPLE_REF).map((t) =>
      t[0] === 'size' ? ['size', '-1'] : t,
    )
    expect(blossomRefFromTags(tags)).toBeNull()
  })

  it('returns null for invalid tier', () => {
    const tags = blossomRefToTags(SAMPLE_REF).map((t) =>
      t[0] === 'tier' ? ['tier', 'unknown'] : t,
    )
    expect(blossomRefFromTags(tags)).toBeNull()
  })

  it('produces url, x, m, size, subject, tier tags', () => {
    const tags = blossomRefToTags(SAMPLE_REF)
    const keys = tags.map((t) => t[0])
    expect(keys).toContain('url')
    expect(keys).toContain('x')
    expect(keys).toContain('m')
    expect(keys).toContain('size')
    expect(keys).toContain('subject')
    expect(keys).toContain('tier')
  })
})

// ─── sha256Hex ────────────────────────────────────────────────────────────────

describe('sha256Hex', () => {
  it('produces a 64-char hex string', async () => {
    const hash = await sha256Hex(new Uint8Array([1, 2, 3]))
    expect(hash).toHaveLength(64)
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true)
  })

  it('is deterministic', async () => {
    const data = new TextEncoder().encode('hello chronicle')
    const a = await sha256Hex(data)
    const b = await sha256Hex(data)
    expect(a).toBe(b)
  })

  it('produces different hashes for different inputs', async () => {
    const a = await sha256Hex(new Uint8Array([1]))
    const b = await sha256Hex(new Uint8Array([2]))
    expect(a).not.toBe(b)
  })
})

// ─── verifyBlossomHash ────────────────────────────────────────────────────────

describe('verifyBlossomHash', () => {
  it('returns true for matching hash', async () => {
    const data = new TextEncoder().encode('test media content')
    const hash = await sha256Hex(data)
    const ref = buildBlossomRef({ ...SAMPLE_REF, hash })
    expect(await verifyBlossomHash(data, ref)).toBe(true)
  })

  it('returns false for mismatched hash', async () => {
    const data = new TextEncoder().encode('test media content')
    // ref has wrong hash
    expect(await verifyBlossomHash(data, SAMPLE_REF)).toBe(false)
  })
})

// ─── MediaCache ───────────────────────────────────────────────────────────────

describe('MediaCache', () => {
  let cache: MediaCache

  beforeEach(() => {
    cache = new MediaCache()
  })

  it('starts empty', () => {
    expect(cache.size()).toBe(0)
  })

  it('registers a ref as pending', () => {
    cache.register(SAMPLE_REF)
    const entry = cache.get(VALID_HASH)
    expect(entry?.status).toBe('pending')
  })

  it('does not double-register same hash', () => {
    cache.register(SAMPLE_REF)
    cache.register(SAMPLE_REF)
    expect(cache.size()).toBe(1)
  })

  it('marks as cached with localUrl', () => {
    cache.register(SAMPLE_REF)
    cache.markCached(VALID_HASH, '/local/path/file.jpg')
    expect(cache.isCached(VALID_HASH)).toBe(true)
    expect(cache.get(VALID_HASH)?.localUrl).toBe('/local/path/file.jpg')
    expect(cache.get(VALID_HASH)?.fetchedAt).toBeGreaterThan(0)
  })

  it('marks as failed with error', () => {
    cache.register(SAMPLE_REF)
    cache.markFailed(VALID_HASH, 'Network error')
    expect(cache.get(VALID_HASH)?.status).toBe('failed')
    expect(cache.get(VALID_HASH)?.error).toBe('Network error')
  })

  it('marks as unavailable', () => {
    cache.register(SAMPLE_REF)
    cache.markUnavailable(VALID_HASH)
    expect(cache.get(VALID_HASH)?.status).toBe('unavailable')
  })

  it('forSubject returns entries for that npub', () => {
    cache.register(SAMPLE_REF)
    cache.register({
      ...SAMPLE_REF,
      hash: 'b'.repeat(64),
      subjectNpub: 'npub1other',
    })
    expect(cache.forSubject('npub1subject')).toHaveLength(1)
    expect(cache.forSubject('npub1other')).toHaveLength(1)
    expect(cache.forSubject('npub1nobody')).toHaveLength(0)
  })

  it('forTier returns entries for that tier', () => {
    cache.register(SAMPLE_REF) // public
    cache.register({ ...SAMPLE_REF, hash: 'b'.repeat(64), tier: 'family' })
    expect(cache.forTier('public')).toHaveLength(1)
    expect(cache.forTier('family')).toHaveLength(1)
    expect(cache.forTier('private')).toHaveLength(0)
  })

  it('clear empties the cache', () => {
    cache.register(SAMPLE_REF)
    cache.clear()
    expect(cache.size()).toBe(0)
  })
})

// ─── canFetchMedia ────────────────────────────────────────────────────────────

describe('canFetchMedia', () => {
  it('allows public media without family key', () => {
    expect(canFetchMedia(SAMPLE_REF, false)).toBe(true)
  })

  it('allows family media with family key', () => {
    expect(canFetchMedia({ ...SAMPLE_REF, tier: 'family' }, true)).toBe(true)
  })

  it('denies family media without family key', () => {
    expect(canFetchMedia({ ...SAMPLE_REF, tier: 'family' }, false)).toBe(false)
  })

  it('denies private media regardless of family key', () => {
    expect(canFetchMedia({ ...SAMPLE_REF, tier: 'private' }, true)).toBe(false)
    expect(canFetchMedia({ ...SAMPLE_REF, tier: 'private' }, false)).toBe(false)
  })
})

// ─── placeholderUrl ───────────────────────────────────────────────────────────

describe('placeholderUrl', () => {
  it('returns private placeholder for private tier', () => {
    expect(placeholderUrl({ ...SAMPLE_REF, tier: 'private' })).toContain('private')
  })

  it('returns family placeholder for family tier', () => {
    expect(placeholderUrl({ ...SAMPLE_REF, tier: 'family' })).toContain('family')
  })

  it('returns unavailable placeholder for public tier', () => {
    expect(placeholderUrl(SAMPLE_REF)).toContain('unavailable')
  })
})
