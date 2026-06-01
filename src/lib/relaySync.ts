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
import type { ChronicleEvent, FactClaim, Endorsement, Person, FactField, RelationshipType, SensitiveRelationshipSubtype, PersonAvatar, PersonStory } from '../types/chronicle'
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

// setContactPubkeysProvider kept for API compatibility — no longer used
// (subscription now fetches all kinds without an authors filter)
export function setContactPubkeysProvider(_fn: () => string[]): void {}

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

function ingestIdentityAnchor(event: ChronicleEvent): void {
  // Kind 30078: identity anchor.
  // The person_id tag carries the stable UUID (or npub for living users).
  // event.pubkey is the claimant's session key — NOT the person ID.
  const personId = getTag(event, 'person_id')
  if (!personId) {
    // Legacy event (pre-v1.0.87): no person_id tag. Skip — these are
    // from old builds and cannot be safely ingested under the new model.
    console.warn('[ingestIdentityAnchor] no person_id tag, skipping legacy event', event.id?.slice(0,8))
    return
  }

  const claimedByNpub = getTag(event, 'claimed_by') ?? event.pubkey

  // Check if we already have this person locally
  const existing = store.getPerson(personId)
  if (existing) return

  // Check if a local alias resolves to this personId — i.e. we have a
  // different local ID for the same remote person. If so, register the alias.
  const resolvedId = store.resolvePersonId(personId)
  if (resolvedId && resolvedId !== personId) {
    // We have a local record; just register the alias so claims can cross-reference
    store.addPersonAlias({
      localId: resolvedId,
      remoteId: personId,
      creatorNpub: claimedByNpub,
      createdAt: event.created_at,
    })
    return
  }

  // If claimed_by == person_id, the person is claiming themselves — a living user.
  // This ensures connected contacts have isLiving: true in the local store.
  const isLivingUser = claimedByNpub === personId
  const person: Person = {
    id: personId,
    displayName: 'Unknown', // placeholder until name fact claim arrives
    isLiving: isLivingUser,
    createdAt: event.created_at,
  }
  store.upsertPerson(person)
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

export function getAvatar(personId: string): PersonAvatar | undefined {
  return _avatarStore.get(personId)
}

export function getStoriesForPerson(personId: string): PersonStory[] {
  const result: PersonStory[] = []
  for (const story of _storyStore.values()) {
    if (story.personId === personId) result.push(story)
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
