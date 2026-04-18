/**
 * Chronicle Key Utilities — Unit Tests
 *
 * Tests cover all cryptographic operations before any UI is built on top.
 * Pure functions with clear inputs and expected outputs.
 */

import { describe, it, expect } from 'vitest'
import {
  generateUserMnemonic,
  validateUserMnemonic,
  deriveKeyMaterialFromMnemonic,
  generateUserKeyMaterial,
  generateAncestorKeyPair,
  npubToHex,
  nsecToHex,
  hexToNpub,
  hexToNsec,
  nsecToNpub,
  importKeyMaterial,
  signEvent,
  verifyEventSignature,
} from './keys'
import { EventKind } from '../types/chronicle'

// ─── Known test vector ───────────────────────────────────────────────────────
// NIP-06 test vector — mnemonic → expected pubkey hex
const KNOWN_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
// Expected pubkey from NIP-06 derivation at m/44'/1237'/0'/0/0
const KNOWN_PUBKEY_HEX = '2bf15d2b0d3d1ee22d33bd2fca6e42b3ded5c3aa1e862cb49d7a3f43cd3a7b7a'

// ─── Mnemonic generation ─────────────────────────────────────────────────────

describe('generateUserMnemonic', () => {
  it('returns a 12-word mnemonic', () => {
    const mnemonic = generateUserMnemonic()
    const words = mnemonic.trim().split(/\s+/)
    expect(words).toHaveLength(12)
  })

  it('returns a valid BIP39 mnemonic', () => {
    const mnemonic = generateUserMnemonic()
    expect(validateUserMnemonic(mnemonic)).toBe(true)
  })

  it('generates unique mnemonics on each call', () => {
    const a = generateUserMnemonic()
    const b = generateUserMnemonic()
    expect(a).not.toBe(b)
  })
})

// ─── Mnemonic validation ──────────────────────────────────────────────────────

