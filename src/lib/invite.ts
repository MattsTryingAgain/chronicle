/**
 * invite.ts
 *
 * Invite code generation and parsing for Chronicle.
 * An invite code encodes an npub + relay address as a compact, shareable string.
 * Format: chronicle:<base64url(JSON({npub, relay, v}))>
 *
 * QR code data is the same string — QR rendering is handled by the UI layer.
 */

import { hexToNpub } from './keys.js'

export interface InvitePayload {
  npub: string
  relay: string
  v: 1
}

export interface ParsedInvite {
  npub: string
  relay: string
}

const INVITE_PREFIX = 'chronicle:'

/**
 * Generate an invite code string from a hex pubkey and relay URL.
 */
export function generateInviteCode(hexPubkey: string, relayUrl: string): string {
  const npub = hexToNpub(hexPubkey)
  const payload: InvitePayload = { npub, relay: relayUrl, v: 1 }
  const json = JSON.stringify(payload)
  // base64url encode
  const b64 = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${INVITE_PREFIX}${b64}`
}

/**
 * Parse an invite code string. Returns null if invalid.
 */
export function parseInviteCode(code: string): ParsedInvite | null {
  try {
    const trimmed = code.trim()
    if (!trimmed.startsWith(INVITE_PREFIX)) return null
    const b64 = trimmed.slice(INVITE_PREFIX.length)
    // restore base64 padding
    const padded = b64.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (b64.length % 4)) % 4)
    const json = atob(padded)
    const payload = JSON.parse(json) as InvitePayload
    if (!payload.npub || !payload.relay || payload.v !== 1) return null
    if (!payload.npub.startsWith('npub1')) return null
    if (!payload.relay.startsWith('ws://') && !payload.relay.startsWith('wss://')) return null
    return { npub: payload.npub, relay: payload.relay }
  } catch {
    return null
  }
}

/**
 * Validate that a string is a well-formed invite code.
 */
export function isValidInviteCode(code: string): boolean {
  return parseInviteCode(code) !== null
}

/**
 * Generate QR code data URI for an invite code.
 * Uses the qrcode library if available; returns the raw invite string as fallback.
 * The UI layer is responsible for rendering — this returns the raw data string.
 */
export function inviteCodeToQrData(inviteCode: string): string {
  // Return the raw invite code — UI renders via a QR library (e.g. qrcode.react)
  return inviteCode
}
