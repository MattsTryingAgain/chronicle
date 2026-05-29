/**
 * Chronicle Encrypted Key Storage
 *
 * Encrypts the user's nsec (and ancestor private keys) with a user-supplied
 * password using NaCl secretbox (XSalsa20-Poly1305 + SHA-256 key stretch).
 *
 * Nothing in here touches Nostr kind 0 or the network.
 * The in-memory store (MemoryStore) is the Stage 1 / Stage 2 stand-in for
 * SQLite (better-sqlite3 arrives with the Electron wrapper in Stage 3).
 */

import nacl from 'tweetnacl'
import { encodeBase64, decodeBase64 } from 'tweetnacl-util'

const _enc = new TextEncoder()
const _dec = new TextDecoder()

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EncryptedPayload {
  /** XSalsa20-Poly1305 ciphertext, base64 */
  ciphertext: string
  /** 24-byte nonce, base64 */
  nonce: string
  /** 32-byte salt used for key derivation, base64 */
  salt: string
}

export interface StoredIdentity {
  npub: string
  displayName: string
  encryptedNsec: EncryptedPayload
  createdAt: number
}

export interface RecoveryContact {
  pubkey: string          // npub1...
  displayName: string
  addedAt: number
}

// ─── Key stretching ──────────────────────────────────────────────────────────

/**
 * Derives a 32-byte symmetric key from a password + salt using PBKDF2-SHA256.
 * Uses Node pbkdf2Sync in test/Node environments, SubtleCrypto in the browser.
 */
async function deriveKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  // Use Node crypto in test/Electron environments
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isNode = typeof (globalThis as any).process?.versions?.node === 'string'
  if (isNode) {
    const { pbkdf2Sync } = await import('node:crypto')
    const derived = pbkdf2Sync(password, salt as unknown as Buffer, 100_000, 32, 'sha256')
    return new Uint8Array(derived)
  }
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  )
  // Cast salt to satisfy strict DOM BufferSource typing
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: 100_000, hash: 'SHA-256' },
    keyMaterial,
    256,
  )
  return new Uint8Array(derived)
}

// ─── Encrypt / Decrypt ───────────────────────────────────────────────────────

/**
 * Encrypts a plaintext string with a password.
 * Returns an EncryptedPayload suitable for persisting to the store.
 */
export async function encryptWithPassword(
  plaintext: string,
  password: string,
): Promise<EncryptedPayload> {
  const salt = nacl.randomBytes(32)
  const key = await deriveKey(password, salt)
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength)
  const ciphertext = nacl.secretbox(_enc.encode(plaintext), nonce, key)
  return {
    ciphertext: encodeBase64(ciphertext),
    nonce: encodeBase64(nonce),
    salt: encodeBase64(salt),
  }
}

/**
 * Decrypts an EncryptedPayload with a password.
 * Returns null if the password is wrong or the payload is corrupt.
 */
export async function decryptWithPassword(
  payload: EncryptedPayload,
  password: string,
): Promise<string | null> {
  try {
    const salt = decodeBase64(payload.salt)
    const key = await deriveKey(password, salt)
    const nonce = decodeBase64(payload.nonce)
    const ciphertext = decodeBase64(payload.ciphertext)
    const plaintext = nacl.secretbox.open(ciphertext, nonce, key)
    if (!plaintext) return null
    return _dec.decode(plaintext)
  } catch {
    return null
  }
}

// ─── In-Memory Store (Stage 1/2 stand-in for SQLite) ─────────────────────────

/**
 * MemoryStore holds all Chronicle state in memory for the React/Vite phase.
 * The interface is designed to mirror the SQLite schema so the swap in Stage 3
 * is a drop-in replacement with no changes to callers.
 *
 * All data is lost on page refresh — this is intentional for Stage 1.
 * Persistence (sessionStorage serialisation) is added in Stage 2.
 */
export class MemoryStore {
  private identity: StoredIdentity | null = null
  private persons: Map<string, import('../types/chronicle').Person> = new Map()
  private claims: Map<string, import('../types/chronicle').FactClaim> = new Map()
  private endorsements: Map<string, import('../types/chronicle').Endorsement> = new Map()
  private recoveryContacts: Map<string, RecoveryContact> = new Map()
  /** Raw signed Nostr events — mirrors the SQLite events table */
  private rawEvents: Map<string, import('../types/chronicle').ChronicleEvent> = new Map()
  /**
   * Alias table: maps local person ID → set of PersonAlias records.
   * Each alias records a remote person ID (from another instance) that refers
   * to the same real individual, plus the npub of whoever created that record.
   */
  private aliases: Map<string, import('../types/chronicle').PersonAlias[]> = new Map()

  // ── Identity ──────────────────────────────────────────────────────────────

  setIdentity(identity: StoredIdentity): void {
    this.identity = identity
  }

  getIdentity(): StoredIdentity | null {
    return this.identity
  }

  hasIdentity(): boolean {
    return this.identity !== null
  }

  clearIdentity(): void {
    this.identity = null
  }

  // ── Persons ───────────────────────────────────────────────────────────────

  upsertPerson(person: import('../types/chronicle').Person): void {
    this.persons.set(person.id, person)
  }

  deletePerson(personId: string): void {
    this.persons.delete(personId)
    this.aliases.delete(personId)
    // Remove all claims for this person
    for (const [id, claim] of this.claims) {
      if (claim.subjectId === personId) {
        this.claims.delete(id)
      }
    }
  }

  getPerson(id: string): import('../types/chronicle').Person | undefined {
    return this.persons.get(id)
  }

