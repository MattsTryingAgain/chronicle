/**
 * Chronicle Key Utilities
 *
 * All cryptographic key operations live here and nowhere else.
 * Derivation path for user identity: m/44'/1237'/0'/0/0
 *
 * IMPORTANT: This module never touches Nostr kind 0.
 */

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js'
import { HDKey } from '@scure/bip32'
import { schnorr } from '@noble/curves/secp256k1.js'
import { nip19, finalizeEvent, verifyEvent } from 'nostr-tools'
import type { UnsignedEvent, Event } from 'nostr-tools'
import type { KeyMaterial } from '../types/chronicle'

// ─── Nostr BIP39 derivation path ─────────────────────────────────────────────

const DERIVATION_PATH = "m/44'/1237'/0'/0/0"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return bytes
}

// ─── Mnemonic generation ─────────────────────────────────────────────────────

export function generateUserMnemonic(): string {
  return generateMnemonic(englishWordlist, 128)
}

export function validateUserMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic.trim().toLowerCase(), englishWordlist)
}

// ─── Key derivation ───────────────────────────────────────────────────────────

export function deriveKeyMaterialFromMnemonic(mnemonic: string): KeyMaterial {
  const normalised = mnemonic.trim().toLowerCase()

  if (!validateUserMnemonic(normalised)) {
    throw new Error('Invalid BIP39 mnemonic')
  }

  const seed = mnemonicToSeedSync(normalised)
  const root = HDKey.fromMasterSeed(seed)
  const child = root.derive(DERIVATION_PATH)

  if (!child.privateKey) {
    throw new Error('Key derivation failed — no private key produced')
  }

  const privKeyBytes = child.privateKey
  const pubKeyBytes = schnorr.getPublicKey(privKeyBytes)

  return {
    mnemonic: normalised,
    npub: nip19.npubEncode(bytesToHex(pubKeyBytes)),
    nsec: nip19.nsecEncode(privKeyBytes),
  }
}

export function generateUserKeyMaterial(): KeyMaterial {
  const mnemonic = generateUserMnemonic()
  return deriveKeyMaterialFromMnemonic(mnemonic)
}

// ─── Ancestor keypair ─────────────────────────────────────────────────────────

export interface AncestorKeyPair {
  npub: string
  nsec: string
}

export function generateAncestorKeyPair(): AncestorKeyPair {
  const privKeyBytes = crypto.getRandomValues(new Uint8Array(32))
  const pubKeyBytes = schnorr.getPublicKey(privKeyBytes)

  return {
    npub: nip19.npubEncode(bytesToHex(pubKeyBytes)),
    nsec: nip19.nsecEncode(privKeyBytes),
  }
}

// ─── bech32 encode / decode ───────────────────────────────────────────────────

export function npubToHex(npub: string): string {
  const decoded = nip19.decode(npub)
  if (decoded.type !== 'npub') {
    throw new Error(`Expected npub, got ${decoded.type}`)
  }
  return decoded.data
}

export function nsecToHex(nsec: string): string {
  const decoded = nip19.decode(nsec)
  if (decoded.type !== 'nsec') {
    throw new Error(`Expected nsec, got ${decoded.type}`)
  }
  return bytesToHex(decoded.data)
}

export function hexToNpub(hexPubkey: string): string {
  return nip19.npubEncode(hexPubkey)
}

export function hexToNsec(hexPrivkey: string): string {
  return nip19.nsecEncode(hexToBytes(hexPrivkey))
}

export function nsecToNpub(nsec: string): string {
  const decoded = nip19.decode(nsec)
  if (decoded.type !== 'nsec') {
    throw new Error(`Expected nsec, got ${decoded.type}`)
  }
  const pubBytes = schnorr.getPublicKey(decoded.data)
  return nip19.npubEncode(bytesToHex(pubBytes))
}

// ─── Import existing keypair ──────────────────────────────────────────────────

export function importKeyMaterial(input: string): KeyMaterial {
  const trimmed = input.trim()

  if (validateUserMnemonic(trimmed)) {
    return deriveKeyMaterialFromMnemonic(trimmed)
  }

  if (trimmed.startsWith('nsec1')) {
    const decoded = nip19.decode(trimmed)
    if (decoded.type !== 'nsec') throw new Error('Invalid nsec')
    const pubBytes = schnorr.getPublicKey(decoded.data)
    return {
      mnemonic: '',
      npub: nip19.npubEncode(bytesToHex(pubBytes)),
      nsec: trimmed,
    }
  }

  throw new Error('Input must be a BIP39 mnemonic or nsec1 private key')
}

// ─── Event signing ────────────────────────────────────────────────────────────

export function signEvent(unsignedEvent: UnsignedEvent, nsec: string): Event {
  const decoded = nip19.decode(nsec)
  if (decoded.type !== 'nsec') throw new Error('Expected nsec')
  return finalizeEvent(unsignedEvent, decoded.data)
}

export function verifyEventSignature(event: Event): boolean {
  return verifyEvent(event)
}
