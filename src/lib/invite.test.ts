import { describe, it, expect } from 'vitest'
import {
  generateInviteCode,
  parseInviteCode,
  isValidInviteCode,
} from './invite.js'
import { generateAncestorKeyPair, hexToNpub, npubToHex } from './keys.js'

const RELAY = 'wss://relay.example.com'

function kpHex(kp: { npub: string }) {
  return npubToHex(kp.npub)
}

describe('invite codes', () => {
  it('generates a string starting with chronicle:', () => {
    const kp = generateAncestorKeyPair()
    const code = generateInviteCode(kpHex(kp), RELAY)
    expect(code.startsWith('chronicle:')).toBe(true)
  })

  it('round-trips npub and relay', () => {
    const kp = generateAncestorKeyPair()
    const code = generateInviteCode(kpHex(kp), RELAY)
    const parsed = parseInviteCode(code)
    expect(parsed).not.toBeNull()
    expect(parsed!.relay).toBe(RELAY)
    expect(parsed!.npub).toMatch(/^npub1/)
  })

  it('parsed npub matches original pubkey', () => {
    const kp = generateAncestorKeyPair()
    const hex = kpHex(kp)
    const code = generateInviteCode(hex, RELAY)
    const parsed = parseInviteCode(code)!
    expect(parsed.npub).toBe(hexToNpub(hex))
  })

  it('returns null for garbage input', () => {
    expect(parseInviteCode('not-a-code')).toBeNull()
    expect(parseInviteCode('')).toBeNull()
    expect(parseInviteCode('chronicle:!!!!')).toBeNull()
  })

  it('returns null if relay is not a ws or wss URL', () => {
    const payload = JSON.stringify({ npub: 'npub1' + 'a'.repeat(58), relay: 'http://bad.com', v: 1 })
    const b64 = btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(parseInviteCode('chronicle:' + b64)).toBeNull()
  })

  it('returns null for wrong version', () => {
    const payload = JSON.stringify({ npub: 'npub1' + 'a'.repeat(58), relay: RELAY, v: 2 })
    const b64 = btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(parseInviteCode('chronicle:' + b64)).toBeNull()
  })

  it('isValidInviteCode returns true for valid code', () => {
    const kp = generateAncestorKeyPair()
    const code = generateInviteCode(kpHex(kp), RELAY)
    expect(isValidInviteCode(code)).toBe(true)
  })

  it('isValidInviteCode returns false for garbage', () => {
    expect(isValidInviteCode('garbage')).toBe(false)
  })

  it('handles ws relay URLs', () => {
    const kp = generateAncestorKeyPair()
    const code = generateInviteCode(kpHex(kp), 'ws://localhost:4869')
    const parsed = parseInviteCode(code)
    expect(parsed).not.toBeNull()
    expect(parsed!.relay).toBe('ws://localhost:4869')
  })

  it('trims whitespace around code', () => {
    const kp = generateAncestorKeyPair()
    const code = generateInviteCode(kpHex(kp), RELAY)
    expect(parseInviteCode('  ' + code + '  ')).not.toBeNull()
  })
})
