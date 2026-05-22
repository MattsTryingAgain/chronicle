/**
 * Chronicle Relay Sync — src/lib/relaySync.ts
 *
 * On connect, requests all Chronicle event kinds from the relay for known
 * pubkeys (own identity + recovery contacts + stored persons), then ingests
 * received events into the MemoryStore.
 *
 * This is how the app catches up after being offline or on first launch
 * against a relay that already has events from previous sessions.
 *
 * Called from AppContext.startRelay() once a RelayClient is connected.
 */

import { EventKind } from '../types/chronicle'
import type { ChronicleEvent, FactClaim, Endorsement, Person, FactField, RelationshipType, SensitiveRelationshipSubtype } from '../types/chronicle'
import type { RelayClient } from './relay'
import { store } from './storage'
import {
  addRelationship,
  addAcknowledgement,
  addSamePersonLink,
  getAllSamePersonLinks,
} from './graph'
import type { RelationshipClaim, Acknowledgement, SamePersonLink } from './graph'
import { schemaVersionChecker } from './schemaVersion'
import { parseJoinRequest, parseJoinAccept } from './joinRequest'
import type { JoinRequest, JoinAccept } from './joinRequest'
import { scoreMatch, alreadyLinked } from './treeLinking'

// ── Join request callbacks ────────────────────────────────────────────────────
// AppContext registers these so the UI can react to incoming handshake events
// without relaySync needing to know about React state.

type JoinRequestHandler = (req: JoinRequest) => void
type JoinAcceptHandler  = (accept: JoinAccept) => void

// Called after batches of events are ingested so the UI can re-render
let onSyncUpdate: (() => void) | null = null
export function setSyncUpdateHandler(fn: () => void): void { onSyncUpdate = fn }

// Called whenever a new high-confidence duplicate pair is detected during ingest.
let onPendingMatchFound: (() => void) | null = null
export function setPendingMatchHandler(fn: () => void): void { onPendingMatchFound = fn }

// Minimum confidence to surface an automatic dedup suggestion.
// 0.35 = exact name only. 0.60 = name + birth year (much stronger signal).
export const AUTO_DEDUP_THRESHOLD = 0.35

let onJoinRequestReceived: JoinRequestHandler | null = null
let onJoinAcceptReceived:  JoinAcceptHandler  | null = null

// Contact pubkeys provider — AppContext sets this so relaySync can include
// contact pubkeys in subscription filters without importing AppContext.
let getContactPubkeys: (() => string[]) | null = null

export function setContactPubkeysProvider(fn: () => string[]): void {
  getContactPubkeys = fn
}

export function setJoinRequestHandler(fn: JoinRequestHandler): void {
  onJoinRequestReceived = fn
}

