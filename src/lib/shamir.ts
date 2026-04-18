/**
 * Chronicle Shamir's Secret Sharing — Ancestor Key Custody
 *
 * Splits an ancestor's private key into N shares with threshold T.
 * The Design Plan specifies 3-of-5 as the default configuration.
 *
 * Stage 5 scope: SSS is used ONLY for the private-tier encryption layer —
 * protecting ancestor private keys that encrypt private-tier claim data.
 * The claim/endorsement weighting system handles disputes socially;
 * ancestor private keys are not load-bearing for conflict resolution.
 *
 * Library: secrets.js-34r7h (CommonJS, available in Node + bundled by Vite)
 * The library operates on hex strings internally.
 *
 * Chronicle usage pattern:
 *   1. When a user wants to protect an ancestor key with SSS:
 *      const split = splitAncestorKey(nsecHex, holderNpubs, 3)
 *   2. Each share is sent to its holder encrypted via the contact list / inbox
 *   3. To recover: combineShares(shares) → nsecHex
 *   4. The full ancestor nsec can then be used to sign/decrypt private-tier data
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const secrets = require('secrets.js-34r7h') as {
  share: (secret: string, numShares: number, threshold: number) => string[]
  combine: (shares: string[]) => string
  str2hex: (str: string) => string
  hex2str: (hex: string) => string
}

import type { ShamirShare, ShamirSplit } from '../types/chronicle'

// ─── Default configuration ────────────────────────────────────────────────────

export const DEFAULT_SHAMIR_TOTAL = 5
export const DEFAULT_SHAMIR_THRESHOLD = 3

// ─── Split ────────────────────────────────────────────────────────────────────

/**
 * Split an ancestor private key (hex string) into Shamir shares.
 *
 * @param nsecHex    The ancestor's private key in raw hex (not bech32 nsec)
 * @param holderNpubs Array of npubs who will hold shares (length = total)
 * @param threshold  Minimum shares required to reconstruct (default 3)
 * @returns ShamirSplit containing all shares with holder assignments
 */
export function splitAncestorKey(
  nsecHex: string,
  holderNpubs: string[],
  threshold: number = DEFAULT_SHAMIR_THRESHOLD,
): ShamirSplit {
  if (holderNpubs.length < threshold) {
    throw new Error(
      `Cannot split: ${holderNpubs.length} holders but threshold is ${threshold}`,
    )
  }
  if (threshold < 2) {
    throw new Error('Threshold must be at least 2')
  }
  if (holderNpubs.length > 255) {
    throw new Error('Maximum 255 shares supported')
  }

  // secrets.js expects a hex string; nsecHex is already hex
  const rawShares = secrets.share(nsecHex, holderNpubs.length, threshold)

  const shares: ShamirShare[] = rawShares.map((share, i) => ({
    index: i + 1,
    share,
    holderNpub: holderNpubs[i],
  }))

  // Derive the ancestorNpub from the hex key — we store the subject npub
  // separately in the calling context; here we record a placeholder.
  // Callers should set ancestorNpub from the AncestorKeyPair.npub.
  return {
    ancestorNpub: '', // caller fills this in
    total: holderNpubs.length,
    threshold,
    shares,
  }
}

/**
 * Convenience overload that accepts the ancestorNpub to set on the result.
 */
export function splitAncestorKeyFor(
  ancestorNpub: string,
  nsecHex: string,
  holderNpubs: string[],
  threshold: number = DEFAULT_SHAMIR_THRESHOLD,
): ShamirSplit {
  const split = splitAncestorKey(nsecHex, holderNpubs, threshold)
  return { ...split, ancestorNpub }
}

// ─── Combine ──────────────────────────────────────────────────────────────────

/**
 * Reconstruct an ancestor private key from a sufficient set of shares.
 * Requires at least `threshold` shares.
 *
 * @param shares   Array of ShamirShare objects (need at least threshold)
 * @returns The original nsecHex, or throws if insufficient/corrupt shares
 */
export function combineShares(shares: ShamirShare[]): string {
  if (shares.length < 2) {
    throw new Error('At least 2 shares are required to combine')
  }
  try {
    const rawShares = shares.map((s) => s.share)
    return secrets.combine(rawShares)
  } catch (e) {
    throw new Error(`Share combination failed: ${(e as Error).message}`)
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Verify a recovered key matches the expected hex value.
 * Used after combine to confirm the recovery succeeded.
 */
export function verifyRecoveredKey(recovered: string, expected: string): boolean {
  // Normalise to lowercase hex for comparison
  return recovered.toLowerCase() === expected.toLowerCase()
}

/**
 * Check whether a ShamirSplit has enough shares to attempt reconstruction.
 */
export function hasEnoughShares(
  availableShares: ShamirShare[],
  threshold: number,
): boolean {
  return availableShares.length >= threshold
}

/**
 * Extract the share belonging to a specific holder.
 */
export function getShareForHolder(
  split: ShamirSplit,
  holderNpub: string,
): ShamirShare | undefined {
  return split.shares.find((s) => s.holderNpub === holderNpub)
}

/**
 * Describe a ShamirSplit in human-readable terms.
 * Returns a string suitable for the UI (not i18n — caller wraps).
 */
export function describeSplit(split: ShamirSplit): string {
  return `${split.threshold}-of-${split.total} split for ${split.ancestorNpub || 'ancestor'}`
}
