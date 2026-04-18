import { describe, it, expect, vi } from 'vitest'
import {
  buildRelayGossipTags,
  parseRelayGossipUrls,
  RelayTable,
} from './relayGossip.js'

const PEER_A = 'npub1' + 'a'.repeat(58)
const PEER_B = 'npub1' + 'b'.repeat(58)
const RELAY1 = 'wss://relay1.example.com'
const RELAY2 = 'wss://relay2.example.com'
const RELAY3 = 'ws://localhost:4869'

describe('buildRelayGossipTags', () => {
  it('includes relay tags and v tag', () => {
    const tags = buildRelayGossipTags([RELAY1, RELAY2])
    expect(tags.filter(t => t[0] === 'relay')).toHaveLength(2)
    expect(tags.find(t => t[0] === 'v')?.[1]).toBe('1')
  })

  it('filters out non-ws URLs', () => {
    const tags = buildRelayGossipTags([RELAY1, 'http://bad.com', RELAY2])
    expect(tags.filter(t => t[0] === 'relay')).toHaveLength(2)
  })

  it('empty input yields only v tag', () => {
    const tags = buildRelayGossipTags([])
    expect(tags.filter(t => t[0] === 'relay')).toHaveLength(0)
    expect(tags).toHaveLength(1)
  })
})

describe('parseRelayGossipUrls', () => {
  it('extracts relay URLs from tags', () => {
    const tags = buildRelayGossipTags([RELAY1, RELAY2])
    expect(parseRelayGossipUrls(tags)).toEqual([RELAY1, RELAY2])
  })

  it('filters non-ws URLs in tags', () => {
    const tags = [['relay', 'http://bad.com'], ['relay', RELAY1], ['v', '1']]
    expect(parseRelayGossipUrls(tags)).toEqual([RELAY1])
  })

  it('returns empty for no relay tags', () => {
    expect(parseRelayGossipUrls([['v', '1']])).toEqual([])
  })
})

describe('RelayTable', () => {
  it('starts empty', () => {
    const t = new RelayTable()
    expect(t.size()).toBe(0)
    expect(t.getAll()).toHaveLength(0)
  })

  it('ingestGossip adds new relays and returns them', () => {
    const t = new RelayTable()
    const newUrls = t.ingestGossip(PEER_A, [RELAY1, RELAY2], 0)
    expect(newUrls).toContain(RELAY1)
    expect(newUrls).toContain(RELAY2)
    expect(t.size()).toBe(2)
  })

  it('ingestGossip skips non-ws URLs', () => {
    const t = new RelayTable()
    const newUrls = t.ingestGossip(PEER_A, ['http://bad.com'], 0)
    expect(newUrls).toHaveLength(0)
    expect(t.size()).toBe(0)
  })

  it('ingestGossip rate-limits per peer', () => {
    const t = new RelayTable()
    t.ingestGossip(PEER_A, [RELAY1], 60_000) // 60s TTL
    const second = t.ingestGossip(PEER_A, [RELAY2], 60_000) // within TTL
    expect(second).toHaveLength(0)
    expect(t.size()).toBe(1) // RELAY2 not added
  })

  it('different peers not rate-limited against each other', () => {
    const t = new RelayTable()
    t.ingestGossip(PEER_A, [RELAY1], 60_000)
    const fromB = t.ingestGossip(PEER_B, [RELAY2], 60_000)
    expect(fromB).toContain(RELAY2)
  })

  it('increments mentionCount for known relays', () => {
    const t = new RelayTable()
    t.ingestGossip(PEER_A, [RELAY1], 0)
    t.ingestGossip(PEER_B, [RELAY1], 0)
    expect(t.get(RELAY1)!.mentionCount).toBe(2)
  })

  it('getRanked sorts by mention count', () => {
    const t = new RelayTable()
    t.ingestGossip(PEER_A, [RELAY1, RELAY2], 0)
    t.ingestGossip(PEER_B, [RELAY2], 0)
    const ranked = t.getRanked()
    expect(ranked[0]).toBe(RELAY2) // 2 mentions
    expect(ranked[1]).toBe(RELAY1) // 1 mention
  })

  it('addKnown adds a relay without rate-limiting', () => {
    const t = new RelayTable()
    t.addKnown(RELAY1, PEER_A)
    expect(t.has(RELAY1)).toBe(true)
  })

  it('addKnown ignores non-ws URLs', () => {
    const t = new RelayTable()
    t.addKnown('http://bad.com', PEER_A)
    expect(t.size()).toBe(0)
  })

  it('addKnown does not duplicate', () => {
    const t = new RelayTable()
    t.addKnown(RELAY1, PEER_A)
    t.addKnown(RELAY1, PEER_B)
    expect(t.size()).toBe(1)
  })

  it('selectForGossip returns up to n URLs', () => {
    const t = new RelayTable()
    const urls = Array.from({ length: 15 }, (_, i) => `wss://relay${i}.example.com`)
    t.ingestGossip(PEER_A, urls, 0)
    expect(t.selectForGossip(5)).toHaveLength(5)
  })

  it('pruneStale removes old entries', () => {
    const t = new RelayTable()
    t.addKnown(RELAY1, PEER_A)
    // Force lastSeen to be ancient
    t.get(RELAY1)!.lastSeen = 0
    t.pruneStale(1000)
    expect(t.has(RELAY1)).toBe(false)
  })

  it('pruneStale keeps recent entries', () => {
    const t = new RelayTable()
    t.addKnown(RELAY1, PEER_A)
    t.pruneStale(60_000)
    expect(t.has(RELAY1)).toBe(true)
  })
})