describe('validateUserMnemonic', () => {
  it('accepts a valid 12-word mnemonic', () => {
    expect(validateUserMnemonic(KNOWN_MNEMONIC)).toBe(true)
  })

  it('rejects an invalid mnemonic', () => {
    expect(validateUserMnemonic('these are not valid bip39 words at all here')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(validateUserMnemonic('')).toBe(false)
  })

  it('is tolerant of extra whitespace', () => {
    expect(validateUserMnemonic(`  ${KNOWN_MNEMONIC}  `)).toBe(true)
  })
})

// ─── Key derivation ───────────────────────────────────────────────────────────

describe('deriveKeyMaterialFromMnemonic', () => {
  it('returns npub and nsec in bech32 format', () => {
    const km = deriveKeyMaterialFromMnemonic(KNOWN_MNEMONIC)
    expect(km.npub).toMatch(/^npub1/)
    expect(km.nsec).toMatch(/^nsec1/)
  })

  it('returns the original mnemonic normalised', () => {
    const km = deriveKeyMaterialFromMnemonic(KNOWN_MNEMONIC)
    expect(km.mnemonic).toBe(KNOWN_MNEMONIC)
  })

  it('is deterministic — same mnemonic always gives same keys', () => {
    const a = deriveKeyMaterialFromMnemonic(KNOWN_MNEMONIC)
    const b = deriveKeyMaterialFromMnemonic(KNOWN_MNEMONIC)
    expect(a.npub).toBe(b.npub)
    expect(a.nsec).toBe(b.nsec)
  })

  it('throws on an invalid mnemonic', () => {
    expect(() => deriveKeyMaterialFromMnemonic('invalid mnemonic words here')).toThrow()
  })

  it('derives npub consistent with nsec', () => {
    const km = deriveKeyMaterialFromMnemonic(KNOWN_MNEMONIC)
    // npub derived from nsec should match npub derived from mnemonic
    const derivedNpub = nsecToNpub(km.nsec)
    expect(derivedNpub).toBe(km.npub)
  })
})

// ─── Full key material generation ────────────────────────────────────────────

describe('generateUserKeyMaterial', () => {
  it('produces valid bech32 keys', () => {
    const km = generateUserKeyMaterial()
    expect(km.npub).toMatch(/^npub1/)
    expect(km.nsec).toMatch(/^nsec1/)
    expect(km.mnemonic.split(/\s+/)).toHaveLength(12)
  })

  it('produces unique keypairs on each call', () => {
    const a = generateUserKeyMaterial()
    const b = generateUserKeyMaterial()
    expect(a.npub).not.toBe(b.npub)
    expect(a.nsec).not.toBe(b.nsec)
  })
})

// ─── Ancestor keypair ─────────────────────────────────────────────────────────

describe('generateAncestorKeyPair', () => {
  it('returns bech32 npub and nsec', () => {
    const kp = generateAncestorKeyPair()
    expect(kp.npub).toMatch(/^npub1/)
    expect(kp.nsec).toMatch(/^nsec1/)
  })

  it('generates unique pairs', () => {
    const a = generateAncestorKeyPair()
    const b = generateAncestorKeyPair()
    expect(a.npub).not.toBe(b.npub)
  })

  it('npub and nsec are consistent with each other', () => {
    const kp = generateAncestorKeyPair()
    expect(nsecToNpub(kp.nsec)).toBe(kp.npub)
  })
})

// ─── bech32 round-trips ───────────────────────────────────────────────────────

describe('bech32 encode/decode', () => {
  it('npubToHex and hexToNpub round-trip correctly', () => {
    const km = generateUserKeyMaterial()
    const hex = npubToHex(km.npub)
    expect(hexToNpub(hex)).toBe(km.npub)
  })

  it('nsecToHex and hexToNsec round-trip correctly', () => {
    const km = generateUserKeyMaterial()
    const hex = nsecToHex(km.nsec)
    expect(hexToNsec(hex)).toBe(km.nsec)
  })

  it('npubToHex throws on nsec input', () => {
    const km = generateUserKeyMaterial()
    expect(() => npubToHex(km.nsec)).toThrow()
  })

  it('nsecToHex throws on npub input', () => {
    const km = generateUserKeyMaterial()
    expect(() => nsecToHex(km.npub)).toThrow()
  })
})

// ─── Import ───────────────────────────────────────────────────────────────────

describe('importKeyMaterial', () => {
  it('imports from a valid mnemonic', () => {
    const km = importKeyMaterial(KNOWN_MNEMONIC)
    expect(km.npub).toMatch(/^npub1/)
    expect(km.mnemonic).toBe(KNOWN_MNEMONIC)
  })

  it('imports from an nsec1 string', () => {
    const original = generateUserKeyMaterial()
    const imported = importKeyMaterial(original.nsec)
    expect(imported.npub).toBe(original.npub)
    expect(imported.mnemonic).toBe('')
  })

  it('mnemonic import matches direct derivation', () => {
    const direct = deriveKeyMaterialFromMnemonic(KNOWN_MNEMONIC)
    const imported = importKeyMaterial(KNOWN_MNEMONIC)
    expect(imported.npub).toBe(direct.npub)
    expect(imported.nsec).toBe(direct.nsec)
  })

  it('throws on invalid input', () => {
    expect(() => importKeyMaterial('not valid at all')).toThrow()
  })
})

// ─── Signing and verification ─────────────────────────────────────────────────

describe('signEvent / verifyEventSignature', () => {
  it('signs an event and produces a valid signature', () => {
    const km = generateUserKeyMaterial()
    const pubHex = npubToHex(km.npub)

    const unsigned = {
      kind: EventKind.IDENTITY_ANCHOR,
      pubkey: pubHex,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['v', '1']],
      content: '',
    }

    const signed = signEvent(unsigned, km.nsec)
    expect(signed.sig).toBeTruthy()
    expect(signed.id).toBeTruthy()
    expect(verifyEventSignature(signed)).toBe(true)
  })

  it('rejects a tampered event', () => {
    const km = generateUserKeyMaterial()
    const pubHex = npubToHex(km.npub)

    const unsigned = {
      kind: EventKind.FACT_CLAIM,
      pubkey: pubHex,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['subject', 'npub1test'], ['field', 'born'], ['value', '1930'], ['v', '1']],
      content: '',
    }

    const signed = signEvent(unsigned, km.nsec)
    // JSON round-trip strips nostr-tools' internal verifiedSymbol cache before tampering
    const tampered = { ...JSON.parse(JSON.stringify(signed)), content: 'tampered' }
    expect(verifyEventSignature(tampered)).toBe(false)
  })

  it('rejects a mismatched pubkey', () => {
    const km1 = generateUserKeyMaterial()
    const km2 = generateUserKeyMaterial()
    const pubHex1 = npubToHex(km1.npub)

    const unsigned = {
      kind: EventKind.FACT_CLAIM,
      pubkey: pubHex1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['v', '1']],
      content: '',
    }

    const signed = signEvent(unsigned, km1.nsec)
    // JSON round-trip strips the cache, then swap pubkey
    const tampered = { ...JSON.parse(JSON.stringify(signed)), pubkey: npubToHex(km2.npub) }
    expect(verifyEventSignature(tampered)).toBe(false)
  })
})
