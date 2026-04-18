// Pure-JS in-memory mock for better-sqlite3
// Handles all Chronicle SQLite tables including Stage 7 additions.

class MockStatement {
  constructor(sql, db) {
    this.sql = sql.trim()
    this.db = db
  }

  run(...args) {
    const flat = args.flat()
    const sql = this.sql
    const db = this.db

    // ── INSERT / UPSERT ───────────────────────────────────────────────────────
    if (/INSERT INTO identity/i.test(sql)) {
      const [npub, displayName, encNsec, createdAt] = flat
      db._t('identity').set('1', { id: 1, npub, display_name: displayName, encrypted_nsec: encNsec, created_at: createdAt })
    } else if (/DELETE FROM identity/i.test(sql)) {
      db._t('identity').clear()
    } else if (/INSERT INTO ancestor_keys/i.test(sql)) {
      const [npub, encPriv] = flat
      db._t('ancestor_keys').set(npub, { npub, encrypted_privkey: encPriv })
    } else if (/INSERT INTO persons/i.test(sql)) {
      const tbl = db._t('persons')
      const [pubkey, displayName, isLiving, createdAt] = flat
      const existing = tbl.get(pubkey)
      const rowid = existing ? existing.rowid : db._seq('persons')
      tbl.set(pubkey, { pubkey, display_name: displayName, is_living: isLiving, created_at: createdAt, rowid })
    } else if (/INSERT INTO claims/i.test(sql)) {
      const tbl = db._t('claims')
      const [eventId, claimantPubkey, subjectPubkey, field, value, evidence, createdAt, retracted, confidence] = flat
      if (!tbl.has(eventId)) tbl.set(eventId, { event_id: eventId, claimant_pubkey: claimantPubkey, subject_pubkey: subjectPubkey, field, value, evidence, created_at: createdAt, retracted, confidence })
    } else if (/UPDATE claims SET retracted/i.test(sql)) {
      const tbl = db._t('claims')
      // flat[0] could be eventId (WHERE event_id = ?) 
      // or it could be split: first is SET part, last is WHERE part
      // UPDATE claims SET retracted = 1 WHERE event_id = ?
      const eventId = flat[flat.length - 1]
      const row = tbl.get(eventId)
      if (row) tbl.set(eventId, { ...row, retracted: 1 })
    } else if (/INSERT INTO endorsements/i.test(sql)) {
      const tbl = db._t('endorsements')
      const [eventId, claimEventId, endorserPubkey, proximity, agree, createdAt] = flat
      if (!tbl.has(eventId)) tbl.set(eventId, { event_id: eventId, claim_event_id: claimEventId, endorser_pubkey: endorserPubkey, proximity, agree, created_at: createdAt })
    } else if (/INSERT INTO recovery_contacts/i.test(sql)) {
      const [pubkey, displayName, addedAt] = flat
      db._t('recovery_contacts').set(pubkey, { pubkey, display_name: displayName, added_at: addedAt })
    } else if (/DELETE FROM recovery_contacts/i.test(sql)) {
      db._t('recovery_contacts').delete(flat[0])
    } else if (/INSERT INTO raw_events/i.test(sql)) {
      const tbl = db._t('raw_events')
      const [id, pubkey, createdAt, kind, tags, content, sig] = flat
      if (!tbl.has(id)) tbl.set(id, { id, pubkey, created_at: createdAt, kind, tags, content, sig })

    // ── Stage 7: relationships ────────────────────────────────────────────────
    } else if (/INSERT INTO relationships/i.test(sql)) {
      const tbl = db._t('relationships')
      const [eventId, claimantPubkey, subjectPubkey, relatedPubkey, relationship, sensitive, subtype, relay, createdAt, retracted] = flat
      if (!tbl.has(eventId)) tbl.set(eventId, { event_id: eventId, claimant_pubkey: claimantPubkey, subject_pubkey: subjectPubkey, related_pubkey: relatedPubkey, relationship, sensitive, subtype: subtype ?? null, relay: relay ?? null, created_at: createdAt, retracted: retracted ?? 0 })
    } else if (/UPDATE relationships SET retracted/i.test(sql)) {
      const tbl = db._t('relationships')
      const eventId = flat[flat.length - 1]
      const row = tbl.get(eventId)
      if (row) tbl.set(eventId, { ...row, retracted: 1 })

    // ── Stage 7: acknowledgements ─────────────────────────────────────────────
    } else if (/INSERT INTO acknowledgements/i.test(sql)) {
      const tbl = db._t('acknowledgements')
      const [eventId, claimEventId, acknowledgerPubkey, approved, createdAt] = flat
      if (!tbl.has(eventId)) tbl.set(eventId, { event_id: eventId, claim_event_id: claimEventId, acknowledger_pubkey: acknowledgerPubkey, approved, created_at: createdAt })

    // ── Stage 7: same_person_links ────────────────────────────────────────────
    } else if (/INSERT INTO same_person_links/i.test(sql)) {
      const tbl = db._t('same_person_links')
      const [eventId, claimantPubkey, pubkeyA, pubkeyB, createdAt, retracted] = flat
      if (!tbl.has(eventId)) tbl.set(eventId, { event_id: eventId, claimant_pubkey: claimantPubkey, pubkey_a: pubkeyA, pubkey_b: pubkeyB, created_at: createdAt, retracted: retracted ?? 0 })
    } else if (/UPDATE same_person_links SET retracted/i.test(sql)) {
      const tbl = db._t('same_person_links')
      const eventId = flat[flat.length - 1]
      const row = tbl.get(eventId)
      if (row) tbl.set(eventId, { ...row, retracted: 1 })

    // ── Stage 7: media_cache ──────────────────────────────────────────────────
    } else if (/INSERT INTO media_cache/i.test(sql)) {
      const tbl = db._t('media_cache')
      // INSERT INTO media_cache (url, hash, local_path, fetch_status, privacy_tier, created_at)
      // VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET ...
      const [url, hash, localPath, fetchStatus, privacyTier, createdAt] = flat
      tbl.set(url, { url, hash, local_path: localPath ?? null, fetch_status: fetchStatus ?? 'pending', privacy_tier: privacyTier ?? 'public', created_at: createdAt })
    } else if (/UPDATE media_cache SET fetch_status/i.test(sql)) {
      const tbl = db._t('media_cache')
      // UPDATE media_cache SET fetch_status = ?, local_path = ? WHERE url = ?
      // flat = [fetchStatus, localPath, url]
      const [fetchStatus, localPath, url] = flat
      const row = tbl.get(url)
      if (row) tbl.set(url, { ...row, fetch_status: fetchStatus, local_path: localPath ?? row.local_path })
    }

    return { changes: 1, lastInsertRowid: 0 }
  }

