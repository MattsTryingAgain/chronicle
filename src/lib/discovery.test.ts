import { describe, it, expect } from 'vitest'
import {
  normaliseNameFragment,
  buildDiscoveryTags,
  parseDiscoveryEvent,
  scoreDiscoveryResult,
  searchDiscoveryResults,
  deduplicateDiscoveryResults,
  type DiscoveryEvent,
} from './discovery.js'
import { generateAncestorKeyPair, npubToHex } from './keys.js'

function makeEvent(overrides: Partial<DiscoveryEvent> = {}): DiscoveryEvent {
  return {
    npub: 'npub1' + 'a'.repeat(58),
    nameFragment: 'smith',
    relay: 'wss://relay.example.com',
    createdAt: 1_000_000,
    ...overrides,
  }
}

function makeRaw(pubkeyHex: string, nameFragment: string, relay: string) {
  return {
    kind: 30085,
    pubkey: pubkeyHex,
    tags: [['name_fragment', nameFragment], ['relay', relay], ['v', '1']],
    created_at: 1_000_000,
  }
}

describe('normaliseNameFragment', () => {
  it('lowercases', () => {
    expect(normaliseNameFragment('Smith')).toBe('smith')
  })

  it('strips diacritics', () => {
    expect(normaliseNameFragment('Müller')).toBe('muller')
    expect(normaliseNameFragment('O\'Brien')).toBe('obrien')
  })

  it('removes non-alphanumeric characters', () => {
    expect(normaliseNameFragment('Mac Donald')).toBe('macdonald')
    expect(normaliseNameFragment('St. John')).toBe('stjohn')
  })

  it('caps at 32 characters', () => {
    expect(normaliseNameFragment('a'.repeat(50))).toHaveLength(32)
  })

  it('handles empty string', () => {
    expect(normaliseNameFragment('')).toBe('')
  })
})

describe('buildDiscoveryTags', () => {
  it('includes name_fragment, relay, and v tags', () => {
    const tags = buildDiscoveryTags('Smith', 'wss://relay.example.com')
    expect(tags.find(t => t[0] === 'name_fragment')?.[1]).toBe('smith')
    expect(tags.find(t => t[0] === 'relay')?.[1]).toBe('wss://relay.example.com')
    expect(tags.find(t => t[0] === 'v')?.[1]).toBe('1')
  })

  it('normalises the name fragment', () => {
    const tags = buildDiscoveryTags('O\'Brien', 'wss://relay.example.com')
    expect(tags.find(t => t[0] === 'name_fragment')?.[1]).toBe('obrien')
  })
})

describe('parseDiscoveryEvent', () => {
  it('parses a valid event', () => {
    const kp = generateAncestorKeyPair()
    const hex = npubToHex(kp.npub)
    const raw = makeRaw(hex, 'smith', 'wss://relay.example.com')
    const ev = parseDiscoveryEvent(raw)
    expect(ev).not.toBeNull()
    expect(ev!.nameFragment).toBe('smith')
    expect(ev!.relay).toBe('wss://relay.example.com')
    expect(ev!.npub).toBe(kp.npub)
  })

  it('returns null for wrong kind', () => {
    const kp = generateAncestorKeyPair()
    const raw = { ...makeRaw(npubToHex(kp.npub), 'smith', 'wss://relay.example.com'), kind: 30078 }
    expect(parseDiscoveryEvent(raw)).toBeNull()
  })

  it('returns null for missing name_fragment tag', () => {
    const kp = generateAncestorKeyPair()
    expect(parseDiscoveryEvent({
      kind: 30085, pubkey: npubToHex(kp.npub),
      tags: [['relay', 'wss://relay.example.com'], ['v', '1']], created_at: 0,
    })).toBeNull()
  })

  it('returns null for non-ws relay URL', () => {
    const kp = generateAncestorKeyPair()
    expect(parseDiscoveryEvent(makeRaw(npubToHex(kp.npub), 'smith', 'http://bad.com'))).toBeNull()
  })
})

describe('scoreDiscoveryResult', () => {
  it('exact match scores 1.0', () => {
    expect(scoreDiscoveryResult(makeEvent({ nameFragment: 'smith' }), 'smith')).toBe(1.0)
  })

  it('prefix match scores 0.9', () => {
    expect(scoreDiscoveryResult(makeEvent({ nameFragment: 'smithson' }), 'smith')).toBe(0.9)
  })

  it('substring match scores 0.7', () => {
    expect(scoreDiscoveryResult(makeEvent({ nameFragment: 'blacksmith' }), 'smith')).toBe(0.7)
  })

  it('no match scores 0', () => {
    expect(scoreDiscoveryResult(makeEvent({ nameFragment: 'jones' }), 'smith')).toBe(0)
  })

  it('empty query scores 0', () => {
    expect(scoreDiscoveryResult(makeEvent(), '')).toBe(0)
  })
})

describe('searchDiscoveryResults', () => {
  it('returns only matching events sorted by score', () => {
    const events: DiscoveryEvent[] = [
      makeEvent({ nameFragment: 'jones', npub: 'npub1' + 'b'.repeat(58) }),
      makeEvent({ nameFragment: 'smith', npub: 'npub1' + 'a'.repeat(58) }),
      makeEvent({ nameFragment: 'smithson', npub: 'npub1' + 'c'.repeat(58) }),
    ]
    const results = searchDiscoveryResults(events, 'smith')
    expect(results).toHaveLength(2)
    expect(results[0].nameFragment).toBe('smith') // highest score first
    expect(results[1].nameFragment).toBe('smithson')
  })

  it('respects limit', () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      makeEvent({ nameFragment: 'smith', npub: 'npub1' + String(i).padStart(58, 'a') })
    )
    expect(searchDiscoveryResults(events, 'smith', 3)).toHaveLength(3)
  })

  it('returns empty array for no matches', () => {
    expect(searchDiscoveryResults([makeEvent({ nameFragment: 'jones' })], 'smith')).toHaveLength(0)
  })
})

describe('deduplicateDiscoveryResults', () => {
  it('keeps highest score for duplicate npubs', () => {
    const results = [
      { npub: 'npub1aaa', nameFragment: 'smith', relay: 'wss://a.com', score: 0.7 },
      { npub: 'npub1aaa', nameFragment: 'smith', relay: 'wss://b.com', score: 0.9 },
      { npub: 'npub1bbb', nameFragment: 'smithson', relay: 'wss://c.com', score: 0.8 },
    ]
    const deduped = deduplicateDiscoveryResults(results)
    expect(deduped).toHaveLength(2)
    expect(deduped.find(r => r.npub === 'npub1aaa')!.score).toBe(0.9)
  })
})
