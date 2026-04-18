/**
 * Chronicle core types
 * Mirrors the Nostr event schema defined in the Design Plan.
 * All event kinds are in the 30000-range (replaceable parameterised events).
 */

export const SCHEMA_VERSION = '1' as const

// ─── Event Kinds ────────────────────────────────────────────────────────────

export const EventKind = {
  IDENTITY_ANCHOR: 30078,
  RELATIONSHIP_CLAIM: 30079,
  ACKNOWLEDGEMENT: 30080,
  FACT_CLAIM: 30081,
  ENDORSEMENT: 30082,
  SAME_PERSON_LINK: 30083,
  KEY_SUPERSESSION: 30084,
  DISCOVERY: 30085,
  KEY_REVOCATION: 30086,
  CONTENT_DISPUTE: 30087,
  TRUST_REVOCATION: 30088,
  CLAIM_RETRACTION: 30089,
  PRIVATE_CONTACT_LIST: 30090,
  // Stage 4 extensions (consistent with 300xx namespace)
  JOIN_REQUEST: 30091,
  JOIN_ACCEPT: 30092,
  RELAY_GOSSIP: 30093,
  // Stage 5: privacy layer
  FAMILY_KEY_ADMISSION: 30094,
  BLOSSOM_REF: 30095,
} as const

export type EventKindValue = (typeof EventKind)[keyof typeof EventKind]

// ─── Privacy Tiers ───────────────────────────────────────────────────────────

export type PrivacyTier = 'public' | 'family' | 'private'

// ─── Relationship Types ──────────────────────────────────────────────────────

export type RelationshipType =
  | 'parent'
  | 'child'
  | 'spouse'
  | 'sibling'
  | 'grandparent'
  | 'grandchild'

export type SensitiveRelationshipSubtype =
  | 'adopted'
  | 'non-paternity'
  | 'unknown-parent'
  | 'given-up'

// ─── Proximity (for endorsement weighting) ───────────────────────────────────

export type ProximityLevel = 'self' | 'child' | 'grandchild' | 'great-grandchild' | 'other'

// ─── Base Nostr-like Event ───────────────────────────────────────────────────

export interface ChronicleEvent {
  id: string           // SHA256 of canonical serialisation
  pubkey: string       // npub1... bech32
  created_at: number   // unix timestamp
  kind: EventKindValue
  tags: string[][]
  content: string
  sig: string          // Schnorr signature
}

// ─── Person ──────────────────────────────────────────────────────────────────

export interface Person {
  pubkey: string       // npub1... — stable identifier
  displayName: string
  isLiving: boolean
  createdAt: number
}

// ─── Fact Claim ──────────────────────────────────────────────────────────────

export type FactField =
  | 'name'
  | 'born'
  | 'died'
  | 'birthplace'
  | 'deathplace'
  | 'occupation'
  | 'bio'

export interface FactClaim {
  eventId: string
  claimantPubkey: string    // npub1...
  subjectPubkey: string     // npub1...
  field: FactField
  value: string
  evidence?: string
  createdAt: number
  retracted: boolean
  confidenceScore: number   // computed; not stored on event
}

// ─── Endorsement ─────────────────────────────────────────────────────────────

export interface Endorsement {
  eventId: string
  claimEventId: string
  endorserPubkey: string    // npub1...
  proximity: ProximityLevel
  agree: boolean
  createdAt: number
}

// ─── Conflict State ──────────────────────────────────────────────────────────

export type ConflictState = 'none' | 'soft' | 'hard' | 'resolved'

export interface FieldResolution {
  field: FactField
  winningClaim: FactClaim | null
  allClaims: FactClaim[]
  conflictState: ConflictState
}

// ─── Key material (in-memory only, never persisted raw) ──────────────────────

export interface KeyMaterial {
  mnemonic: string       // BIP39 — user-facing
  npub: string           // bech32 public key
  nsec: string           // bech32 private key — kept in memory only
}

// ─── Stage 5: Privacy Layer Types ────────────────────────────────────────────

/** A Shamir share of an ancestor private key, held by one family member. */
export interface ShamirShare {
  index: number        // 1-based
  share: string        // hex-encoded share data (secrets.js format)
  holderNpub: string   // npub of the share holder
}

/** Result of splitting an ancestor key into Shamir shares. */
export interface ShamirSplit {
  ancestorNpub: string
  total: number
  threshold: number
  shares: ShamirShare[]
}

/** A family shared key encrypted to a new member for admission. */
export interface FamilyKeyAdmission {
  admittedNpub: string
  encryptedFamilyKey: string  // base64 NaCl box ciphertext
  nonce: string               // base64
}

/** Reference to a Blossom media item (stored in kind 30095 event). */
export interface BlossomRef {
  hash: string        // SHA-256 hex of the media content
  url: string         // URL where media is served
  mimeType: string
  size: number        // bytes
  tier: PrivacyTier
  subjectNpub: string
}

/** Key supersession record (kind 30084 — key loss recovery). */
export interface KeySupersession {
  oldNpub: string
  newNpub: string
  attestedBy: string[]   // npubs of recovery contacts who co-signed
  createdAt: number
}

/** Key revocation record (kind 30086 — key compromise recovery). */
export interface KeyRevocation {
  compromisedNpub: string
  fromTimestamp: number
  attestedBy: string[]   // npubs
  revokedByNpub: string  // recovery contact who published
  createdAt: number
}