  get(...args) {
    const flat = args.flat()
    const sql = this.sql
    const db = this.db

    if (/FROM identity/i.test(sql)) return db._t('identity').get('1')
    if (/FROM ancestor_keys/i.test(sql)) return db._t('ancestor_keys').get(flat[0])
    if (/FROM persons WHERE pubkey/i.test(sql)) return db._t('persons').get(flat[0])
    if (/FROM raw_events WHERE id/i.test(sql)) return db._t('raw_events').get(flat[0])
    if (/FROM relationships WHERE event_id/i.test(sql)) return db._t('relationships').get(flat[0])
    if (/FROM media_cache WHERE url/i.test(sql)) return db._t('media_cache').get(flat[0])
    return undefined
  }

  all(...args) {
    const flat = args.flat()
    const sql = this.sql
    const db = this.db

    // persons FTS search (JOIN persons_fts ... WHERE persons_fts MATCH ?)
    if (/persons_fts MATCH/i.test(sql)) {
      const query = (flat[0] || '').toString().replace(/[\"*]/g, '').toLowerCase().trim()
      if (!query) return Array.from(db._t('persons').values())
      return Array.from(db._t('persons').values()).filter(r => r.display_name.toLowerCase().includes(query))
    }
    if (/FROM persons/i.test(sql)) return Array.from(db._t('persons').values())

    if (/FROM claims WHERE subject_pubkey/i.test(sql)) return Array.from(db._t('claims').values()).filter(r => r.subject_pubkey === flat[0])
    if (/FROM endorsements WHERE claim_event_id/i.test(sql)) return Array.from(db._t('endorsements').values()).filter(r => r.claim_event_id === flat[0])
    if (/FROM endorsements/i.test(sql)) return Array.from(db._t('endorsements').values())
    if (/FROM recovery_contacts/i.test(sql)) return Array.from(db._t('recovery_contacts').values())
    if (/FROM raw_events/i.test(sql)) return Array.from(db._t('raw_events').values())

    // Stage 7: relationships
    if (/FROM relationships\s+WHERE \(subject_pubkey = \? OR related_pubkey = \?\) AND retracted = 0/i.test(sql)) {
      const pubkey = flat[0]
      return Array.from(db._t('relationships').values()).filter(r => (r.subject_pubkey === pubkey || r.related_pubkey === pubkey) && !r.retracted)
    }
    if (/FROM relationships ORDER BY/i.test(sql)) return Array.from(db._t('relationships').values())

    // Stage 7: acknowledgements
    if (/FROM acknowledgements WHERE claim_event_id/i.test(sql)) return Array.from(db._t('acknowledgements').values()).filter(r => r.claim_event_id === flat[0])
    if (/FROM acknowledgements ORDER BY/i.test(sql)) return Array.from(db._t('acknowledgements').values())

    // Stage 7: same_person_links
    if (/FROM same_person_links\s+WHERE \(pubkey_a = \? OR pubkey_b = \?\) AND retracted = 0/i.test(sql)) {
      const pubkey = flat[0]
      return Array.from(db._t('same_person_links').values()).filter(r => (r.pubkey_a === pubkey || r.pubkey_b === pubkey) && !r.retracted)
    }
    if (/FROM same_person_links ORDER BY/i.test(sql)) return Array.from(db._t('same_person_links').values())

    // Stage 7: media_cache
    if (/FROM media_cache ORDER BY/i.test(sql)) return Array.from(db._t('media_cache').values())

    return []
  }
}

class MockDatabase {
  constructor(_path) {
    this._tables = new Map()
    this._sequences = new Map()
  }

  exec(sql) {
    const matches = sql.matchAll(/CREATE (?:VIRTUAL )?TABLE IF NOT EXISTS (\w+)/g)
    for (const m of matches) {
      if (!this._tables.has(m[1])) this._tables.set(m[1], new Map())
    }
  }

  pragma(_str) { return 0 }

  prepare(sql) { return new MockStatement(sql, this) }

  _t(name) {
    if (!this._tables.has(name)) this._tables.set(name, new Map())
    return this._tables.get(name)
  }

  _seq(table) {
    const n = (this._sequences.get(table) ?? 0) + 1
    this._sequences.set(table, n)
    return n
  }
}

module.exports = MockDatabase
