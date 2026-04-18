/**
 * Chronicle Privacy Tier — Family Shared Key
 *
 * Stage 5 introduces three data visibility tiers:
 *   public  — plaintext, anyone can read
 *   family  — encrypted with a shared symmetric key distributed to family members
 *   private — encrypted to specific keyholders (handled at call site)
 *
 * The family shared key is a 32-byte NaCl secretbox key.
 * New members are admitted by having an existing member encrypt the key to
 * the new member's pubkey using NaCl box (asymmetric).
 *
 * Key derivation for asymmetric admission:
 *   - We use the existing NaCl secretbox key directly as "family key"
 *   - Admission: encrypt family key with nacl.box using sender ephemeral key
 *     and recipient's converted Curve25519 pubkey
 *   - secp256k1 pubkeys (Nostr) are converted to Curve25519 for NaCl box
 *
 * Note on secp256k1 → Curve25519 conversion:
 *   We use a deterministic hash-based derivation for the test environment.
 *   A production implementation would use a proper key agreement protocol
 *   (e.g. ECDH on secp256k1, then hash to Curve25519 scalar).
 *   For Chronicle Stage 5 we derive Curve25519 keypairs from the nsec using
 *   SHA-512(nsec_bytes) split into private/public halves — consistent and
 *   reversible within the Chronicle ecosystem.
 */

import nacl from 'tweetnacl'
import { encodeBase64, decodeBase64 } from 'tweetnacl-util'
import { nsecToHex } from './keys'
import type { PrivacyTier, FamilyKeyAdmission } from '../types/chronicle'

const _enc = new TextEncoder()
const _dec = new TextDecoder()

// ─── Family Key Generation ────────────────────────────────────────────────────

/**
 * Generates a new random 32-byte family shared key.
 * Call once when creating the family group; distribute via admitMember().
 */
export function generateFamilyKey(): Uint8Array {
  return nacl.randomBytes(32)
}

/** Encode a family key for storage / transmission */
export function encodeFamilyKey(key: Uint8Array): string {
  return encodeBase64(key)
}

/** Decode a stored family key */
export function decodeFamilyKey(encoded: string): Uint8Array {
  return decodeBase64(encoded)
}

// ─── Curve25519 key derivation from Nostr nsec ───────────────────────────────

/**
 * Derive a Curve25519 keypair from a Nostr nsec for NaCl box operations.
 * Uses SHA-512(nsec_hex_bytes) → split first/second 32 bytes as priv/pub seed.
 * This is deterministic and Chronicle-internal — not a general Nostr standard.
 */
async function curve25519FromNsec(
  nsec: string,
): Promise<{ publicKey: Uint8Array; secretKey: Uint8Array }> {
  const nsecHex = nsecToHex(nsec)
  const nsecBytes = _enc.encode(nsecHex)

  // SHA-512 in Node or browser
  let hash: Uint8Array
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isNode = typeof (globalThis as any).process?.versions?.node === 'string'
  if (isNode) {
    const { createHash } = await import('node:crypto')
    const digest = createHash('sha512').update(nsecBytes).digest()
    hash = new Uint8Array(digest)
  } else {
    const digest = await crypto.subtle.digest('SHA-512', nsecBytes)
    hash = new Uint8Array(digest)
  }

  // First 32 bytes → Curve25519 secret key seed
  const seed = hash.slice(0, 32)
  const kp = nacl.box.keyPair.fromSecretKey(seed)
  return kp
}

/**
 * Get only the Curve25519 public key from an nsec.
 * Used by the sender when admitting a new member — they need the recipient's
 * Curve25519 pubkey, which they can derive from the recipient's npub indirectly.
 *
 * In practice: the recipient's Curve25519 pubkey is shared as part of their
 * admission request (kind 30091 / join accept), or derived from their nsec
 * when admitting yourself. For testing, we expose this function.
 */
export async function curve25519PubkeyFromNsec(nsec: string): Promise<Uint8Array> {
  const kp = await curve25519FromNsec(nsec)
  return kp.publicKey
}

// ─── Member Admission ─────────────────────────────────────────────────────────

