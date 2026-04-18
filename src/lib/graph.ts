/**
 * Chronicle Graph Traversal
 *
 * Manages relationship claims, acknowledgements, and same-person links.
 *
 * Stage 7: The module now supports two backends:
 *   - In-memory Maps (default, used in tests and web dev build)
 *   - SQLite via SqliteStore (used in Electron; inject with setGraphBackend())
 *
 * All public functions delegate to the active backend, so callers need no changes.
 */

import type { RelationshipType, SensitiveRelationshipSubtype } from '../types/chronicle'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RelationshipClaim {
  eventId: string
  claimantPubkey: string
  subjectPubkey: string
  relatedPubkey: string
  relationship: RelationshipType
  sensitive: boolean
  subtype?: SensitiveRelationshipSubtype
  relay?: string
  createdAt: number
  retracted: boolean
}

export interface Acknowledgement {
  eventId: string
  claimEventId: string
  acknowledgerPubkey: string
  approved: boolean
  createdAt: number
}

export interface SamePersonLink {
  eventId: string
  claimantPubkey: string
  pubkeyA: string
  pubkeyB: string
  createdAt: number
  retracted: boolean
}

export interface GraphEdge {
  fromPubkey: string
  toPubkey: string
  relationship: RelationshipType
  sensitive: boolean
  subtype?: SensitiveRelationshipSubtype
  acknowledged: boolean
  claimEventId: string
}

export interface TraversalResult {
  nodes: string[]
  edges: GraphEdge[]
  truncated: boolean
}

export interface TraversalOptions {
  maxDepth?: number
  maxNodes?: number
  includeSensitive?: boolean
}

/**
 * GraphBackend — interface satisfied by both MemoryGraphStore and SqliteStore.
 * Any object implementing these methods can serve as the graph backend.
 */
export interface GraphBackend {
  addRelationship(rel: RelationshipClaim): void
  retractRelationship(eventId: string): void
  getRelationship(eventId: string): RelationshipClaim | undefined
  getRelationshipsFor(pubkey: string): RelationshipClaim[]
  getAllRelationships(): RelationshipClaim[]
  addAcknowledgement(ack: Acknowledgement): void
  getAcknowledgementsForClaim(claimEventId: string): Acknowledgement[]
  getAllAcknowledgements(): Acknowledgement[]
  addSamePersonLink(link: SamePersonLink): void
  retractSamePersonLink(eventId: string): void
  getSamePersonLinksFor(pubkey: string): SamePersonLink[]
  getAllSamePersonLinks(): SamePersonLink[]
}

// ─── In-memory backend ────────────────────────────────────────────────────────

class MemoryGraphStore implements GraphBackend {
  private _relationships = new Map<string, RelationshipClaim>()
  private _acknowledgements = new Map<string, Acknowledgement>()
  private _samePersonLinks = new Map<string, SamePersonLink>()
  private _adjacency = new Map<string, Set<string>>()

  private _index(rel: RelationshipClaim): void {
    if (!this._adjacency.has(rel.subjectPubkey)) this._adjacency.set(rel.subjectPubkey, new Set())
    if (!this._adjacency.has(rel.relatedPubkey)) this._adjacency.set(rel.relatedPubkey, new Set())
    this._adjacency.get(rel.subjectPubkey)!.add(rel.eventId)
    this._adjacency.get(rel.relatedPubkey)!.add(rel.eventId)
  }

  addRelationship(rel: RelationshipClaim): void {
    this._relationships.set(rel.eventId, rel)
    this._index(rel)
  }
  retractRelationship(eventId: string): void {
    const r = this._relationships.get(eventId)
    if (r) this._relationships.set(eventId, { ...r, retracted: true })
  }
  getRelationship(eventId: string): RelationshipClaim | undefined {
    return this._relationships.get(eventId)
  }
  getRelationshipsFor(pubkey: string): RelationshipClaim[] {
    const ids = this._adjacency.get(pubkey) ?? new Set()
    const out: RelationshipClaim[] = []
    for (const id of ids) {
      const r = this._relationships.get(id)
      if (r && !r.retracted) out.push(r)
    }
    return out
  }
  getAllRelationships(): RelationshipClaim[] {
    return Array.from(this._relationships.values())
  }

  addAcknowledgement(ack: Acknowledgement): void {
    this._acknowledgements.set(ack.eventId, ack)
  }
  getAcknowledgementsForClaim(claimEventId: string): Acknowledgement[] {
    return Array.from(this._acknowledgements.values()).filter(a => a.claimEventId === claimEventId)
  }
  getAllAcknowledgements(): Acknowledgement[] {
    return Array.from(this._acknowledgements.values())
  }

  addSamePersonLink(link: SamePersonLink): void {
    this._samePersonLinks.set(link.eventId, link)
  }
  retractSamePersonLink(eventId: string): void {
    const l = this._samePersonLinks.get(eventId)
    if (l) this._samePersonLinks.set(eventId, { ...l, retracted: true })
  }
  getSamePersonLinksFor(pubkey: string): SamePersonLink[] {
    return Array.from(this._samePersonLinks.values()).filter(
      l => !l.retracted && (l.pubkeyA === pubkey || l.pubkeyB === pubkey),
    )
  }
  getAllSamePersonLinks(): SamePersonLink[] {
    return Array.from(this._samePersonLinks.values())
  }

  reset(): void {
    this._relationships.clear()
    this._acknowledgements.clear()
    this._samePersonLinks.clear()
    this._adjacency.clear()
  }
}

// ─── Active backend (module-level singleton) ──────────────────────────────────

