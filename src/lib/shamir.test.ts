/**
 * Tests for shamir.ts — Shamir's Secret Sharing for ancestor key custody
 */

import { describe, it, expect } from 'vitest'
import {
  splitAncestorKey,
  splitAncestorKeyFor,
  combineShares,
  verifyRecoveredKey,
  hasEnoughShares,
  getShareForHolder,
  describeSplit,
  DEFAULT_SHAMIR_THRESHOLD,
  DEFAULT_SHAMIR_TOTAL,
} from './shamir'
import { generateAncestorKeyPair, nsecToHex } from './keys'

// Helpers
function makeHolderNpubs(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `npub1holder${i + 1}${'0'.repeat(50)}`)
}

// A fixed test key (hex)
const TEST_KEY_HEX = 'deadbeefcafebabe0123456789abcdef0123456789abcdef0123456789abcdef'

// ─── Constants ────────────────────────────────────────────────────────────────

describe('defaults', () => {
  it('default total is 5', () => expect(DEFAULT_SHAMIR_TOTAL).toBe(5))
  it('default threshold is 3', () => expect(DEFAULT_SHAMIR_THRESHOLD).toBe(3))
})

// ─── splitAncestorKey ─────────────────────────────────────────────────────────

describe('splitAncestorKey', () => {
  it('returns the correct number of shares', () => {
    const split = splitAncestorKey(TEST_KEY_HEX, makeHolderNpubs(5), 3)
    expect(split.shares.length).toBe(5)
    expect(split.total).toBe(5)
    expect(split.threshold).toBe(3)
  })

  it('assigns holder npubs to shares', () => {
    const holders = makeHolderNpubs(5)
    const split = splitAncestorKey(TEST_KEY_HEX, holders, 3)
    split.shares.forEach((s, i) => {
      expect(s.holderNpub).toBe(holders[i])
    })
  })

  it('assigns 1-based indexes', () => {
    const split = splitAncestorKey(TEST_KEY_HEX, makeHolderNpubs(5), 3)
    const indexes = split.shares.map((s) => s.index)
    expect(indexes).toEqual([1, 2, 3, 4, 5])
  })

  it('throws if holders fewer than threshold', () => {
    expect(() => splitAncestorKey(TEST_KEY_HEX, makeHolderNpubs(2), 3)).toThrow()
  })

  it('throws if threshold < 2', () => {
    expect(() => splitAncestorKey(TEST_KEY_HEX, makeHolderNpubs(5), 1)).toThrow()
  })

  it('works with 2-of-3 split', () => {
    const split = splitAncestorKey(TEST_KEY_HEX, makeHolderNpubs(3), 2)
    expect(split.total).toBe(3)
    expect(split.threshold).toBe(2)
  })
})

describe('splitAncestorKeyFor', () => {
  it('sets ancestorNpub on result', () => {
    const npub = 'npub1ancestor000'
    const split = splitAncestorKeyFor(npub, TEST_KEY_HEX, makeHolderNpubs(5), 3)
    expect(split.ancestorNpub).toBe(npub)
  })
})

// ─── combineShares ────────────────────────────────────────────────────────────

describe('combineShares', () => {
  it('reconstructs key from exactly threshold shares', () => {
    const split = splitAncestorKey(TEST_KEY_HEX, makeHolderNpubs(5), 3)
    const recovered = combineShares(split.shares.slice(0, 3))
    expect(verifyRecoveredKey(recovered, TEST_KEY_HEX)).toBe(true)
  })

  it('reconstructs key from all shares', () => {
    const split = splitAncestorKey(TEST_KEY_HEX, makeHolderNpubs(5), 3)
    const recovered = combineShares(split.shares)
    expect(verifyRecoveredKey(recovered, TEST_KEY_HEX)).toBe(true)
  })

  it('reconstructs key from any threshold-sized subset', () => {
    const split = splitAncestorKey(TEST_KEY_HEX, makeHolderNpubs(5), 3)
    // Try shares 2, 3, 5 (indexes 1, 2, 4 zero-based)
    const recovered = combineShares([split.shares[1], split.shares[2], split.shares[4]])
    expect(verifyRecoveredKey(recovered, TEST_KEY_HEX)).toBe(true)
  })

  it('throws with fewer than 2 shares', () => {
    const split = splitAncestorKey(TEST_KEY_HEX, makeHolderNpubs(5), 3)
    expect(() => combineShares(split.shares.slice(0, 1))).toThrow()
  })

  it('round-trips a real ancestor key', () => {
    const kp = generateAncestorKeyPair()
    const nsecHex = nsecToHex(kp.nsec)
    const split = splitAncestorKeyFor(kp.npub, nsecHex, makeHolderNpubs(5), 3)
    const recovered = combineShares(split.shares.slice(0, 3))
    expect(verifyRecoveredKey(recovered, nsecHex)).toBe(true)
  })
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

describe('verifyRecoveredKey', () => {
  it('returns true for matching hex', () => {
    expect(verifyRecoveredKey(TEST_KEY_HEX, TEST_KEY_HEX)).toBe(true)
  })

  it('returns true case-insensitively', () => {
    expect(verifyRecoveredKey(TEST_KEY_HEX.toUpperCase(), TEST_KEY_HEX)).toBe(true)
  })

  it('returns false for different key', () => {
    expect(verifyRecoveredKey(TEST_KEY_HEX, 'aabbcc')).toBe(false)
  })
})

describe('hasEnoughShares', () => {
  it('returns true if count >= threshold', () => {
    const split = splitAncestorKey(TEST_KEY_HEX, makeHolderNpubs(5), 3)
    expect(hasEnoughShares(split.shares.slice(0, 3), 3)).toBe(true)
    expect(hasEnoughShares(split.shares, 3)).toBe(true)
  })

  it('returns false if count < threshold', () => {
    const split = splitAncestorKey(TEST_KEY_HEX, makeHolderNpubs(5), 3)
    expect(hasEnoughShares(split.shares.slice(0, 2), 3)).toBe(false)
    expect(hasEnoughShares([], 3)).toBe(false)
  })
})

describe('getShareForHolder', () => {
  it('returns the correct share for a holder', () => {
    const holders = makeHolderNpubs(5)
    const split = splitAncestorKey(TEST_KEY_HEX, holders, 3)
    const share = getShareForHolder(split, holders[2])
    expect(share).toBeDefined()
    expect(share!.holderNpub).toBe(holders[2])
    expect(share!.index).toBe(3)
  })

  it('returns undefined for unknown holder', () => {
    const split = splitAncestorKey(TEST_KEY_HEX, makeHolderNpubs(5), 3)
    expect(getShareForHolder(split, 'npub1unknown')).toBeUndefined()
  })
})

describe('describeSplit', () => {
  it('returns a readable string', () => {
    const split = splitAncestorKeyFor('npub1anc', TEST_KEY_HEX, makeHolderNpubs(5), 3)
    const desc = describeSplit(split)
    expect(desc).toContain('3')
    expect(desc).toContain('5')
    expect(desc).toContain('npub1anc')
  })
})