  getAllPersons(): import('../types/chronicle').Person[] {
    return Array.from(this.persons.values())
  }

  searchPersons(query: string): import('../types/chronicle').Person[] {
    const q = query.toLowerCase().trim()
    if (!q) return this.getAllPersons()
    return this.getAllPersons().filter((p) =>
      p.displayName.toLowerCase().includes(q),
    )
  }

  // ── Fact Claims ───────────────────────────────────────────────────────────

  addClaim(claim: import('../types/chronicle').FactClaim): void {
    this.claims.set(claim.eventId, claim)
  }

  getAllClaims(): import('../types/chronicle').FactClaim[] {
    return Array.from(this.claims.values())
  }

  getClaimsForPerson(
    subjectId: string,
  ): import('../types/chronicle').FactClaim[] {
    return Array.from(this.claims.values()).filter(
      (c) => c.subjectId === subjectId,
    )
  }

  retractClaim(eventId: string): void {
    const claim = this.claims.get(eventId)
    if (claim) this.claims.set(eventId, { ...claim, retracted: true })
  }

  // ── Endorsements ──────────────────────────────────────────────────────────

  addEndorsement(endorsement: import('../types/chronicle').Endorsement): void {
    this.endorsements.set(endorsement.eventId, endorsement)
  }

  getEndorsementsForClaim(
    claimEventId: string,
  ): import('../types/chronicle').Endorsement[] {
    return Array.from(this.endorsements.values()).filter(
      (e) => e.claimEventId === claimEventId,
    )
  }

  getAllEndorsements(): import('../types/chronicle').Endorsement[] {
    return Array.from(this.endorsements.values())
  }

  // ── Recovery Contacts ─────────────────────────────────────────────────────

  addRecoveryContact(contact: RecoveryContact): void {
    this.recoveryContacts.set(contact.pubkey, contact)
  }

  removeRecoveryContact(pubkey: string): void {
    this.recoveryContacts.delete(pubkey)
  }

  getRecoveryContacts(): RecoveryContact[] {
    return Array.from(this.recoveryContacts.values()).sort(
      (a, b) => a.addedAt - b.addedAt,
    )
  }

  // ── Raw Events ───────────────────────────────────────────────────────────

  /** Store a raw signed event (for relay sync and verification). */
  addRawEvent(event: import('../types/chronicle').ChronicleEvent): void {
    this.rawEvents.set(event.id, event)
  }

  getRawEvent(id: string): import('../types/chronicle').ChronicleEvent | undefined {
    return this.rawEvents.get(id)
  }

  getAllRawEvents(): import('../types/chronicle').ChronicleEvent[] {
    return Array.from(this.rawEvents.values())
  }


  // ── Person Aliases ────────────────────────────────────────────────────────

  /**
   * Record that a remote instance uses a different ID for the same person.
   * localId is our ID for the person; remoteId is their ID; creatorNpub
   * is the session key of the user who originally created that remote record.
   */
  addPersonAlias(alias: import('../types/chronicle').PersonAlias): void {
    const existing = this.aliases.get(alias.localId) ?? []
    // Avoid duplicate (same remoteId already recorded)
    if (!existing.some(a => a.remoteId === alias.remoteId)) {
      this.aliases.set(alias.localId, [...existing, alias])
    }
  }

  getAliasesFor(localId: string): import('../types/chronicle').PersonAlias[] {
    return this.aliases.get(localId) ?? []
  }

  /**
   * Given any known ID (local or remote alias), return the local person ID.
   * Returns null if not found.
   */
  resolvePersonId(anyId: string): string | null {
    // Direct match
    if (this.persons.has(anyId)) return anyId
    // Scan alias table for a remote ID match
    for (const [localId, aliases] of this.aliases) {
      if (aliases.some(a => a.remoteId === anyId)) return localId
    }
    return null
  }

  getAllAliases(): import('../types/chronicle').PersonAlias[] {
    const out: import('../types/chronicle').PersonAlias[] = []
    for (const aliases of this.aliases.values()) out.push(...aliases)
    return out
  }

  // ── Serialise / Deserialise (for sessionStorage persistence) ─────────────

  serialise(): string {
    return JSON.stringify({
      identity: this.identity,
      persons: Object.fromEntries(this.persons),
      claims: Object.fromEntries(this.claims),
      endorsements: Object.fromEntries(this.endorsements),
      recoveryContacts: Object.fromEntries(this.recoveryContacts),
      rawEvents: Object.fromEntries(this.rawEvents),
      aliases: Object.fromEntries(
        Array.from(this.aliases.entries()).map(([k, v]) => [k, v])
      ),
    })
  }

  static deserialise(json: string): MemoryStore {
    const store = new MemoryStore()
    const data = JSON.parse(json)
    store.identity = data.identity ?? null
    store.persons = new Map(Object.entries(data.persons ?? {}))
    store.claims = new Map(Object.entries(data.claims ?? {}))
    store.endorsements = new Map(Object.entries(data.endorsements ?? {}))
    store.recoveryContacts = new Map(Object.entries(data.recoveryContacts ?? {}))
    store.rawEvents = new Map(Object.entries(data.rawEvents ?? {}))
    // Restore alias table
    const aliasData = data.aliases ?? {}
    for (const [localId, aliases] of Object.entries(aliasData)) {
      store.aliases.set(localId, aliases as import('../types/chronicle').PersonAlias[])
    }
    return store
  }
}

// ─── Singleton store (app-wide) ───────────────────────────────────────────────

export const store = new MemoryStore()
