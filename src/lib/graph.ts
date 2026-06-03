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
import { store } from './storage'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RelationshipClaim {
  eventId: string
  claimantPubkey: string  // session npub of whoever created this claim
  subjectId: string      // person ID (UUID for ancestors, npub for living user)
  relatedId: string      // person ID of the other person
  relationship: RelationshipType
  sensitive: boolean
  subtype?: SensitiveRelationshipSubtype
  meta?: import('../types/chronicle').RelationshipMeta
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
  claimantPubkey: string  // session npub of whoever published this link
  /** Local person ID on this instance for the first person in the pair. */
  idA: string
  /** Local person ID on this instance for the second person in the pair. */
  idB: string
  /** Remote person ID from the other instance for idA (if known). */
  remoteIdA?: string
  /** Remote person ID from the other instance for idB (if known). */
  remoteIdB?: string
  /** npub of the creator of the remote record for idA. */
  creatorNpubA?: string
  /** npub of the creator of the remote record for idB. */
  creatorNpubB?: string
  createdAt: number
  retracted: boolean
}

export interface GraphEdge {
  fromId: string   // person ID
  toId: string     // person ID
  relationship: RelationshipType
  sensitive: boolean
  subtype?: SensitiveRelationshipSubtype
  acknowledged: boolean
  claimEventId: string
  meta?: import('../types/chronicle').RelationshipMeta
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
  getRelationshipsFor(personId: string): RelationshipClaim[]
  getAllRelationships(): RelationshipClaim[]
  addAcknowledgement(ack: Acknowledgement): void
  getAcknowledgementsForClaim(claimEventId: string): Acknowledgement[]
  getAllAcknowledgements(): Acknowledgement[]
  addSamePersonLink(link: SamePersonLink): void
  retractSamePersonLink(eventId: string): void
  getSamePersonLinksFor(personId: string): SamePersonLink[]
  getAllSamePersonLinks(): SamePersonLink[]
}

// ─── In-memory backend ────────────────────────────────────────────────────────

class MemoryGraphStore implements GraphBackend {
  private _relationships = new Map<string, RelationshipClaim>()
  private _acknowledgements = new Map<string, Acknowledgement>()
  private _samePersonLinks = new Map<string, SamePersonLink>()
  private _adjacency = new Map<string, Set<string>>()

