/**
 * Chronicle SQLite Store
 *
 * Drop-in replacement for MemoryStore backed by better-sqlite3.
 * Exposes the identical public API so all callers need zero changes.
 *
 * Installation (developer machine only — native compilation required):
 *   npm install better-sqlite3 @types/better-sqlite3
 *
 * The Electron main process sets DB_PATH via the userData directory:
 *   new SqliteStore(path.join(app.getPath('userData'), 'chronicle.db'))
 *
 * For the web/Vite dev build, MemoryStore is still used.
 * SqliteStore is loaded only when running inside Electron (detected via
 * window.chronicleElectron?.isElectron).
 *
 * Schema notes:
 * - All pubkeys stored as TEXT (npub1... bech32)
 * - JSON blobs stored as TEXT (SQLite has no JSON type)
 * - FTS5 virtual table on persons for name search
 * - created_at indexed on claims and events for time-ordered queries
 * - Schema version tracked in user_version PRAGMA (currently 1)
 */

import type {
  Person,
  FactClaim,
  Endorsement,
  ChronicleEvent,
} from '../types/chronicle'
import type {
  StoredIdentity,
  StoredAncestorKey,
  RecoveryContact,
} from './storage'
import type {
  RelationshipClaim,
  Acknowledgement,
  SamePersonLink,
} from './graph'
import type { BlossomRef, PrivacyTier } from '../types/chronicle'
import type { MediaCacheEntry, FetchStatus } from './blossom'

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identity (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  npub            TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  encrypted_nsec  TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ancestor_keys (
  npub              TEXT PRIMARY KEY,
  encrypted_privkey TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS persons (
  pubkey        TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  is_living     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS persons_fts USING fts5(
  pubkey UNINDEXED,
  display_name,
  content='persons',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS persons_ai AFTER INSERT ON persons BEGIN
  INSERT INTO persons_fts(rowid, pubkey, display_name)
  VALUES (new.rowid, new.pubkey, new.display_name);
END;
CREATE TRIGGER IF NOT EXISTS persons_au AFTER UPDATE ON persons BEGIN
  INSERT INTO persons_fts(persons_fts, rowid, pubkey, display_name)
  VALUES ('delete', old.rowid, old.pubkey, old.display_name);
  INSERT INTO persons_fts(rowid, pubkey, display_name)
  VALUES (new.rowid, new.pubkey, new.display_name);
END;
CREATE TRIGGER IF NOT EXISTS persons_ad AFTER DELETE ON persons BEGIN
  INSERT INTO persons_fts(persons_fts, rowid, pubkey, display_name)
  VALUES ('delete', old.rowid, old.pubkey, old.display_name);
END;

CREATE TABLE IF NOT EXISTS claims (
  event_id        TEXT PRIMARY KEY,
  claimant_pubkey TEXT NOT NULL,
  subject_pubkey  TEXT NOT NULL,
  field           TEXT NOT NULL,
  value           TEXT NOT NULL,
  evidence        TEXT,
  created_at      INTEGER NOT NULL,
  retracted       INTEGER NOT NULL DEFAULT 0,
  confidence      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS claims_subject ON claims(subject_pubkey);

CREATE TABLE IF NOT EXISTS endorsements (
  event_id       TEXT PRIMARY KEY,
  claim_event_id TEXT NOT NULL,
  endorser_pubkey TEXT NOT NULL,
  proximity      TEXT NOT NULL,
  agree          INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS endorsements_claim ON endorsements(claim_event_id);

CREATE TABLE IF NOT EXISTS recovery_contacts (
  pubkey       TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  added_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_events (
  id         TEXT PRIMARY KEY,
  pubkey     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  kind       INTEGER NOT NULL,
  tags       TEXT NOT NULL,
  content    TEXT NOT NULL,
  sig        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS raw_events_kind ON raw_events(kind);
CREATE INDEX IF NOT EXISTS raw_events_pubkey ON raw_events(pubkey);

CREATE TABLE IF NOT EXISTS relationships (
  event_id          TEXT PRIMARY KEY,
  claimant_pubkey   TEXT NOT NULL,
  subject_pubkey    TEXT NOT NULL,
  related_pubkey    TEXT NOT NULL,
  relationship      TEXT NOT NULL,
  sensitive         INTEGER NOT NULL DEFAULT 0,
  subtype           TEXT,
  relay             TEXT,
  created_at        INTEGER NOT NULL,
  retracted         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS rel_subject ON relationships(subject_pubkey);
CREATE INDEX IF NOT EXISTS rel_related ON relationships(related_pubkey);

CREATE TABLE IF NOT EXISTS acknowledgements (
  event_id             TEXT PRIMARY KEY,
  claim_event_id       TEXT NOT NULL,
  acknowledger_pubkey  TEXT NOT NULL,
  approved             INTEGER NOT NULL DEFAULT 1,
  created_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ack_claim ON acknowledgements(claim_event_id);

CREATE TABLE IF NOT EXISTS same_person_links (
  event_id         TEXT PRIMARY KEY,
  claimant_pubkey  TEXT NOT NULL,
  pubkey_a         TEXT NOT NULL,
  pubkey_b         TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  retracted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS spl_a ON same_person_links(pubkey_a);
CREATE INDEX IF NOT EXISTS spl_b ON same_person_links(pubkey_b);

CREATE TABLE IF NOT EXISTS media_cache (
  url         TEXT PRIMARY KEY,
  hash        TEXT NOT NULL,
  local_path  TEXT,
  fetch_status TEXT NOT NULL DEFAULT 'pending',
  privacy_tier TEXT NOT NULL DEFAULT 'public',
  created_at  INTEGER NOT NULL
);
`

// ─── SqliteStore ──────────────────────────────────────────────────────────────

export class SqliteStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any  // BetterSqlite3.Database — typed loosely to avoid hard dep at import time

  /**
   * @param dbPath  Absolute path to the SQLite database file, or ':memory:'
   */
  constructor(dbPath: string) {
    // Dynamic require — better-sqlite3 is a native module only available
    // after `npm install` on the developer's machine.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3')
    this.db = new Database(dbPath)
    this.db.exec(SCHEMA_SQL)
    this.db.pragma('user_version = 1')
  }

  // ── Identity ──────────────────────────────────────────────────────────────

  setIdentity(identity: StoredIdentity): void {
    this.db
      .prepare(
        `INSERT INTO identity (id, npub, display_name, encrypted_nsec, created_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           npub = excluded.npub,
           display_name = excluded.display_name,
           encrypted_nsec = excluded.encrypted_nsec,
           created_at = excluded.created_at`,
      )
      .run(
        identity.npub,
        identity.displayName,
        JSON.stringify(identity.encryptedNsec),
        identity.createdAt,
      )
  }

  getIdentity(): StoredIdentity | null {
    const row = this.db.prepare('SELECT * FROM identity WHERE id = 1').get() as
      | { npub: string; display_name: string; encrypted_nsec: string; created_at: number }
      | undefined
    if (!row) return null
    return {
      npub: row.npub,
      displayName: row.display_name,
      encryptedNsec: JSON.parse(row.encrypted_nsec),
      createdAt: row.created_at,
    }
  }

  hasIdentity(): boolean {
    return this.getIdentity() !== null
  }

  clearIdentity(): void {
    this.db.prepare('DELETE FROM identity WHERE id = 1').run()
  }

  // ── Ancestor Keys ─────────────────────────────────────────────────────────

  setAncestorKey(npub: string, key: StoredAncestorKey): void {
    this.db
      .prepare(
        `INSERT INTO ancestor_keys (npub, encrypted_privkey)
         VALUES (?, ?)
         ON CONFLICT(npub) DO UPDATE SET encrypted_privkey = excluded.encrypted_privkey`,
      )
      .run(npub, JSON.stringify(key.encryptedPrivkey))
  }

  getAncestorKey(npub: string): StoredAncestorKey | undefined {
    const row = this.db
      .prepare('SELECT * FROM ancestor_keys WHERE npub = ?')
      .get(npub) as { npub: string; encrypted_privkey: string } | undefined
    if (!row) return undefined
    return {
      npub: row.npub,
      encryptedPrivkey: JSON.parse(row.encrypted_privkey),
    }
  }

  // ── Persons ───────────────────────────────────────────────────────────────

  upsertPerson(person: Person): void {
    this.db
      .prepare(
        `INSERT INTO persons (pubkey, display_name, is_living, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(pubkey) DO UPDATE SET
           display_name = excluded.display_name,
           is_living = excluded.is_living`,
      )
      .run(person.pubkey, person.displayName, person.isLiving ? 1 : 0, person.createdAt)
  }

  getPerson(pubkey: string): Person | undefined {
    const row = this.db
      .prepare('SELECT * FROM persons WHERE pubkey = ?')
      .get(pubkey) as
      | { pubkey: string; display_name: string; is_living: number; created_at: number }
      | undefined
    if (!row) return undefined
    return {
      pubkey: row.pubkey,
      displayName: row.display_name,
      isLiving: row.is_living === 1,
      createdAt: row.created_at,
    }
  }

  getAllPersons(): Person[] {
    const rows = this.db.prepare('SELECT * FROM persons ORDER BY created_at').all() as Array<{
      pubkey: string
      display_name: string
      is_living: number
      created_at: number
    }>
    return rows.map((r) => ({
      pubkey: r.pubkey,
      displayName: r.display_name,
      isLiving: r.is_living === 1,
      createdAt: r.created_at,
    }))
  }

  searchPersons(query: string): Person[] {
    const q = query.trim()
    if (!q) return this.getAllPersons()
    // FTS5 MATCH — prefix search by appending *
    const rows = this.db
      .prepare(
        `SELECT p.* FROM persons p
         JOIN persons_fts f ON p.pubkey = f.pubkey
         WHERE persons_fts MATCH ?
         ORDER BY p.created_at`,
      )
      .all(`"${q.replace(/"/g, '""')}"*`) as Array<{
      pubkey: string
      display_name: string
      is_living: number
      created_at: number
    }>
    return rows.map((r) => ({
      pubkey: r.pubkey,
      displayName: r.display_name,
      isLiving: r.is_living === 1,
      createdAt: r.created_at,
    }))
  }

  // ── Fact Claims ───────────────────────────────────────────────────────────

  addClaim(claim: FactClaim): void {
    this.db
      .prepare(
        `INSERT INTO claims
           (event_id, claimant_pubkey, subject_pubkey, field, value, evidence, created_at, retracted, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .run(
        claim.eventId,
        claim.claimantPubkey,
        claim.subjectPubkey,
        claim.field,
        claim.value,
        claim.evidence ?? null,
        claim.createdAt,
        claim.retracted ? 1 : 0,
        claim.confidenceScore,
      )
  }

  getClaimsForPerson(subjectPubkey: string): FactClaim[] {
    const rows = this.db
      .prepare('SELECT * FROM claims WHERE subject_pubkey = ? ORDER BY created_at')
      .all(subjectPubkey) as Array<{
      event_id: string
      claimant_pubkey: string
      subject_pubkey: string
      field: string
      value: string
      evidence: string | null
      created_at: number
      retracted: number
      confidence: number
    }>
    return rows.map((r) => ({
      eventId: r.event_id,
      claimantPubkey: r.claimant_pubkey,
      subjectPubkey: r.subject_pubkey,
      field: r.field as FactClaim['field'],
      value: r.value,
      evidence: r.evidence ?? undefined,
      createdAt: r.created_at,
      retracted: r.retracted === 1,
      confidenceScore: r.confidence,
    }))
  }

  retractClaim(eventId: string): void {
    this.db
      .prepare('UPDATE claims SET retracted = 1 WHERE event_id = ?')
      .run(eventId)
  }

  // ── Endorsements ──────────────────────────────────────────────────────────

  addEndorsement(endorsement: Endorsement): void {
    this.db
      .prepare(
        `INSERT INTO endorsements
           (event_id, claim_event_id, endorser_pubkey, proximity, agree, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .run(
        endorsement.eventId,
        endorsement.claimEventId,
        endorsement.endorserPubkey,
        endorsement.proximity,
        endorsement.agree ? 1 : 0,
        endorsement.createdAt,
      )
  }

  getEndorsementsForClaim(claimEventId: string): Endorsement[] {
    return this._rowsToEndorsements(
      this.db
        .prepare('SELECT * FROM endorsements WHERE claim_event_id = ? ORDER BY created_at')
        .all(claimEventId),
    )
  }

  getAllEndorsements(): Endorsement[] {
    return this._rowsToEndorsements(
      this.db.prepare('SELECT * FROM endorsements ORDER BY created_at').all(),
    )
  }

  private _rowsToEndorsements(rows: unknown[]): Endorsement[] {
    return (
      rows as Array<{
        event_id: string
        claim_event_id: string
        endorser_pubkey: string
        proximity: string
        agree: number
        created_at: number
      }>
    ).map((r) => ({
      eventId: r.event_id,
      claimEventId: r.claim_event_id,
      endorserPubkey: r.endorser_pubkey,
      proximity: r.proximity as Endorsement['proximity'],
      agree: r.agree === 1,
      createdAt: r.created_at,
    }))
  }

  // ── Recovery Contacts ─────────────────────────────────────────────────────

  addRecoveryContact(contact: RecoveryContact): void {
    this.db
      .prepare(
        `INSERT INTO recovery_contacts (pubkey, display_name, added_at)
         VALUES (?, ?, ?)
         ON CONFLICT(pubkey) DO UPDATE SET display_name = excluded.display_name`,
      )
      .run(contact.pubkey, contact.displayName, contact.addedAt)
  }

  removeRecoveryContact(pubkey: string): void {
    this.db.prepare('DELETE FROM recovery_contacts WHERE pubkey = ?').run(pubkey)
  }

  getRecoveryContacts(): RecoveryContact[] {
    const rows = this.db
      .prepare('SELECT * FROM recovery_contacts ORDER BY added_at')
      .all() as Array<{ pubkey: string; display_name: string; added_at: number }>
    return rows.map((r) => ({
      pubkey: r.pubkey,
      displayName: r.display_name,
      addedAt: r.added_at,
    }))
  }

  // ── Raw Events ───────────────────────────────────────────────────────────

  addRawEvent(event: ChronicleEvent): void {
    this.db
      .prepare(
        `INSERT INTO raw_events (id, pubkey, created_at, kind, tags, content, sig)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        event.id,
        event.pubkey,
        event.created_at,
        event.kind,
        JSON.stringify(event.tags),
        event.content,
        event.sig,
      )
  }

  getRawEvent(id: string): ChronicleEvent | undefined {
    const row = this.db
      .prepare('SELECT * FROM raw_events WHERE id = ?')
      .get(id) as
      | {
          id: string
          pubkey: string
          created_at: number
          kind: number
          tags: string
          content: string
          sig: string
        }
      | undefined
    if (!row) return undefined
    return {
      id: row.id,
      pubkey: row.pubkey,
      created_at: row.created_at,
      kind: row.kind as ChronicleEvent['kind'],
      tags: JSON.parse(row.tags),
      content: row.content,
      sig: row.sig,
    }
  }

  getAllRawEvents(): ChronicleEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM raw_events ORDER BY created_at')
      .all() as Array<{
      id: string
      pubkey: string
      created_at: number
      kind: number
      tags: string
      content: string
      sig: string
    }>
    return rows.map((r) => ({
      id: r.id,
      pubkey: r.pubkey,
      created_at: r.created_at,
      kind: r.kind as ChronicleEvent['kind'],
      tags: JSON.parse(r.tags),
      content: r.content,
      sig: r.sig,
    }))
  }

  // ── Relationships ─────────────────────────────────────────────────────────

  addRelationship(rel: RelationshipClaim): void {
    this.db
      .prepare(
        `INSERT INTO relationships
           (event_id, claimant_pubkey, subject_pubkey, related_pubkey, relationship,
            sensitive, subtype, relay, created_at, retracted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .run(
        rel.eventId,
        rel.claimantPubkey,
        rel.subjectPubkey,
        rel.relatedPubkey,
        rel.relationship,
        rel.sensitive ? 1 : 0,
        rel.subtype ?? null,
        rel.relay ?? null,
        rel.createdAt,
        rel.retracted ? 1 : 0,
      )
  }

  retractRelationship(eventId: string): void {
    this.db.prepare('UPDATE relationships SET retracted = 1 WHERE event_id = ?').run(eventId)
  }

  getRelationship(eventId: string): RelationshipClaim | undefined {
    const row = this.db
      .prepare('SELECT * FROM relationships WHERE event_id = ?')
      .get(eventId) as RelRow | undefined
    return row ? rowToRel(row) : undefined
  }

  getRelationshipsFor(pubkey: string): RelationshipClaim[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM relationships
         WHERE (subject_pubkey = ? OR related_pubkey = ?) AND retracted = 0
         ORDER BY created_at`,
      )
      .all(pubkey, pubkey) as RelRow[]
    return rows.map(rowToRel)
  }

  getAllRelationships(): RelationshipClaim[] {
    return (this.db.prepare('SELECT * FROM relationships ORDER BY created_at').all() as RelRow[])
      .map(rowToRel)
  }

  // ── Acknowledgements ──────────────────────────────────────────────────────

  addAcknowledgement(ack: Acknowledgement): void {
    this.db
      .prepare(
        `INSERT INTO acknowledgements
           (event_id, claim_event_id, acknowledger_pubkey, approved, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .run(ack.eventId, ack.claimEventId, ack.acknowledgerPubkey, ack.approved ? 1 : 0, ack.createdAt)
  }

  getAcknowledgementsForClaim(claimEventId: string): Acknowledgement[] {
    return (
      this.db
        .prepare('SELECT * FROM acknowledgements WHERE claim_event_id = ? ORDER BY created_at')
        .all(claimEventId) as AckRow[]
    ).map(rowToAck)
  }

  getAllAcknowledgements(): Acknowledgement[] {
    return (
      this.db.prepare('SELECT * FROM acknowledgements ORDER BY created_at').all() as AckRow[]
    ).map(rowToAck)
  }

  // ── Same-Person Links ─────────────────────────────────────────────────────

  addSamePersonLink(link: SamePersonLink): void {
    this.db
      .prepare(
        `INSERT INTO same_person_links
           (event_id, claimant_pubkey, pubkey_a, pubkey_b, created_at, retracted)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .run(
        link.eventId,
        link.claimantPubkey,
        link.pubkeyA,
        link.pubkeyB,
        link.createdAt,
        link.retracted ? 1 : 0,
      )
  }

  retractSamePersonLink(eventId: string): void {
    this.db
      .prepare('UPDATE same_person_links SET retracted = 1 WHERE event_id = ?')
      .run(eventId)
  }

  getSamePersonLinksFor(pubkey: string): SamePersonLink[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM same_person_links
           WHERE (pubkey_a = ? OR pubkey_b = ?) AND retracted = 0
           ORDER BY created_at`,
        )
        .all(pubkey, pubkey) as SplRow[]
    ).map(rowToSpl)
  }

  getAllSamePersonLinks(): SamePersonLink[] {
    return (
      this.db
        .prepare('SELECT * FROM same_person_links ORDER BY created_at')
        .all() as SplRow[]
    ).map(rowToSpl)
  }

  // ── Media Cache ───────────────────────────────────────────────────────────

  upsertMediaCache(ref: BlossomRef, localPath?: string, fetchStatus?: string): void {
    this.db
      .prepare(
        `INSERT INTO media_cache (url, hash, local_path, fetch_status, privacy_tier, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           hash = excluded.hash,
           local_path = excluded.local_path,
           fetch_status = excluded.fetch_status,
           privacy_tier = excluded.privacy_tier`,
      )
      .run(
        ref.url,
        ref.hash,
        localPath ?? null,
        fetchStatus ?? 'pending',
        ref.tier,
        Math.floor(Date.now() / 1000),
      )
  }

  getMediaCache(url: string): MediaCacheRow | undefined {
    return this.db
      .prepare('SELECT * FROM media_cache WHERE url = ?')
      .get(url) as MediaCacheRow | undefined
  }

  getAllMediaCache(): MediaCacheEntry[] {
    return (
      this.db
        .prepare('SELECT * FROM media_cache ORDER BY created_at')
        .all() as MediaCacheRow[]
    ).map(rowToMediaCacheEntry)
  }

  updateMediaFetchStatus(url: string, fetchStatus: string, localPath?: string): void {
    this.db
      .prepare(
        `UPDATE media_cache SET fetch_status = ?, local_path = ? WHERE url = ?`,
      )
      .run(fetchStatus, localPath ?? null, url)
  }

  // ── Serialise (no-op for SQLite — data is already on disk) ───────────────

  serialise(): string {
    // SqliteStore is persistent by nature; this is a no-op stub for API compat.
    return JSON.stringify({ __type: 'SqliteStore', note: 'Data persisted to SQLite' })
  }

  /** Close the database connection. Call on app quit. */
  close(): void {
    this.db.close()
  }
}

// ─── Row types & mappers (module-private) ─────────────────────────────────────

interface RelRow {
  event_id: string; claimant_pubkey: string; subject_pubkey: string
  related_pubkey: string; relationship: string; sensitive: number
  subtype: string | null; relay: string | null; created_at: number; retracted: number
}
interface AckRow {
  event_id: string; claim_event_id: string; acknowledger_pubkey: string
  approved: number; created_at: number
}
interface SplRow {
  event_id: string; claimant_pubkey: string; pubkey_a: string
  pubkey_b: string; created_at: number; retracted: number
}
export interface MediaCacheRow {
  url: string; hash: string; local_path: string | null
  fetch_status: string; privacy_tier: string; created_at: number
}

function rowToRel(r: RelRow): RelationshipClaim {
  return {
    eventId: r.event_id,
    claimantPubkey: r.claimant_pubkey,
    subjectPubkey: r.subject_pubkey,
    relatedPubkey: r.related_pubkey,
    relationship: r.relationship as RelationshipClaim['relationship'],
    sensitive: r.sensitive === 1,
    subtype: (r.subtype ?? undefined) as RelationshipClaim['subtype'],
    relay: r.relay ?? undefined,
    createdAt: r.created_at,
    retracted: r.retracted === 1,
  }
}
function rowToAck(r: AckRow): Acknowledgement {
  return {
    eventId: r.event_id,
    claimEventId: r.claim_event_id,
    acknowledgerPubkey: r.acknowledger_pubkey,
    approved: r.approved === 1,
    createdAt: r.created_at,
  }
}
function rowToSpl(r: SplRow): SamePersonLink {
  return {
    eventId: r.event_id,
    claimantPubkey: r.claimant_pubkey,
    pubkeyA: r.pubkey_a,
    pubkeyB: r.pubkey_b,
    createdAt: r.created_at,
    retracted: r.retracted === 1,
  }
}

function rowToMediaCacheEntry(r: MediaCacheRow): MediaCacheEntry {
  const ref: BlossomRef = {
    url: r.url,
    hash: r.hash,
    tier: r.privacy_tier as PrivacyTier,
    // subjectNpub and mimeType are not stored in the DB row — they are
    // recoverable from the originating event. Return minimal values here.
    subjectNpub: '',
    mimeType: '',
    size: 0,
  }
  return {
    ref,
    status: r.fetch_status as FetchStatus,
    localUrl: r.local_path ?? undefined,
  }
}
