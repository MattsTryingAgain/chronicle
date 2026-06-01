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
import type { ChronicleEvent, FactClaim, Endorsement, FactField, RelationshipType, SensitiveRelationshipSubtype, PersonAvatar, PersonStory } from '../types/chronicle'
import type { RelayClient } from './relay'
import { store } from './storage'
import {
  addRelationship,
  addAcknowledgement,
  addSamePersonLink,
  areAliases,
} from './graph'
import type { RelationshipClaim, Acknowledgement, SamePersonLink } from './graph'
import { schemaVersionChecker } from './schemaVersion'
import { parseJoinRequest, parseJoinAccept } from './joinRequest'
import type { JoinRequest, JoinAccept } from './joinRequest'
import { scoreMatch } from './treeLinking'
import { parseAvatarEvent, parseStoryEvent } from './eventBuilder'

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

// Contact pubkeys provider — used by ingestIdentityAnchor to auto-register
// aliases when a known contact's identity anchor arrives on this relay.
let _getContactNpubs: (() => string[]) | null = null
export function setContactPubkeysProvider(fn: () => string[]): void {
  _getContactNpubs = fn
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
  // Subscribe to all Chronicle kinds from this relay — no authors filter.
  // The relay is allowlist-gated so every event stored there is already
  // from a trusted pubkey. Filtering by authors here creates a race
  // condition: the filter is built once at connection time, so events
  // published by newly-discovered ancestor pubkeys are missed.
  const filters = [
    {
      kinds: ALL_CHRONICLE_KINDS,
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
    const result: SyncResult = { received: 0, ingested: 0, errors: 0 }

    // No authors filter — relay is allowlist-gated, subscribe to all kinds.
    // See startSync for rationale.
    const filters = [
      {
        kinds: ALL_CHRONICLE_KINDS,
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
      case EventKind.BLOSSOM_REF:
        ingestAvatarEvent(event)
        break
      case EventKind.STORY:
        ingestStoryEvent(event)
        break
      default:
        break
    }
  } catch (err) {
    console.error('[relaySync] ingestEvent error for kind', event.kind, err)
  }

  return true
}

// ── Event-kind ingesters ──────────────────────────────────────────────────────

/**
 * Attempt to auto-alias a contact's npub to an existing UUID-based person stub.
 * Called when a self-published identity anchor arrives for a known contact npub,
 * and also during replayStoredIdentityAnchors (which runs after contacts load).
 *
 * Strategy: find a name claim for the contact npub in the raw event store,
 * then find an existing person with a matching name claim. If found, register
 * the alias and mark the existing record as isLiving: true.
 *
 * Returns true if an alias was registered.
 */
function tryAutoAliasContact(personId: string, claimedByNpub: string, createdAt: number): boolean {
  if (!_getContactNpubs) return false
  const contactNpubs = _getContactNpubs()
  if (!contactNpubs.includes(personId)) return false
  // Already aliased?
  if (store.resolvePersonId(personId) !== null && store.getPerson(personId) === undefined) {
    // personId is a known remote ID already pointing to a local canonical
    return false
  }

  const rawEvents = store.getAllRawEvents()
  const nameForPersonId = rawEvents
    .filter(e => e.kind === 30081 &&
      e.tags.some((t: string[]) => t[0] === 'subject' && t[1] === personId) &&
      e.tags.some((t: string[]) => t[0] === 'field' && t[1] === 'name'))
    .sort((a, b) => b.created_at - a.created_at)[0]
    ?.tags.find((t: string[]) => t[0] === 'value')?.[1]

  if (!nameForPersonId) return false

  for (const candidate of store.getAllPersons()) {
    if (candidate.id === personId) continue  // skip the npub record itself
    // Skip if this candidate is already aliased to personId
    const existingAlias = store.resolvePersonId(personId)
    if (existingAlias === candidate.id) return false  // already done
    // Match by display name or name claim
    const nameMatch = candidate.displayName === nameForPersonId ||
      store.getClaimsForPerson(candidate.id)
        .some(c => c.field === 'name' && c.value === nameForPersonId && !c.retracted)
    if (nameMatch) {
      store.addPersonAlias({
        localId: candidate.id,
        remoteId: personId,
        creatorNpub: claimedByNpub,
        createdAt,
      })
      store.upsertPerson({ ...candidate, isLiving: true })
      console.log(`[auto-alias] contact ${personId.slice(0,12)} → ${candidate.id.slice(0,12)} via name "${nameForPersonId}"`)
      return true
    }
  }
  return false
}

function ingestIdentityAnchor(event: ChronicleEvent): void {
  // Kind 30078: identity anchor.
  // The person_id tag carries the stable UUID (or npub for living users).
  // event.pubkey is the claimant's session key — NOT the person ID.
  const personId = getTag(event, 'person_id')
  if (!personId) {
    console.warn('[ingestIdentityAnchor] no person_id tag, skipping legacy event', event.id?.slice(0,8))
    return
  }

  const claimedByNpub = getTag(event, 'claimed_by') ?? event.pubkey
  const isLivingUser = claimedByNpub === personId

  // Always attempt auto-alias for known contacts (idempotent — skips if already done)
  if (isLivingUser) {
    tryAutoAliasContact(personId, claimedByNpub, event.created_at)
  }

  // Check if we already have this person locally (exact ID match)
  const existing = store.getPerson(personId)
  if (existing) {
    if (isLivingUser && !existing.isLiving) {
      store.upsertPerson({ ...existing, isLiving: true })
    }
    return
  }

  // Check if a local alias resolves to this personId
  const resolvedId = store.resolvePersonId(personId)
  if (resolvedId && resolvedId !== personId) {
    store.addPersonAlias({
      localId: resolvedId,
      remoteId: personId,
      creatorNpub: claimedByNpub,
      createdAt: event.created_at,
    })
    return
  }

  // No existing record — create a new stub
  store.upsertPerson({
    id: personId,
    displayName: 'Unknown',
    isLiving: isLivingUser,
    createdAt: event.created_at,
  })
}

function ingestFactClaim(event: ChronicleEvent): void {
  // Kind 30081: fact claim about a subject.
  // subject tag carries a person ID (UUID for ancestors, npub for living user).
  const subjectId = getTag(event, 'subject')
  const field = getTag(event, 'field')
  const value = getTag(event, 'value')

  if (!subjectId || !field || !value) return

  const KNOWN_FACT_FIELDS: FactField[] = ['name', 'born', 'died', 'birthplace', 'deathplace', 'occupation', 'bio']
  if (!KNOWN_FACT_FIELDS.includes(field as FactField)) return

  // Resolve via alias table — the subjectId might be a remote ID we have
  // mapped to a local ID
  const localId = store.resolvePersonId(subjectId) ?? subjectId

  const claim: FactClaim = {
    eventId: event.id,
    subjectId: localId,
    claimantPubkey: event.pubkey,
    field: field as FactField,
    value,
    evidence: getTag(event, 'evidence') ?? undefined,
    createdAt: event.created_at,
    retracted: false,
    confidenceScore: 0, // recomputed at read time
  }

  // Ensure the person exists before storing the claim
  if (!store.getPerson(localId)) {
    store.upsertPerson({
      id: localId,
      displayName: 'Unknown',
      isLiving: false,
      createdAt: event.created_at,
    })
  }

  store.addClaim(claim)

  // If this fact sets a name, update the person stub display name
  if (field === 'name') {
    const person = store.getPerson(localId)
    if (person) {
      store.upsertPerson({ ...person, displayName: value })
    }
  }

  // After any name or birth fact, scan for possible duplicates in the store.
  if (field === 'name' || field === 'born') {
    maybeDetectDuplicate(localId)
  }
}

/**
 * Scans all existing persons for a potential duplicate of `subjectPubkey`.
 * If a high-confidence pair is found that isn't already linked or dismissed,
 * fires `onPendingMatchFound` so the UI can surface it for user review.
 *
 * Runs synchronously but is O(n) in number of persons — fine up to ~1,000.
 */
function maybeDetectDuplicate(subjectId: string): void {
  if (!onPendingMatchFound) return
  const allPersons = store.getAllPersons()
  if (allPersons.length < 2) return
  const allClaims = store.getAllClaims()

  for (const other of allPersons) {
    if (other.id === subjectId) continue
    if (areAliases(subjectId, other.id)) continue
    const candidate = scoreMatch(subjectId, other.id, allClaims)
    if (candidate.confidence >= AUTO_DEDUP_THRESHOLD) {
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

  // Resolve via alias table in case these are remote IDs we've mapped locally
  const localSubject = store.resolvePersonId(subject) ?? subject
  const localRelated = store.resolvePersonId(related) ?? related

  // Ensure both persons exist as stubs before adding the relationship.
  const ensurePersonStub = (personId: string) => {
    if (!store.getPerson(personId)) {
      store.upsertPerson({
        id: personId,
        displayName: 'Unknown',
        isLiving: false,
        createdAt: event.created_at,
      })
      console.log('[ingestRelationshipClaim] created stub for', personId.slice(0, 12))
    }
  }
  ensurePersonStub(localSubject)
  ensurePersonStub(localRelated)

  const sensitive = getTag(event, 'sensitive') === 'true'
  const subtype = getTag(event, 'subtype')
  const relay = getTag(event, 'relay') ?? undefined

  const rel: RelationshipClaim = {
    eventId: event.id,
    claimantPubkey: event.pubkey,
    subjectId: localSubject,
    relatedId: localRelated,
    relationship: relationship as RelationshipType,
    sensitive,
    subtype: KNOWN_SUBTYPES.includes(subtype as SensitiveRelationshipSubtype)
      ? (subtype as SensitiveRelationshipSubtype)
      : undefined,
    relay,
    createdAt: event.created_at,
    retracted: false,
  }

  console.log('[ingestRelationshipClaim] adding', relationship, 'between', localSubject.slice(0,12), '→', localRelated.slice(0,12))
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
  // Kind 30083: declares two person IDs as referring to the same individual.
  // subject_a / subject_b carry local IDs from the publishing instance.
  // remote_a / remote_b (optional) carry the corresponding IDs from the
  // other instance — used to register aliases in the local store.
  const idA = getTag(event, 'subject_a')
  const idB = getTag(event, 'subject_b')
  const remoteIdA = getTag(event, 'remote_a') ?? undefined
  const remoteIdB = getTag(event, 'remote_b') ?? undefined

  if (!idA || !idB) return

  const link: SamePersonLink = {
    eventId: event.id,
    claimantPubkey: event.pubkey,
    idA,
    idB,
    remoteIdA,
    remoteIdB,
    creatorNpubA: getTag(event, 'creator_a') ?? undefined,
    creatorNpubB: getTag(event, 'creator_b') ?? undefined,
    createdAt: event.created_at,
    retracted: false,
  }

  addSamePersonLink(link)

  // Register aliases in the store so future claims for remote IDs are
  // automatically attributed to the correct local person.
  // idA and idB are local to the publisher; for the receiver, they become
  // remote IDs to map to their own local records.
  if (remoteIdA) {
    const localForA = store.resolvePersonId(idA) ?? idA
    store.addPersonAlias({
      localId: localForA,
      remoteId: remoteIdA,
      creatorNpub: getTag(event, 'creator_a') ?? event.pubkey,
      createdAt: event.created_at,
    })
  }
  if (remoteIdB) {
    const localForB = store.resolvePersonId(idB) ?? idB
    store.addPersonAlias({
      localId: localForB,
      remoteId: remoteIdB,
      creatorNpub: getTag(event, 'creator_b') ?? event.pubkey,
      createdAt: event.created_at,
    })
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getTag(event: ChronicleEvent, name: string): string | null {
  const tag = event.tags.find((t) => t[0] === name)
  return tag ? (tag[1] ?? null) : null
}

/**
 * Decode npub1... bech32 to 64-char hex.
 * Returns null if input is not a valid npub.
 */
/**
 * Scan raw event store for any JOIN_REQUEST events that haven't been processed
 * yet and fire the handler for each. Call this after registering the handler
 * on session start so requests that arrived before the handler was set are
 * not missed.
 */
/**
 * Re-processes all stored raw fact claim events to backfill person display names.
 * Called once after session restore to fix stubs whose name claims were stored
 * before the person stub existed (or whose displayName is still 'Unknown').
 *
 * Safe to call multiple times — claims are deduplicated in the store.
 */
export function replayStoredFactClaims(): void {
  const rawEvents = store.getAllRawEvents()

  // Collect the best (most recent) name claim per subject pubkey
  const bestNameBySubject = new Map<string, { value: string; createdAt: number }>()

  for (const event of rawEvents) {
    if (event.kind !== EventKind.FACT_CLAIM) continue
    const field = event.tags?.find((t: string[]) => t[0] === 'field')?.[1]
    const subject = event.tags?.find((t: string[]) => t[0] === 'subject')?.[1]
    const value = event.tags?.find((t: string[]) => t[0] === 'value')?.[1]
    if (!subject || !value) continue

    if (field === 'name') {
      const existing = bestNameBySubject.get(subject)
      if (!existing || event.created_at > existing.createdAt) {
        bestNameBySubject.set(subject, { value, createdAt: event.created_at })
      }
    }
  }

  // Update persons whose displayName is still 'Unknown' (stub placeholder).
  // Do NOT overwrite display names that have already been set — this prevents
  // a remote name claim from clobbering the logged-in user's own display name.
  let updated = 0
  for (const [subject, { value }] of bestNameBySubject) {
    // Resolve via alias table in case subject is a remote ID
    const localId = store.resolvePersonId(subject) ?? subject
    const person = store.getPerson(localId)
    if (!person) {
      store.upsertPerson({ id: localId, displayName: value, isLiving: false, createdAt: 0 })
      updated++
    } else if (person.displayName === 'Unknown') {
      store.upsertPerson({ ...person, displayName: value })
      updated++
    }
  }

  if (updated > 0) console.log(`[replayStoredFactClaims] updated ${updated} person display names`)
}

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

// ── Media event ingesters ─────────────────────────────────────────────────────

// In-memory maps — keyed by personId; avatars keep only the newest by createdAt
const _avatarStore = new Map<string, PersonAvatar>()
const _storyStore = new Map<string, PersonStory>()  // keyed by eventId

/**
 * Collect all IDs that might refer to the same person as personId:
 *   - the personId itself
 *   - any remote IDs for which personId is the local canonical
 *   - the local canonical for personId if it is itself a remote alias
 * This ensures media stored under any alias is found regardless of
 * which UUID was in scope when the event was ingested.
 */
function allIdsForPerson(personId: string): Set<string> {
  const ids = new Set<string>([personId])
  // If personId is a remote alias, add the canonical local ID
  const canonical = store.resolvePersonId(personId)
  if (canonical && canonical !== personId) ids.add(canonical)
  // Add all remote IDs registered under the canonical (or personId itself)
  const root = canonical ?? personId
  for (const alias of store.getAliasesFor(root)) {
    ids.add(alias.remoteId)
  }
  return ids
}

export function getAvatar(personId: string): PersonAvatar | undefined {
  for (const id of allIdsForPerson(personId)) {
    const avatar = _avatarStore.get(id)
    if (avatar) return avatar
  }
  return undefined
}

export function getStoriesForPerson(personId: string): PersonStory[] {
  const ids = allIdsForPerson(personId)
  const result: PersonStory[] = []
  for (const story of _storyStore.values()) {
    if (ids.has(story.personId)) result.push(story)
  }
  return result.sort((a, b) => b.createdAt - a.createdAt)
}

export function ingestAvatarEvent(event: ChronicleEvent): void {
  const avatar = parseAvatarEvent(event)
  if (!avatar) return
  // Resolve alias so the avatar key is always the local canonical ID
  const localId = store.resolvePersonId(avatar.personId) ?? avatar.personId
  const existing = _avatarStore.get(localId)
  if (!existing || avatar.createdAt > existing.createdAt) {
    _avatarStore.set(localId, { ...avatar, personId: localId })
    console.log(`[relaySync] avatar ingested for ${localId.slice(0, 8)}…`)
  }
}

export function ingestStoryEvent(event: ChronicleEvent): void {
  const story = parseStoryEvent(event)
  if (!story) return
  // Resolve alias so stories are indexed under the local canonical ID
  const localId = store.resolvePersonId(story.personId) ?? story.personId
  _storyStore.set(story.eventId, { ...story, personId: localId })
  console.log(`[relaySync] story ingested "${story.title}" for ${localId.slice(0, 8)}…`)
}

/** Replay already-stored raw events to populate the media caches after session restore. */
export function replayStoredMediaEvents(): void {
  _avatarStore.clear()
  _storyStore.clear()
  const all = store.getAllRawEvents()
  for (const event of all) {
    if (event.kind === EventKind.BLOSSOM_REF) ingestAvatarEvent(event)
    else if (event.kind === EventKind.STORY) ingestStoryEvent(event)
  }
}

/** Reset — for testing only */
export function _resetMediaStore(): void {
  _avatarStore.clear()
  _storyStore.clear()
}

/**
 * Re-run ingestIdentityAnchor for every stored IDENTITY_ANCHOR event,
 * bypassing the raw-event dedup guard. Called after the contact list is
 * loaded so the auto-alias logic has access to known contact npubs.
 *
 * This fixes the case where a contact's anchor was received before their
 * npub was in the contacts list — the anchor was stored but the auto-alias
 * never fired. Calling this after contacts load ensures the alias is
 * registered on the next session start.
 */
export function replayStoredIdentityAnchors(): void {
  const all = store.getAllRawEvents()
  let aliased = 0
  for (const event of all) {
    if (event.kind === EventKind.IDENTITY_ANCHOR) {
      ingestIdentityAnchor(event)
      aliased++
    }
  }
  if (aliased > 0) console.log(`[replayStoredIdentityAnchors] re-processed ${aliased} identity anchors`)
}