  private _index(rel: RelationshipClaim): void {
    if (!this._adjacency.has(rel.subjectId)) this._adjacency.set(rel.subjectId, new Set())
    if (!this._adjacency.has(rel.relatedId)) this._adjacency.set(rel.relatedId, new Set())
    this._adjacency.get(rel.subjectId)!.add(rel.eventId)
    this._adjacency.get(rel.relatedId)!.add(rel.eventId)
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
  getRelationshipsFor(personId: string): RelationshipClaim[] {
    const ids = this._adjacency.get(personId) ?? new Set()
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
  getSamePersonLinksFor(personId: string): SamePersonLink[] {
    return Array.from(this._samePersonLinks.values()).filter(
      l => !l.retracted && (l.idA === personId || l.idB === personId),
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
export function getRelationshipsFor(personId: string): RelationshipClaim[] {
  return _backend.getRelationshipsFor(personId)
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
export function getSamePersonLinksFor(personId: string): SamePersonLink[] {
  return _backend.getSamePersonLinksFor(personId)
}
export function getAllSamePersonLinks(): SamePersonLink[] {
  return _backend.getAllSamePersonLinks()
}

// ─── Graph traversal ─────────────────────────────────────────────────────────

function _isAcknowledged(claimEventId: string): boolean {
  return _backend.getAcknowledgementsForClaim(claimEventId).some(a => a.approved)
}

export function traverseGraph(rootId: string, options: TraversalOptions = {}): TraversalResult {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES

  const visited = new Set<string>()
  const edges: GraphEdge[] = []
  const queue: Array<[string, number]> = [[rootId, 0]]
  visited.add(rootId)
  let truncated = false

  while (queue.length > 0) {
    const [current, depth] = queue.shift()!
    if (depth >= maxDepth) continue

    // Also query relationships for all alias IDs of this node — handles the case
    // where a relationship was stored against a different UUID for the same person
    // (e.g. added before a same-person link was confirmed).
    const aliasIds = resolveAliasIds(current)

    for (const queryId of aliasIds) {
      for (const rel of _backend.getRelationshipsFor(queryId)) {
        const neighbour = rel.subjectId === queryId ? rel.relatedId : rel.subjectId
        // Normalise edge to use the canonical (visited) ID for the current node
        const normFromId = aliasIds.has(rel.subjectId) ? current : rel.subjectId
        const normToId   = aliasIds.has(rel.relatedId) ? current : rel.relatedId
        if (!edges.find(e => e.claimEventId === rel.eventId)) {
          edges.push({
            fromId: normFromId,
            toId: normToId,
            relationship: rel.relationship,
            sensitive: rel.sensitive,
            subtype: rel.subtype,
            acknowledged: _isAcknowledged(rel.eventId),
            claimEventId: rel.eventId,
            meta: rel.meta,
          })
        }
        // Resolve neighbour through alias — if the neighbour is an alias of a
        // visited node, skip it; otherwise enqueue the canonical form.
        const neighbourAliases = resolveAliasIds(neighbour)
        const alreadyVisited = Array.from(neighbourAliases).some(a => visited.has(a))
        if (!alreadyVisited) {
          if (visited.size >= maxNodes) { truncated = true; continue }
          visited.add(neighbour)
          queue.push([neighbour, depth + 1])
        }
      }
    }
  }

  return { nodes: Array.from(visited), edges, truncated }
}

// ─── Same-person resolution ───────────────────────────────────────────────────

/**
 * Returns all local person IDs that are known to refer to the same real
 * individual as `personId` (via same-person links). Includes `personId` itself.
 *
 * This replaces the old resolveCanonicalPubkey — there is no single winner;
 * each instance keeps its own ID and records aliases for the other.
 */
export function resolveAliasIds(personId: string, visited = new Set<string>()): Set<string> {
  if (visited.has(personId)) return visited
  visited.add(personId)
  // Graph same-person links (kind 30083 events)
  const links = _backend.getSamePersonLinksFor(personId)
  for (const link of links) {
    const other = link.idA === personId ? link.idB : link.idA
    resolveAliasIds(other, visited)
  }
  // Store alias table (populated by reconcilePersonAliases and tryAutoAliasContact)
  // This covers the common case where reconciliation happened without a kind-30083 event.
  const canonical = store.resolvePersonId(personId)
  if (canonical && canonical !== personId && !visited.has(canonical)) {
    resolveAliasIds(canonical, visited)
  }
  for (const alias of store.getAliasesFor(canonical ?? personId)) {
    if (!visited.has(alias.remoteId)) {
      resolveAliasIds(alias.remoteId, visited)
    }
  }
  return visited
}

/**
 * Returns true if two person IDs are known to refer to the same individual
 * (directly or transitively via same-person links).
 */
export function areAliases(idA: string, idB: string): boolean {
  if (idA === idB) return true
  const group = resolveAliasIds(idA)
  return group.has(idB)
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
  // Note: SamePersonLink now uses idA/idB (local person IDs) not pubkeys
  return { relationships: rels, acknowledgements: acks, samePersonLinks: links }
}

export function deserialiseGraph(data: Record<string, unknown>): void {
  _resetGraphStore()
  const rawRels = (data.relationships ?? {}) as Record<string, Record<string, unknown>>
  const acks = (data.acknowledgements ?? {}) as Record<string, Acknowledgement>
  const rawLinks = (data.samePersonLinks ?? {}) as Record<string, Record<string, unknown>>

  // ── Migration: pre-v1.0.87 RelationshipClaim used subjectPubkey/relatedPubkey
  for (const r of Object.values(rawRels)) {
    if (!r.subjectId && r.subjectPubkey) r.subjectId = r.subjectPubkey
    if (!r.relatedId && r.relatedPubkey) r.relatedId = r.relatedPubkey
    addRelationship(r as unknown as RelationshipClaim)
  }

  for (const a of Object.values(acks)) addAcknowledgement(a)

  // ── Migration: pre-v1.0.87 SamePersonLink used pubkeyA/pubkeyB
  for (const l of Object.values(rawLinks)) {
    if (!l.idA && l.pubkeyA) l.idA = l.pubkeyA
    if (!l.idB && l.pubkeyB) l.idB = l.pubkeyB
    addSamePersonLink(l as unknown as SamePersonLink)
  }
}
