/**
 * Tests for privacyTier.ts
 *
 * Covers: family key generation, tier encryption/decryption, member admission,
 * canAccessTier, and error cases.
 */

import { describe, it, expect } from 'vitest'
import {
  generateFamilyKey,
  encodeFamilyKey,
  decodeFamilyKey,
  encryptForTier,
  decryptForTier,
  canAccessTier,
  admitMember,
  openAdmission,
  curve25519PubkeyFromNsec,
} from './privacyTier'
import { generateUserKeyMaterial } from './keys'

// ─── Family Key ───────────────────────────────────────────────────────────────

describe('generateFamilyKey', () => {
  it('returns a 32-byte Uint8Array', () => {
    const key = generateFamilyKey()
    expect(key).toBeInstanceOf(Uint8Array)
    expect(key.length).toBe(32)
  })

  it('generates distinct keys each time', () => {
    const a = generateFamilyKey()
    const b = generateFamilyKey()
    expect(encodeFamilyKey(a)).not.toBe(encodeFamilyKey(b))
  })
})

describe('encodeFamilyKey / decodeFamilyKey', () => {
  it('round-trips correctly', () => {
    const key = generateFamilyKey()
    const encoded = encodeFamilyKey(key)
    const decoded = decodeFamilyKey(encoded)
    expect(decoded).toEqual(key)
  })

  it('encoded key is a non-empty string', () => {
    const encoded = encodeFamilyKey(generateFamilyKey())
    expect(typeof encoded).toBe('string')
    expect(encoded.length).toBeGreaterThan(0)
  })
})

// ─── Tier Encryption / Decryption ─────────────────────────────────────────────

describe('encryptForTier — public', () => {
  it('returns plaintext without encryption', () => {
    const result = encryptForTier('hello world', 'public')
    expect(result.tier).toBe('public')
    expect(result.plaintext).toBe('hello world')
    expect(result.ciphertext).toBeNull()
    expect(result.nonce).toBeNull()
  })
})

describe('encryptForTier — family', () => {
  it('encrypts content and returns ciphertext + nonce', () => {
    const key = generateFamilyKey()
    const result = encryptForTier('secret data', 'family', key)
    expect(result.tier).toBe('family')
    expect(result.plaintext).toBeNull()
    expect(typeof result.ciphertext).toBe('string')
    expect(typeof result.nonce).toBe('string')
  })

  it('throws if no family key provided', () => {
    expect(() => encryptForTier('secret', 'family')).toThrow()
  })

  it('produces different ciphertext for same plaintext (random nonce)', () => {
    const key = generateFamilyKey()
    const a = encryptForTier('same', 'family', key)
    const b = encryptForTier('same', 'family', key)
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(a.nonce).not.toBe(b.nonce)
  })
})

describe('encryptForTier — private', () => {
  it('encrypts with family key (same mechanism)', () => {
    const key = generateFamilyKey()
    const result = encryptForTier('private secret', 'private', key)
    expect(result.tier).toBe('private')
    expect(result.plaintext).toBeNull()
    expect(typeof result.ciphertext).toBe('string')
  })
})

describe('decryptForTier', () => {
  it('returns plaintext for public tier', () => {
    const payload = encryptForTier('public content', 'public')
    expect(decryptForTier(payload)).toBe('public content')
  })

  it('decrypts family tier with correct key', () => {
    const key = generateFamilyKey()
    const payload = encryptForTier('family secret', 'family', key)
    expect(decryptForTier(payload, key)).toBe('family secret')
  })

  it('returns null for family tier without key', () => {
    const key = generateFamilyKey()
    const payload = encryptForTier('family secret', 'family', key)
    expect(decryptForTier(payload)).toBeNull()
  })

  it('returns null with wrong key', () => {
    const key = generateFamilyKey()
    const wrongKey = generateFamilyKey()
    const payload = encryptForTier('family secret', 'family', key)
    expect(decryptForTier(payload, wrongKey)).toBeNull()
  })

  it('round-trips private tier', () => {
    const key = generateFamilyKey()
    const payload = encryptForTier('private data', 'private', key)
    expect(decryptForTier(payload, key)).toBe('private data')
  })
})

// ─── canAccessTier ────────────────────────────────────────────────────────────

describe('canAccessTier', () => {
  it('always allows public access', () => {
    expect(canAccessTier('public', false)).toBe(true)
    expect(canAccessTier('public', true)).toBe(true)
  })

  it('requires family key for family tier', () => {
    expect(canAccessTier('family', false)).toBe(false)
    expect(canAccessTier('family', true)).toBe(true)
  })

  it('returns false for private tier (per-resource check)', () => {
    expect(canAccessTier('private', true)).toBe(false)
    expect(canAccessTier('private', false)).toBe(false)
  })
})

// ─── Member Admission (asymmetric) ────────────────────────────────────────────

describe('admitMember / openAdmission', () => {
  it('allows recipient to recover the family key', async () => {
    const alice = generateUserKeyMaterial()
    const bob = generateUserKeyMaterial()

    const familyKey = generateFamilyKey()

    // Alice gets Bob's Curve25519 pubkey
    const bobCurve25519Pub = await curve25519PubkeyFromNsec(bob.nsec)

    // Alice admits Bob
    const admission = await admitMember(familyKey, alice.nsec, bobCurve25519Pub, bob.npub)

    // Bob opens admission using Alice's Curve25519 pubkey
    const aliceCurve25519Pub = await curve25519PubkeyFromNsec(alice.nsec)
    const recovered = await openAdmission(admission, bob.nsec, aliceCurve25519Pub)

    expect(recovered).not.toBeNull()
    expect(recovered).toEqual(familyKey)
  })

  it('returns null if wrong recipient nsec used', async () => {
    const alice = generateUserKeyMaterial()
    const bob = generateUserKeyMaterial()
    const mallory = generateUserKeyMaterial()

    const familyKey = generateFamilyKey()
    const bobCurve25519Pub = await curve25519PubkeyFromNsec(bob.npub !== '' ? bob.nsec : '')
    const admission = await admitMember(familyKey, alice.nsec, bobCurve25519Pub, bob.npub)

    const aliceCurve25519Pub = await curve25519PubkeyFromNsec(alice.nsec)
    // Mallory tries to open Bob's admission — should fail
    const result = await openAdmission(admission, mallory.nsec, aliceCurve25519Pub)
    expect(result).toBeNull()
  })

  it('admission record contains admittedNpub', async () => {
    const alice = generateUserKeyMaterial()
    const bob = generateUserKeyMaterial()
    const familyKey = generateFamilyKey()
    const bobCurve = await curve25519PubkeyFromNsec(bob.nsec)
    const admission = await admitMember(familyKey, alice.nsec, bobCurve, bob.npub)
    expect(admission.admittedNpub).toBe(bob.npub)
  })
})
