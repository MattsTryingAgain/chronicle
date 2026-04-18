import { describe, it, expect } from 'vitest'
import {
  KIND_JOIN_REQUEST,
  KIND_JOIN_ACCEPT,
  buildJoinRequestTags,
  buildJoinAcceptTags,
  parseJoinRequest,
  parseJoinAccept,
  JoinRequestQueue,
} from './joinRequest.js'
import { generateAncestorKeyPair, npubToHex } from './keys.js'

const RELAY = 'wss://relay.example.com'

function makeRawRequest(overrides: Partial<{
  kind: number; pubkey: string; tags: string[][]; created_at: number; id: string
}> = {}) {
  const kp = generateAncestorKeyPair()
  const targetKp = generateAncestorKeyPair()
  return {
    kind: KIND_JOIN_REQUEST,
    pubkey: npubToHex(kp.npub),
    tags: buildJoinRequestTags(targetKp.npub, RELAY, 'Alice'),
    created_at: 1_000_000,
    id: 'event-id-' + Math.random().toString(36).slice(2),
    ...overrides,
  }
}

function makeRawAccept(requestEventId: string, overrides: Partial<{
  kind: number; pubkey: string; tags: string[][]; created_at: number
}> = {}) {
  const kp = generateAncestorKeyPair()
  const requesterKp = generateAncestorKeyPair()
  return {
    kind: KIND_JOIN_ACCEPT,
    pubkey: npubToHex(kp.npub),
    tags: buildJoinAcceptTags(requesterKp.npub, requestEventId, RELAY),
    created_at: 1_000_001,
    ...overrides,
  }
}

describe('buildJoinRequestTags', () => {
  it('includes target, relay, display_name, v', () => {
    const kp = generateAncestorKeyPair()
    const tags = buildJoinRequestTags(kp.npub, RELAY, 'Alice')
    expect(tags.find(t => t[0] === 'target')?.[1]).toBe(kp.npub)
    expect(tags.find(t => t[0] === 'relay')?.[1]).toBe(RELAY)
    expect(tags.find(t => t[0] === 'display_name')?.[1]).toBe('Alice')
    expect(tags.find(t => t[0] === 'v')?.[1]).toBe('1')
  })
})

describe('buildJoinAcceptTags', () => {
  it('includes requester, request_event, relay, v', () => {
    const kp = generateAncestorKeyPair()
    const tags = buildJoinAcceptTags(kp.npub, 'req-event-123', RELAY)
    expect(tags.find(t => t[0] === 'requester')?.[1]).toBe(kp.npub)
    expect(tags.find(t => t[0] === 'request_event')?.[1]).toBe('req-event-123')
    expect(tags.find(t => t[0] === 'relay')?.[1]).toBe(RELAY)
    expect(tags.find(t => t[0] === 'v')?.[1]).toBe('1')
  })
})

describe('parseJoinRequest', () => {
  it('parses a valid request', () => {
    const raw = makeRawRequest()
    const req = parseJoinRequest(raw)
    expect(req).not.toBeNull()
    expect(req!.displayName).toBe('Alice')
    expect(req!.requesterRelay).toBe(RELAY)
    expect(req!.status).toBe('pending')
    expect(req!.eventId).toBe(raw.id)
  })

  it('returns null for wrong kind', () => {
    expect(parseJoinRequest(makeRawRequest({ kind: 30078 }))).toBeNull()
  })

  it('returns null for missing relay tag', () => {
    const raw = makeRawRequest()
    raw.tags = raw.tags.filter(t => t[0] !== 'relay')
    expect(parseJoinRequest(raw)).toBeNull()
  })

  it('returns null for missing display_name tag', () => {
    const raw = makeRawRequest()
    raw.tags = raw.tags.filter(t => t[0] !== 'display_name')
    expect(parseJoinRequest(raw)).toBeNull()
  })

  it('returns null for non-ws relay URL', () => {
    const raw = makeRawRequest()
    raw.tags = raw.tags.map(t => t[0] === 'relay' ? ['relay', 'http://bad.com'] : t)
    expect(parseJoinRequest(raw)).toBeNull()
  })

  it('sets requesterNpub from pubkey', () => {
    const kp = generateAncestorKeyPair()
    const raw = makeRawRequest({ pubkey: npubToHex(kp.npub) })
    const req = parseJoinRequest(raw)
    expect(req!.requesterNpub).toBe(kp.npub)
  })
})

describe('parseJoinAccept', () => {
  it('parses a valid accept', () => {
    const accept = parseJoinAccept(makeRawAccept('req-123'))
    expect(accept).not.toBeNull()
    expect(accept!.requestEventId).toBe('req-123')
    expect(accept!.acceptorRelay).toBe(RELAY)
  })

  it('returns null for wrong kind', () => {
    expect(parseJoinAccept(makeRawAccept('id', { kind: 30078 }))).toBeNull()
  })

  it('returns null for missing relay tag', () => {
    const raw = makeRawAccept('id')
    raw.tags = raw.tags.filter(t => t[0] !== 'relay')
    expect(parseJoinAccept(raw)).toBeNull()
  })

  it('returns null for missing request_event tag', () => {
    const raw = makeRawAccept('id')
    raw.tags = raw.tags.filter(t => t[0] !== 'request_event')
    expect(parseJoinAccept(raw)).toBeNull()
  })
})

describe('JoinRequestQueue', () => {
  function makeReq(id: string, status: 'pending' | 'accepted' | 'rejected' | 'expired' = 'pending') {
    const raw = makeRawRequest({ id })
    const req = parseJoinRequest(raw)!
    req.status = status
    return req
  }

  it('starts empty', () => {
    const q = new JoinRequestQueue()
    expect(q.getAll()).toHaveLength(0)
    expect(q.size()).toBe(0)
  })

  it('adds and retrieves requests', () => {
    const q = new JoinRequestQueue()
    const req = makeReq('ev-1')
    q.add(req)
    expect(q.get('ev-1')).toBeDefined()
    expect(q.size()).toBe(1)
  })

  it('getPending filters correctly', () => {
    const q = new JoinRequestQueue()
    q.add(makeReq('ev-1', 'pending'))
    q.add(makeReq('ev-2', 'accepted'))
    expect(q.getPending()).toHaveLength(1)
    expect(q.getPending()[0].eventId).toBe('ev-1')
  })

  it('accept() sets status to accepted', () => {
    const q = new JoinRequestQueue()
    q.add(makeReq('ev-1'))
    q.accept('ev-1')
    expect(q.get('ev-1')!.status).toBe('accepted')
  })

  it('reject() sets status to rejected', () => {
    const q = new JoinRequestQueue()
    q.add(makeReq('ev-1'))
    q.reject('ev-1')
    expect(q.get('ev-1')!.status).toBe('rejected')
  })

  it('purgeExpired() marks old pending requests as expired', () => {
    const q = new JoinRequestQueue()
    // Very old request: created_at far in the past (unix seconds)
    const raw = makeRawRequest({ id: 'old', created_at: 1 })
    q.add(parseJoinRequest(raw)!)
    q.purgeExpired(1000) // 1 second TTL — old event will be expired
    expect(q.get('old')!.status).toBe('expired')
  })

  it('purgeExpired() leaves recent requests alone', () => {
    const q = new JoinRequestQueue()
    const raw = makeRawRequest({ created_at: Math.floor(Date.now() / 1000) })
    q.add(parseJoinRequest(raw)!)
    q.purgeExpired()
    expect(q.getPending()).toHaveLength(1)
  })
})
