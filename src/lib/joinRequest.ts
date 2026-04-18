/**
 * joinRequest.ts
 *
 * Join request handshake: claim → countersign → verified.
 *
 * Flow:
 * 1. Alice sends Bob an invite code (out of band)
 * 2. Bob parses the invite, builds a JOIN_REQUEST event, publishes to Alice's relay
 * 3. Alice receives JOIN_REQUEST, verifies Bob's signature, countersigns with a JOIN_ACCEPT
 * 4. Bob receives JOIN_ACCEPT, verifies Alice's signature → connection established
 * 5. Both add each other to their private contact lists
 *
 * Join request events use kind 30091 (Chronicle-specific, not in the original Design Plan
 * event schema but consistent with the 300xx namespace).
 */

import { hexToNpub } from './keys.js'

export const KIND_JOIN_REQUEST = 30091
export const KIND_JOIN_ACCEPT  = 30092

export type JoinRequestStatus = 'pending' | 'accepted' | 'rejected' | 'expired'

export interface JoinRequest {
  /** The requester's npub */
  requesterNpub: string
  /** The requester's relay URL */
  requesterRelay: string
  /** The requester's chosen display name */
  displayName: string
  /** Timestamp of the request */
  createdAt: number
  /** The event id of the JOIN_REQUEST event */
  eventId: string
  status: JoinRequestStatus
}

export interface JoinAccept {
  /** The acceptor's npub */
  acceptorNpub: string
  /** The acceptor's relay URL */
  acceptorRelay: string
  /** Event id of the original JOIN_REQUEST being accepted */
  requestEventId: string
  createdAt: number
}

// ---------------------------------------------------------------------------
// Tag builders (pure functions — signing is done by eventBuilder.ts)
// ---------------------------------------------------------------------------

/**
 * Build tags for a kind 30091 JOIN_REQUEST event.
 */
export function buildJoinRequestTags(
  targetNpub: string,
  requesterRelay: string,
  displayName: string,
): string[][] {
  return [
    ['target', targetNpub],
    ['relay', requesterRelay],
    ['display_name', displayName],
    ['v', '1'],
  ]
}

/**
 * Build tags for a kind 30092 JOIN_ACCEPT event.
 */
export function buildJoinAcceptTags(
  requesterNpub: string,
  requestEventId: string,
  acceptorRelay: string,
): string[][] {
  return [
    ['requester', requesterNpub],
    ['request_event', requestEventId],
    ['relay', acceptorRelay],
    ['v', '1'],
  ]
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a raw event into a JoinRequest. Returns null if malformed.
 */
export function parseJoinRequest(raw: {
  kind: number
  pubkey: string
  tags: string[][]
  created_at: number
  id: string
}): JoinRequest | null {
  if (raw.kind !== KIND_JOIN_REQUEST) return null
  const relayTag = raw.tags.find(t => t[0] === 'relay')
  const nameTag  = raw.tags.find(t => t[0] === 'display_name')
  if (!relayTag || !nameTag) return null
  if (!relayTag[1].startsWith('ws://') && !relayTag[1].startsWith('wss://')) return null
  
  return {
    requesterNpub: hexToNpub(raw.pubkey),
    requesterRelay: relayTag[1],
    displayName: nameTag[1],
    createdAt: raw.created_at,
    eventId: raw.id,
    status: 'pending',
  }
}

/**
 * Parse a raw event into a JoinAccept. Returns null if malformed.
 */
export function parseJoinAccept(raw: {
  kind: number
  pubkey: string
  tags: string[][]
  created_at: number
}): JoinAccept | null {
  if (raw.kind !== KIND_JOIN_ACCEPT) return null
  const relayTag   = raw.tags.find(t => t[0] === 'relay')
  const reqEvTag   = raw.tags.find(t => t[0] === 'request_event')
  if (!relayTag || !reqEvTag) return null
  
  return {
    acceptorNpub: hexToNpub(raw.pubkey),
    acceptorRelay: relayTag[1],
    requestEventId: reqEvTag[1],
    createdAt: raw.created_at,
  }
}

// ---------------------------------------------------------------------------
// In-memory join request queue (pending inbound requests)
// ---------------------------------------------------------------------------

export class JoinRequestQueue {
  private requests: Map<string, JoinRequest> = new Map()

  add(req: JoinRequest): void {
    this.requests.set(req.eventId, req)
  }

  get(eventId: string): JoinRequest | undefined {
    return this.requests.get(eventId)
  }

  getAll(): JoinRequest[] {
    return Array.from(this.requests.values())
  }

  getPending(): JoinRequest[] {
    return this.getAll().filter(r => r.status === 'pending')
  }

  accept(eventId: string): void {
    const req = this.requests.get(eventId)
    if (req) req.status = 'accepted'
  }

  reject(eventId: string): void {
    const req = this.requests.get(eventId)
    if (req) req.status = 'rejected'
  }

  /** Remove requests older than ttlMs (default: 7 days) */
  purgeExpired(ttlMs = 7 * 24 * 60 * 60 * 1000): void {
    const cutoff = Date.now() - ttlMs
    for (const [id, req] of this.requests) {
      if (req.createdAt * 1000 < cutoff && req.status === 'pending') {
        req.status = 'expired'
        this.requests.set(id, req)
      }
    }
  }

  size(): number {
    return this.requests.size
  }
}