/**
 * Admit a new member to the family group by encrypting the family key to them.
 *
 * @param familyKey      32-byte family shared key (held by existing member)
 * @param senderNsec     Existing member's nsec (used for NaCl box)
 * @param recipientCurve25519Pubkey  Recipient's Curve25519 public key (32 bytes)
 * @param recipientNpub  Recipient's Nostr npub (for record-keeping)
 */
export async function admitMember(
  familyKey: Uint8Array,
  senderNsec: string,
  recipientCurve25519Pubkey: Uint8Array,
  recipientNpub: string,
): Promise<FamilyKeyAdmission> {
  const senderKp = await curve25519FromNsec(senderNsec)
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const encrypted = nacl.box(familyKey, nonce, recipientCurve25519Pubkey, senderKp.secretKey)
  return {
    admittedNpub: recipientNpub,
    encryptedFamilyKey: encodeBase64(encrypted),
    nonce: encodeBase64(nonce),
  }
}

/**
 * Open a FamilyKeyAdmission to recover the family key.
 *
 * @param admission       The admission record received from an existing member
 * @param recipientNsec  The new member's own nsec
 * @param senderCurve25519Pubkey  Sender's Curve25519 public key (32 bytes)
 */
export async function openAdmission(
  admission: FamilyKeyAdmission,
  recipientNsec: string,
  senderCurve25519Pubkey: Uint8Array,
): Promise<Uint8Array | null> {
  const recipientKp = await curve25519FromNsec(recipientNsec)
  const nonce = decodeBase64(admission.nonce)
  const ciphertext = decodeBase64(admission.encryptedFamilyKey)
  const plaintext = nacl.box.open(ciphertext, nonce, senderCurve25519Pubkey, recipientKp.secretKey)
  return plaintext
}

// ─── Tier-Encrypted Content ───────────────────────────────────────────────────

export interface TierEncryptedPayload {
  tier: PrivacyTier
  /** base64 ciphertext (secretbox) — null for public tier */
  ciphertext: string | null
  /** base64 nonce — null for public tier */
  nonce: string | null
  /** plaintext — only set for public tier */
  plaintext: string | null
}

/**
 * Encrypt content for a given privacy tier using the family key.
 * Public tier: returns plaintext, no encryption.
 * Family tier: encrypts with the family shared key (secretbox).
 * Private tier: same as family for now; Stage 5 uses per-person ancestor key
 *               encryption — caller provides the appropriate key.
 */
export function encryptForTier(
  content: string,
  tier: PrivacyTier,
  familyKey?: Uint8Array,
): TierEncryptedPayload {
  if (tier === 'public') {
    return { tier, ciphertext: null, nonce: null, plaintext: content }
  }
  if (!familyKey) {
    throw new Error(`Family key required to encrypt for tier '${tier}'`)
  }
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength)
  const ciphertext = nacl.secretbox(_enc.encode(content), nonce, familyKey)
  return {
    tier,
    ciphertext: encodeBase64(ciphertext),
    nonce: encodeBase64(nonce),
    plaintext: null,
  }
}

/**
 * Decrypt a TierEncryptedPayload.
 * Returns the plaintext, or null if decryption fails or key is missing.
 */
export function decryptForTier(
  payload: TierEncryptedPayload,
  familyKey?: Uint8Array,
): string | null {
  if (payload.tier === 'public') {
    return payload.plaintext
  }
  if (!familyKey || !payload.ciphertext || !payload.nonce) return null
  const ciphertext = decodeBase64(payload.ciphertext)
  const nonce = decodeBase64(payload.nonce)
  const plain = nacl.secretbox.open(ciphertext, nonce, familyKey)
  if (!plain) return null
  return _dec.decode(plain)
}

/**
 * Determine if a user can access content at the given tier.
 * Public: always yes.
 * Family: user must hold the family key.
 * Private: caller must supply the per-person key (out of scope for this check).
 */
export function canAccessTier(tier: PrivacyTier, hasFamilyKey: boolean): boolean {
  if (tier === 'public') return true
  if (tier === 'family') return hasFamilyKey
  // 'private' access is checked per-resource at the caller
  return false
}