const _memStore = new MemoryGraphStore()
let _backend: GraphBackend = _memStore

/**
 * Inject a SQLite-backed store as the graph backend.
 * Call this from the Electron main process after constructing SqliteStore.
 * Passing null reverts to the in-memory store (useful in tests).
 */
export function setGraphBackend(backend: GraphBackend | null): void {
  _backend = backend ?? _memStore
}

/** Returns the currently active backend (for tests and diagnostics). */
export function getGraphBackend(): GraphBackend {
  return _backend
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_DEPTH = 6
const DEFAULT_MAX_NODES = 200

// ─── Public API — delegate to active backend ──────────────────────────────────

export function addRelationship(rel: RelationshipClaim): void {
  _backend.addRelationship(rel)
}
export function retractRelationship(eventId: string): void {
  _backend.retractRelationship(eventId)
}
export function getRelationship(eventId: string): RelationshipClaim | undefined {
  return _backend.getRelationship(eventId)
}
export function getRelationshipsFor(pubkey: string): RelationshipClaim[] {
  return _backend.getRelationshipsFor(pubkey)
}
export function getAllRelationships(): RelationshipClaim[] {
  return _backend.getAllRelationships()
}

export function addAcknowledgement(ack: Acknowledgement): void {
  _backend.addAcknowledgement(ack)
}
export function getAcknowledgementsForClaim(claimEventId: string): Acknowledgement[] {
  return _backend.getAcknowledgementsForClaim(claimEventId)
}
export function getAllAcknowledgements(): Acknowledgement[] {
  return _backend.getAllAcknowledgements()
}

export function addSamePersonLink(link: SamePersonLink): void {
  _backend.addSamePersonLink(link)
}
export function retractSamePersonLink(eventId: string): void {
  _backend.retractSamePersonLink(eventId)
}
export function getSamePersonLinksFor(pubkey: string): SamePersonLink[] {
  return _backend.getSamePersonLinksFor(pubkey)
}
export function getAllSamePersonLinks(): SamePersonLink[] {
  return _backend.getAllSamePersonLinks()
}

// ─── Graph traversal ─────────────────────────────────────────────────────────

function _isAcknowledged(claimEventId: string): boolean {
  return _backend.getAcknowledgementsForClaim(claimEventId).some(a => a.approved)
}

export function traverseGraph(rootPubkey: string, options: TraversalOptions = {}): TraversalResult {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES

  const visited = new Set<string>()
  const edges: GraphEdge[] = []
  const queue: Array<[string, number]> = [[rootPubkey, 0]]
  visited.add(rootPubkey)
  let truncated = false

  while (queue.length > 0) {
    const [current, depth] = queue.shift()!
    if (depth >= maxDepth) continue

    for (const rel of _backend.getRelationshipsFor(current)) {
      const neighbour = rel.subjectPubkey === current ? rel.relatedPubkey : rel.subjectPubkey
      if (!edges.find(e => e.claimEventId === rel.eventId)) {
        edges.push({
          fromPubkey: rel.subjectPubkey,
          toPubkey: rel.relatedPubkey,
          relationship: rel.relationship,
          sensitive: rel.sensitive,
          subtype: rel.subtype,
          acknowledged: _isAcknowledged(rel.eventId),
          claimEventId: rel.eventId,
        })
      }
      if (!visited.has(neighbour)) {
        if (visited.size >= maxNodes) { truncated = true; continue }
        visited.add(neighbour)
        queue.push([neighbour, depth + 1])
      }
    }
  }

  return { nodes: Array.from(visited), edges, truncated }
}

// ─── Same-person resolution ───────────────────────────────────────────────────

export function resolveCanonicalPubkey(pubkey: string, visited = new Set<string>()): string {
  if (visited.has(pubkey)) return pubkey
  visited.add(pubkey)
  const links = _backend.getSamePersonLinksFor(pubkey)
  if (links.length === 0) return pubkey
  links.sort((a, b) => a.createdAt - b.createdAt)
  const link = links[0]
  const canonical = link.pubkeyA < link.pubkeyB ? link.pubkeyA : link.pubkeyB
  if (canonical === pubkey) return pubkey
  const other = link.pubkeyA === pubkey ? link.pubkeyB : link.pubkeyA
  return resolveCanonicalPubkey(other, visited)
}

// ─── Store reset (for tests) ──────────────────────────────────────────────────

export function _resetGraphStore(): void {
  _memStore.reset()
  // If backend was replaced with SQLite in a test, also revert to memory
  _backend = _memStore
}

// ─── Serialisation ───────────────────────────────────────────────────────────

export function serialiseGraph(): object {
  const rels: Record<string, RelationshipClaim> = {}
  for (const r of _backend.getAllRelationships()) rels[r.eventId] = r
  const acks: Record<string, Acknowledgement> = {}
  for (const a of _backend.getAllAcknowledgements()) acks[a.eventId] = a
  const links: Record<string, SamePersonLink> = {}
  for (const l of _backend.getAllSamePersonLinks()) links[l.eventId] = l
  return { relationships: rels, acknowledgements: acks, samePersonLinks: links }
}

export function deserialiseGraph(data: Record<string, unknown>): void {
  _resetGraphStore()
  const rels = (data.relationships ?? {}) as Record<string, RelationshipClaim>
  const acks = (data.acknowledgements ?? {}) as Record<string, Acknowledgement>
  const links = (data.samePersonLinks ?? {}) as Record<string, SamePersonLink>
  for (const r of Object.values(rels)) addRelationship(r)
  for (const a of Object.values(acks)) addAcknowledgement(a)
  for (const l of Object.values(links)) addSamePersonLink(l)
}