export function setJoinAcceptHandler(fn: JoinAcceptHandler): void {
  onJoinAcceptReceived = fn
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** All Chronicle event kinds — used as the fetch filter */
const ALL_CHRONICLE_KINDS = Object.values(EventKind) as number[]

/** How long to wait for EOSE before giving up (ms) */
const SYNC_TIMEOUT_MS = 10_000

// ── Public API ────────────────────────────────────────────────────────────────

export interface SyncResult {
  received: number
  ingested: number
  errors: number
}

/**
 * Subscribe to all Chronicle events authored by known pubkeys.
 * Ingests received events into the MemoryStore.
 *
 * Returns a cleanup function that cancels the subscription.
 */
export function startSync(client: RelayClient): () => void {
  const knownPubkeys = collectKnownPubkeys()

  if (knownPubkeys.length === 0) {
    // No known pubkeys yet — nothing to fetch
    return () => {}
  }

  const filters = [
    {
      kinds: ALL_CHRONICLE_KINDS,
      authors: knownPubkeys,
      limit: 500,
    },
  ]

  const unsub = client.subscribe(filters, (event: ChronicleEvent) => {
    ingestEvent(event)
  })

  return unsub
}

/**
 * One-shot fetch: subscribe, collect events until EOSE (or timeout),
 * then unsubscribe. Resolves with a summary of what was ingested.
 *
 * Use this for an explicit "sync now" action. For background streaming,
 * use startSync() instead.
 */
export function fetchOnConnect(client: RelayClient): Promise<SyncResult> {
  return new Promise((resolve) => {
    const knownPubkeys = collectKnownPubkeys()

    const result: SyncResult = { received: 0, ingested: 0, errors: 0 }

    if (knownPubkeys.length === 0) {
      resolve(result)
      return
    }

    const filters = [
      {
        kinds: ALL_CHRONICLE_KINDS,
        authors: knownPubkeys,
        limit: 500,
      },
    ]

    let unsub: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = () => {
      if (timer) { clearTimeout(timer); timer = null }
      unsub?.()
      resolve(result)
    }

    // Wire up EOSE — relay sends this after all stored events have been returned.
    // We also keep a timeout fallback in case the relay doesn't send EOSE.
    timer = setTimeout(finish, SYNC_TIMEOUT_MS)

    unsub = client.subscribe(filters, (event: ChronicleEvent) => {
      result.received++
      const ok = ingestEvent(event)
      if (ok) result.ingested++
      else result.errors++
    }, () => finish())
  })
}

// ── Ingest ────────────────────────────────────────────────────────────────────

/**
 * Ingest a single event into the MemoryStore.
 * Handles all Chronicle event kinds. Unknown kinds are stored as raw events only.
 * Returns true if the event was stored (false if it was a duplicate).
 */
let _syncUpdatePending = false
function scheduleSyncUpdate() {
  if (_syncUpdatePending || !onSyncUpdate) return
  _syncUpdatePending = true
  setTimeout(() => { _syncUpdatePending = false; onSyncUpdate?.() }, 200)
}

export function ingestEvent(event: ChronicleEvent): boolean {
  console.log(`[ingestEvent] kind=${event.kind} from ${event.pubkey?.slice(0,8)}…`)
  // JOIN_REQUEST and JOIN_ACCEPT are never deduplicated — the callback must
  // fire every time they arrive so the UI can react even after a restart.
  const isHandshake = event.kind === EventKind.JOIN_REQUEST || event.kind === EventKind.JOIN_ACCEPT
  if (!isHandshake) {
    // Deduplicate all other events — skip if already stored
    if (store.getRawEvent(event.id)) return false
  }

  store.addRawEvent(event)
  scheduleSyncUpdate()

  // Check for newer schema versions in every ingested event
  schemaVersionChecker.ingestEvent(event)

  try {
    switch (event.kind) {
      case EventKind.IDENTITY_ANCHOR:
        ingestIdentityAnchor(event)
        break
      case EventKind.FACT_CLAIM:
        ingestFactClaim(event)
        break
      case EventKind.ENDORSEMENT:
        ingestEndorsement(event)
        break
      case EventKind.CLAIM_RETRACTION:
        ingestRetraction(event)
        break
      case EventKind.RELATIONSHIP_CLAIM:
        ingestRelationshipClaim(event)
        break
      case EventKind.ACKNOWLEDGEMENT:
        ingestAcknowledgement(event)
        break
      case EventKind.SAME_PERSON_LINK:
        ingestSamePersonLink(event)
        break
      case EventKind.JOIN_REQUEST: {
        const req = parseJoinRequest(event)
        if (req && onJoinRequestReceived) onJoinRequestReceived(req)
        break
      }
      case EventKind.JOIN_ACCEPT: {
        const accept = parseJoinAccept(event)
        if (accept && onJoinAcceptReceived) onJoinAcceptReceived(accept)
        break
      }
      default:
        break
    }
  } catch (err) {
    console.error('[relaySync] ingestEvent error for kind', event.kind, err)
  }

  return true
}

// ── Event-kind ingesters ──────────────────────────────────────────────────────

function ingestIdentityAnchor(event: ChronicleEvent): void {
  // Kind 30078: identity anchor. The pubkey IS the person identifier.
  // Only create the person stub if not already known.
  const existing = store.getPerson(event.pubkey)
  if (existing) return

  const person: Person = {
    pubkey: event.pubkey,
    displayName: event.pubkey.slice(0, 8) + '…', // placeholder until fact claim arrives
    isLiving: false,
    createdAt: event.created_at,
  }
  store.upsertPerson(person)
}

function ingestFactClaim(event: ChronicleEvent): void {
  // Kind 30081: fact claim about a subject.
  const subject = getTag(event, 'subject')
  const field = getTag(event, 'field')
  const value = getTag(event, 'value')

  if (!subject || !field || !value) return

  const KNOWN_FACT_FIELDS: FactField[] = ['name', 'born', 'died', 'birthplace', 'deathplace', 'occupation', 'bio']
  if (!KNOWN_FACT_FIELDS.includes(field as FactField)) return

  const claim: FactClaim = {
    eventId: event.id,
    subjectPubkey: subject,
    claimantPubkey: event.pubkey,
    field: field as FactField,
    value,
    evidence: getTag(event, 'evidence') ?? undefined,
    createdAt: event.created_at,
    retracted: false,
    confidenceScore: 0, // recomputed at read time
  }

  // Ensure the person exists before storing the claim — they may not have an
  // identity anchor event if they were added by a remote user who didn't publish one
  if (!store.getPerson(subject)) {
    store.upsertPerson({
      pubkey: subject,
      displayName: subject.slice(0, 8) + '…',
      isLiving: false,
      createdAt: event.created_at,
    })
  }

  store.addClaim(claim)

  // If this fact sets a name, update the person stub display name
  if (field === 'name') {
    const person = store.getPerson(subject)
    if (person) {
      store.upsertPerson({ ...person, displayName: value })
    }
  }

  // After any name or birth fact, scan for possible duplicates in the store.
  // This catches the common case where instance 1 has "Alice, b.1980" and
  // instance 2 syncs in "Alice" with no DoB — the name hit alone is enough
  // to surface a suggestion. Only fires when there's something to compare.
  if (field === 'name' || field === 'born') {
    maybeDetectDuplicate(subject)
  }
}

/**
 * Scans all existing persons for a potential duplicate of `subjectPubkey`.
 * If a high-confidence pair is found that isn't already linked or dismissed,
 * fires `onPendingMatchFound` so the UI can surface it for user review.
 *
 * Runs synchronously but is O(n) in number of persons — fine up to ~1,000.
 */
function maybeDetectDuplicate(subjectPubkey: string): void {
  if (!onPendingMatchFound) return
  const allPersons = store.getAllPersons()
  if (allPersons.length < 2) return
  const allClaims = store.getAllClaims()
  const existingLinks = getAllSamePersonLinks()

  for (const other of allPersons) {
    if (other.pubkey === subjectPubkey) continue
    if (alreadyLinked(subjectPubkey, other.pubkey, existingLinks)) continue
    const candidate = scoreMatch(subjectPubkey, other.pubkey, allClaims)
    if (candidate.confidence >= AUTO_DEDUP_THRESHOLD) {
      // At least one unlinked pair qualifies — notify the UI and stop scanning.
      // The UI will re-run the full scan itself.
      onPendingMatchFound()
      return
    }
  }
}

function ingestEndorsement(event: ChronicleEvent): void {
  // Kind 30082: endorsement of a fact claim.
  const claimEventId = getTag(event, 'claim_event')
  const agree = getTag(event, 'agree')
  const proximity = getTag(event, 'proximity')

  if (!claimEventId || !agree || !proximity) return

  const endorsement: Endorsement = {
    eventId: event.id,
    claimEventId,
    endorserPubkey: event.pubkey,
    agree: agree === 'true',
    proximity: proximity as Endorsement['proximity'],
    createdAt: event.created_at,
  }

  store.addEndorsement(endorsement)
}

function ingestRetraction(event: ChronicleEvent): void {
  // Kind 30089: the original claimant retracts their own claim.
  const retracts = getTag(event, 'retracts')
  if (!retracts) return
  store.retractClaim(retracts)
}

const KNOWN_RELATIONSHIP_TYPES: RelationshipType[] = [
  'parent', 'child', 'spouse', 'sibling',
]
const KNOWN_SUBTYPES: SensitiveRelationshipSubtype[] = [
  'adopted', 'non-paternity', 'unknown-parent', 'given-up',
]

function ingestRelationshipClaim(event: ChronicleEvent): void {
  // Kind 30079: relationship between two persons.
  const subject = getTag(event, 'subject')
  const relationship = getTag(event, 'relationship')
  const related = getTag(event, 'related')

  if (!subject || !relationship) {
    console.warn('[ingestRelationshipClaim] missing subject or relationship tag', event.tags)
    return
  }
  if (!related) {
    console.warn('[ingestRelationshipClaim] missing related tag — event pre-dates v1.0.79, skipping', event.id?.slice(0,8))
    return
  }
  if (!KNOWN_RELATIONSHIP_TYPES.includes(relationship as RelationshipType)) {
    console.warn('[ingestRelationshipClaim] unknown relationship type:', relationship)
    return
  }

  // Ensure both persons exist as stubs before adding the relationship.
  // Relationship events can arrive before identity anchors or fact claims —
  // without stubs, traverseGraph finds the edge but can't render either node.
  const ensurePersonStub = (pubkey: string) => {
    if (!store.getPerson(pubkey)) {
      store.upsertPerson({
        pubkey,
        displayName: 'Unknown',
        isLiving: false,
        createdAt: event.created_at,
      })
      console.log('[ingestRelationshipClaim] created stub for', pubkey.slice(0, 12))
    }
  }
  ensurePersonStub(subject)
  ensurePersonStub(related)

  const sensitive = getTag(event, 'sensitive') === 'true'
  const subtype = getTag(event, 'subtype')
  const relay = getTag(event, 'relay') ?? undefined

  const rel: RelationshipClaim = {
    eventId: event.id,
    claimantPubkey: event.pubkey,
    subjectPubkey: subject,
    relatedPubkey: related,
    relationship: relationship as RelationshipType,
    sensitive,
    subtype: KNOWN_SUBTYPES.includes(subtype as SensitiveRelationshipSubtype)
      ? (subtype as SensitiveRelationshipSubtype)
      : undefined,
    relay,
    createdAt: event.created_at,
    retracted: false,
  }

  console.log('[ingestRelationshipClaim] adding', relationship, 'between', subject.slice(0,12), '→', related.slice(0,12))
  addRelationship(rel)
}

function ingestAcknowledgement(event: ChronicleEvent): void {
  // Kind 30080: acknowledgement of a relationship claim.
  const claimEventId = getTag(event, 'claim_event')
  const approved = getTag(event, 'approved')

  if (!claimEventId || !approved) return

  const ack: Acknowledgement = {
    eventId: event.id,
    claimEventId,
    acknowledgerPubkey: event.pubkey,
    approved: approved === 'true',
    createdAt: event.created_at,
  }

  addAcknowledgement(ack)
}

function ingestSamePersonLink(event: ChronicleEvent): void {
  // Kind 30083: links two person pubkeys as the same individual.
  const pubkeyA = getTag(event, 'subject_a')
  const pubkeyB = getTag(event, 'subject_b')

  if (!pubkeyA || !pubkeyB) return

  const link: SamePersonLink = {
    eventId: event.id,
    claimantPubkey: event.pubkey,
    pubkeyA,
    pubkeyB,
    createdAt: event.created_at,
    retracted: false,
  }

  addSamePersonLink(link)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getTag(event: ChronicleEvent, name: string): string | null {
  const tag = event.tags.find((t) => t[0] === name)
  return tag ? (tag[1] ?? null) : null
}

/**
 * Collect all hex pubkeys Chronicle should fetch events for:
 * - The user's own identity
 * - All persons already stored locally (ancestor pubkeys)
 * - Recovery contacts
 *
 * Returns hex pubkeys. The store uses npub bech32 internally, so we
 * need to decode them. We call the bech32 decoder only if npub-format.
 */
function collectKnownPubkeys(): string[] {
  const pubkeys = new Set<string>()

  // Own identity
  const identity = store.getIdentity()
  if (identity?.npub) {
    const hex = npubToHex(identity.npub)
    if (hex) pubkeys.add(hex)
  }

  // All locally stored persons
  for (const person of store.getAllPersons()) {
    const hex = npubToHex(person.pubkey)
    if (hex) pubkeys.add(hex)
    // person.pubkey might already be hex if stored that way
    else if (person.pubkey.length === 64) pubkeys.add(person.pubkey)
  }

  // Recovery contacts
  for (const contact of store.getRecoveryContacts()) {
    const hex = npubToHex(contact.pubkey)
    if (hex) pubkeys.add(hex)
    else if (contact.pubkey.length === 64) pubkeys.add(contact.pubkey)
  }

  // Connected family members (from contact list)
  // Their pubkeys are npub1... format — convert to hex for the filter
  if (getContactPubkeys) {
    for (const npub of getContactPubkeys()) {
      const hex = npubToHex(npub)
      if (hex) pubkeys.add(hex)
      else if (npub.length === 64) pubkeys.add(npub)
    }
  }

  return [...pubkeys]
}

/**
 * Decode npub1... bech32 to 64-char hex.
 * Returns null if input is not a valid npub.
 */
function npubToHex(npub: string): string | null {
  if (!npub.startsWith('npub1')) {
    // Already hex or unknown format
    return npub.length === 64 ? npub : null
  }
  try {
    // bech32 decode — we replicate the minimal decode here to avoid
    // importing keys.ts (and its heavy crypto deps) into this module.
    const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
    const data = npub.slice(5) // strip 'npub1'
    const decoded: number[] = []
    for (const char of data) {
      const val = CHARSET.indexOf(char)
      if (val === -1) return null
      decoded.push(val)
    }
    // Convert from 5-bit groups to 8-bit bytes (strip checksum — last 6 chars)
    const words = decoded.slice(0, decoded.length - 6)
    const bytes: number[] = []
    let acc = 0, bits = 0
    for (const word of words) {
      acc = (acc << 5) | word
      bits += 5
      if (bits >= 8) {
        bits -= 8
        bytes.push((acc >> bits) & 0xff)
      }
    }
    if (bytes.length !== 32) return null
    return bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

/**
 * Scan raw event store for any JOIN_REQUEST events that haven't been processed
 * yet and fire the handler for each. Call this after registering the handler
 * on session start so requests that arrived before the handler was set are
 * not missed.
 */
export function replayPendingJoinRequests(): void {
  if (!onJoinRequestReceived) return
  const all = store.getAllRawEvents()
  for (const event of all) {
    if (event.kind === EventKind.JOIN_REQUEST) {
      const req = parseJoinRequest(event)
      if (req) onJoinRequestReceived(req)
    }
  }
}
