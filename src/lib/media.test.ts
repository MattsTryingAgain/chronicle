/**
 * media.test.ts — tests for Media Phase 1
 *
 * Covers:
 * - buildAvatarEvent / parseAvatarEvent round-trip
 * - buildStoryEvent / parseStoryEvent round-trip
 * - relaySync media ingesters (getAvatar, getStoriesForPerson)
 * - estimateBase64Size utility
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { generateUserMnemonic, deriveKeyMaterialFromMnemonic } from '../lib/keys'
import {
  buildAvatarEvent,
  parseAvatarEvent,
  buildStoryEvent,
  parseStoryEvent,
  buildFactClaim,
} from '../lib/eventBuilder'
import { estimateBase64Size } from '../lib/media'
import {
  ingestEvent,
  ingestAvatarEvent,
  ingestStoryEvent,
  getAvatar,
  getStoriesForPerson,
  reconcilePersonAliases,
  _resetMediaStore,
} from '../lib/relaySync'
import { store } from '../lib/storage'
import type { ChronicleEvent } from '../types/chronicle'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeKeypair() {
  const mnemonic = generateUserMnemonic()
  return deriveKeyMaterialFromMnemonic(mnemonic)
}

const SAMPLE_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U'
const PERSON_ID = '550e8400-e29b-41d4-a716-446655440001'
const PERSON_ID_2 = '550e8400-e29b-41d4-a716-446655440002'

// ─── estimateBase64Size ───────────────────────────────────────────────────────

describe('estimateBase64Size', () => {
  it('returns 0 for an empty data URL', () => {
    expect(estimateBase64Size('data:image/jpeg;base64,')).toBe(0)
  })

  it('estimates size correctly for known base64 string', () => {
    // "Hello" in base64 is "SGVsbG8=" (8 chars → 5 bytes after padding removal)
    const dataUrl = 'data:text/plain;base64,SGVsbG8='
    const size = estimateBase64Size(dataUrl)
    expect(size).toBe(5)
  })

  it('handles base64 without padding', () => {
    // "Hi" → "SGk=" — but if padding stripped: "SGk" (4 chars → 2 bytes)
    const dataUrl = 'data:text/plain;base64,SGk='
    expect(estimateBase64Size(dataUrl)).toBe(2)
  })
})

// ─── buildAvatarEvent / parseAvatarEvent ─────────────────────────────────────

describe('buildAvatarEvent / parseAvatarEvent', () => {
  it('round-trips a JPEG avatar event', () => {
    const kp = makeKeypair()
    const event = buildAvatarEvent(kp.npub, kp.nsec, PERSON_ID, SAMPLE_DATA_URL, 'image/jpeg', 1024)

    expect(event.kind).toBe(30095)
    expect(event.content).toBe(SAMPLE_DATA_URL)

    const tags = Object.fromEntries(event.tags.map(([k, v]) => [k, v]))
    expect(tags['person_id']).toBe(PERSON_ID)
    expect(tags['type']).toBe('avatar')
    expect(tags['mime_type']).toBe('image/jpeg')
    expect(tags['size']).toBe('1024')
  })

  it('parseAvatarEvent returns null for non-avatar kind 30095 event', () => {
    const kp = makeKeypair()
    const event = buildAvatarEvent(kp.npub, kp.nsec, PERSON_ID, SAMPLE_DATA_URL, 'image/jpeg', 100)
    // Remove the type=avatar tag
    const tampered: ChronicleEvent = {
      ...JSON.parse(JSON.stringify(event)),
      tags: event.tags.filter(([k]) => k !== 'type'),
    }
    expect(parseAvatarEvent(tampered)).toBeNull()
  })

  it('parseAvatarEvent returns null for wrong kind', () => {
    const kp = makeKeypair()
    const event = buildAvatarEvent(kp.npub, kp.nsec, PERSON_ID, SAMPLE_DATA_URL, 'image/jpeg', 100)
    const tampered = { ...JSON.parse(JSON.stringify(event)), kind: 30096 }
    expect(parseAvatarEvent(tampered as ChronicleEvent)).toBeNull()
  })

  it('parseAvatarEvent extracts all fields correctly', () => {
    const kp = makeKeypair()
    const event = buildAvatarEvent(kp.npub, kp.nsec, PERSON_ID, SAMPLE_DATA_URL, 'image/png', 2048)
    const parsed = parseAvatarEvent(event)

    expect(parsed).not.toBeNull()
    expect(parsed!.personId).toBe(PERSON_ID)
    expect(parsed!.dataUrl).toBe(SAMPLE_DATA_URL)
    expect(parsed!.mimeType).toBe('image/png')
    expect(parsed!.size).toBe(2048)
    expect(parsed!.eventId).toBe(event.id)
    expect(parsed!.createdAt).toBe(event.created_at)
  })

  it('parseAvatarEvent returns null when content is missing', () => {
    const kp = makeKeypair()
    const event = buildAvatarEvent(kp.npub, kp.nsec, PERSON_ID, SAMPLE_DATA_URL, 'image/jpeg', 100)
    const tampered = { ...JSON.parse(JSON.stringify(event)), content: '' }
    expect(parseAvatarEvent(tampered as ChronicleEvent)).toBeNull()
  })
})

// ─── buildStoryEvent / parseStoryEvent ───────────────────────────────────────

describe('buildStoryEvent / parseStoryEvent', () => {
  it('round-trips a story event', () => {
    const kp = makeKeypair()
    const event = buildStoryEvent(kp.npub, kp.nsec, PERSON_ID, 'The old farm', 'There was a barn...')

    expect(event.kind).toBe(30096)
    expect(event.content).toBe('There was a barn...')

    const tags = Object.fromEntries(event.tags.map(([k, v]) => [k, v]))
    expect(tags['person_id']).toBe(PERSON_ID)
    expect(tags['title']).toBe('The old farm')
  })

  it('parseStoryEvent extracts all fields', () => {
    const kp = makeKeypair()
    const event = buildStoryEvent(kp.npub, kp.nsec, PERSON_ID, 'My title', 'Story content here')
    const parsed = parseStoryEvent(event)

    expect(parsed).not.toBeNull()
    expect(parsed!.personId).toBe(PERSON_ID)
    expect(parsed!.title).toBe('My title')
    expect(parsed!.content).toBe('Story content here')
    expect(parsed!.eventId).toBe(event.id)
    expect(parsed!.createdAt).toBe(event.created_at)
    // authorNpub should be derived from event.pubkey
    expect(parsed!.authorNpub).toMatch(/^npub1/)
  })

  it('parseStoryEvent returns null for wrong kind', () => {
    const kp = makeKeypair()
    const event = buildStoryEvent(kp.npub, kp.nsec, PERSON_ID, 'Title', 'Content')
    const tampered = { ...JSON.parse(JSON.stringify(event)), kind: 30095 }
    expect(parseStoryEvent(tampered as ChronicleEvent)).toBeNull()
  })

  it('parseStoryEvent returns null when content is empty', () => {
    const kp = makeKeypair()
    const event = buildStoryEvent(kp.npub, kp.nsec, PERSON_ID, 'Title', 'Content')
    const tampered = { ...JSON.parse(JSON.stringify(event)), content: '' }
    expect(parseStoryEvent(tampered as ChronicleEvent)).toBeNull()
  })

  it('parseStoryEvent uses empty string for missing title', () => {
    const kp = makeKeypair()
    const event = buildStoryEvent(kp.npub, kp.nsec, PERSON_ID, '', 'Content without title')
    const parsed = parseStoryEvent(event)
    expect(parsed?.title).toBe('')
    expect(parsed?.content).toBe('Content without title')
  })
})

// ─── relaySync media ingesters ────────────────────────────────────────────────

describe('relaySync media ingesters', () => {
  beforeEach(() => {
    _resetMediaStore()
    store.clearAll()
  })

  it('getAvatar returns undefined when no avatar ingested', () => {
    expect(getAvatar(PERSON_ID)).toBeUndefined()
  })

  it('ingests an avatar event and makes it retrievable', () => {
    const kp = makeKeypair()
    // Ensure person stub exists
    store.upsertPerson({ id: PERSON_ID, displayName: 'Ralph', isLiving: false, createdAt: 1000 })

    const event = buildAvatarEvent(kp.npub, kp.nsec, PERSON_ID, SAMPLE_DATA_URL, 'image/jpeg', 512)
    ingestEvent(event)

    const avatar = getAvatar(PERSON_ID)
    expect(avatar).toBeDefined()
    expect(avatar!.personId).toBe(PERSON_ID)
    expect(avatar!.dataUrl).toBe(SAMPLE_DATA_URL)
    expect(avatar!.mimeType).toBe('image/jpeg')
  })

  it('newer avatar replaces older avatar for same person', () => {
    const kp = makeKeypair()
    store.upsertPerson({ id: PERSON_ID, displayName: 'Ralph', isLiving: false, createdAt: 1000 })

    const oldEvent = buildAvatarEvent(kp.npub, kp.nsec, PERSON_ID, 'data:image/jpeg;base64,OLD', 'image/jpeg', 100)
    const newEvent = buildAvatarEvent(kp.npub, kp.nsec, PERSON_ID, SAMPLE_DATA_URL, 'image/jpeg', 512)
    // Manually set created_at so new > old
    const olderEvent = { ...JSON.parse(JSON.stringify(oldEvent)), created_at: 1000, id: oldEvent.id + 'a' }
    const newerEvent = { ...JSON.parse(JSON.stringify(newEvent)), created_at: 2000 }

    ingestEvent(olderEvent as ChronicleEvent)
    ingestEvent(newerEvent as ChronicleEvent)

    expect(getAvatar(PERSON_ID)!.dataUrl).toBe(SAMPLE_DATA_URL)
  })

  it('older avatar does not replace newer avatar', () => {
    const kp = makeKeypair()
    store.upsertPerson({ id: PERSON_ID, displayName: 'Ralph', isLiving: false, createdAt: 1000 })

    const oldEvent = buildAvatarEvent(kp.npub, kp.nsec, PERSON_ID, SAMPLE_DATA_URL, 'image/jpeg', 512)
    const newEvent = buildAvatarEvent(kp.npub, kp.nsec, PERSON_ID, 'data:image/jpeg;base64,NEW', 'image/jpeg', 100)

    const newerEvent = { ...JSON.parse(JSON.stringify(newEvent)), created_at: 2000 }
    const olderEvent = { ...JSON.parse(JSON.stringify(oldEvent)), created_at: 1000, id: oldEvent.id + 'b' }

    ingestEvent(newerEvent as ChronicleEvent)
    ingestEvent(olderEvent as ChronicleEvent)

    expect(getAvatar(PERSON_ID)!.dataUrl).toBe('data:image/jpeg;base64,NEW')
  })

  it('ingests story events and retrieves them for a person', () => {
    const kp = makeKeypair()
    store.upsertPerson({ id: PERSON_ID, displayName: 'Ralph', isLiving: false, createdAt: 1000 })

    const story1 = buildStoryEvent(kp.npub, kp.nsec, PERSON_ID, 'Title A', 'Content A')
    const story2 = buildStoryEvent(kp.npub, kp.nsec, PERSON_ID, 'Title B', 'Content B')
    ingestEvent(story1)
    ingestEvent(story2)

    const stories = getStoriesForPerson(PERSON_ID)
    expect(stories).toHaveLength(2)
    const titles = stories.map(s => s.title)
    expect(titles).toContain('Title A')
    expect(titles).toContain('Title B')
  })

  it('stories are sorted newest-first', () => {
    const kp = makeKeypair()
    store.upsertPerson({ id: PERSON_ID, displayName: 'Ralph', isLiving: false, createdAt: 1000 })

    const story1 = buildStoryEvent(kp.npub, kp.nsec, PERSON_ID, 'Older', 'Content A')
    const story2 = buildStoryEvent(kp.npub, kp.nsec, PERSON_ID, 'Newer', 'Content B')

    const olderEvent = { ...JSON.parse(JSON.stringify(story1)), created_at: 1000, id: story1.id + 'c' }
    const newerEvent = { ...JSON.parse(JSON.stringify(story2)), created_at: 2000 }

    ingestEvent(olderEvent as ChronicleEvent)
    ingestEvent(newerEvent as ChronicleEvent)

    const stories = getStoriesForPerson(PERSON_ID)
    expect(stories[0].title).toBe('Newer')
    expect(stories[1].title).toBe('Older')
  })

  it('getStoriesForPerson returns only stories for that person', () => {
    const kp = makeKeypair()
    store.upsertPerson({ id: PERSON_ID, displayName: 'Ralph', isLiving: false, createdAt: 1000 })
    store.upsertPerson({ id: PERSON_ID_2, displayName: 'Diane', isLiving: false, createdAt: 1000 })

    const story1 = buildStoryEvent(kp.npub, kp.nsec, PERSON_ID,   'Ralph story', 'Content')
    const story2 = buildStoryEvent(kp.npub, kp.nsec, PERSON_ID_2, 'Diane story', 'Content')
    ingestEvent(story1)
    ingestEvent(story2)

    expect(getStoriesForPerson(PERSON_ID)).toHaveLength(1)
    expect(getStoriesForPerson(PERSON_ID)[0].title).toBe('Ralph story')
    expect(getStoriesForPerson(PERSON_ID_2)).toHaveLength(1)
    expect(getStoriesForPerson(PERSON_ID_2)[0].title).toBe('Diane story')
  })

  it('_resetMediaStore clears all stored media', () => {
    const kp = makeKeypair()
    store.upsertPerson({ id: PERSON_ID, displayName: 'Ralph', isLiving: false, createdAt: 1000 })

    const avatar = buildAvatarEvent(kp.npub, kp.nsec, PERSON_ID, SAMPLE_DATA_URL, 'image/jpeg', 100)
    const story = buildStoryEvent(kp.npub, kp.nsec, PERSON_ID, 'Title', 'Content')
    ingestEvent(avatar)
    ingestEvent(story)

    _resetMediaStore()

    expect(getAvatar(PERSON_ID)).toBeUndefined()
    expect(getStoriesForPerson(PERSON_ID)).toHaveLength(0)
  })
})

// ─── Alias-aware media lookup ─────────────────────────────────────────────────

describe('alias-aware media lookup', () => {
  beforeEach(() => {
    _resetMediaStore()
    store.clearAll()
  })

  it('getStoriesForPerson finds stories filed under an alias ID', () => {
    const kp = makeKeypair()
    // Two IDs for the same person (local UUID + remote npub from another instance)
    const localUuid = '550e8400-e29b-41d4-a716-000000000010'
    const remoteNpub = kp.npub

    store.upsertPerson({ id: localUuid, displayName: 'Maria', isLiving: true, createdAt: 1000 })
    // Register remoteNpub as an alias of localUuid (simulates receiving identity anchor)
    store.addPersonAlias({ localId: localUuid, remoteId: remoteNpub, creatorNpub: remoteNpub, createdAt: 1000 })

    // Story event uses remoteNpub as person_id (written by the remote instance)
    const event = buildStoryEvent(kp.npub, kp.nsec, remoteNpub, 'Maria story', 'Content')
    ingestStoryEvent(event)

    // Query via the local UUID — should still find the story
    const stories = getStoriesForPerson(localUuid)
    expect(stories).toHaveLength(1)
    expect(stories[0].title).toBe('Maria story')
  })

  it('getAvatar finds avatar filed under an alias ID', () => {
    const kp = makeKeypair()
    const localUuid = '550e8400-e29b-41d4-a716-000000000011'
    const remoteNpub = kp.npub

    store.upsertPerson({ id: localUuid, displayName: 'Maria', isLiving: true, createdAt: 1000 })
    store.addPersonAlias({ localId: localUuid, remoteId: remoteNpub, creatorNpub: remoteNpub, createdAt: 1000 })

    // Avatar filed under remoteNpub
    const event = buildAvatarEvent(kp.npub, kp.nsec, remoteNpub, SAMPLE_DATA_URL, 'image/jpeg', 512)
    ingestAvatarEvent(event)

    // Query via localUuid — should find it
    const avatar = getAvatar(localUuid)
    expect(avatar).toBeDefined()
    expect(avatar!.dataUrl).toBe(SAMPLE_DATA_URL)
  })

  it('getStoriesForPerson via canonical also finds stories filed under alias', () => {
    const kp = makeKeypair()
    const localUuid = '550e8400-e29b-41d4-a716-000000000012'
    const remoteNpub = kp.npub

    store.upsertPerson({ id: localUuid, displayName: 'Maria', isLiving: true, createdAt: 1000 })
    store.addPersonAlias({ localId: localUuid, remoteId: remoteNpub, creatorNpub: remoteNpub, createdAt: 1000 })

    // Story filed under localUuid
    const kp2 = makeKeypair()
    const event = buildStoryEvent(kp2.npub, kp2.nsec, localUuid, 'Local story', 'Content')
    ingestStoryEvent(event)

    // Query via remoteNpub — should also find it
    const stories = getStoriesForPerson(remoteNpub)
    expect(stories).toHaveLength(1)
    expect(stories[0].title).toBe('Local story')
  })
})

// ─── reconcilePersonAliases ───────────────────────────────────────────────────

describe('reconcilePersonAliases', () => {
  beforeEach(() => {
    _resetMediaStore()
    store.clearAll()
  })

  it('registers alias when a remote subject ID has the same name as a local person', () => {
    const kp = deriveKeyMaterialFromMnemonic(generateUserMnemonic())
    const localUuid = '550e8400-0000-0000-0000-000000000020'
    const remoteUuid = '550e8400-0000-0000-0000-000000000021'

    // Local person with displayName "Maria"
    store.upsertPerson({ id: localUuid, displayName: 'Maria', isLiving: true, createdAt: 1000 })

    // Raw fact claim from remote instance with subject = remoteUuid, name = "Maria"
    const event = buildFactClaim({
      claimantNpub: kp.npub,
      claimantNsec: kp.nsec,
      subjectId: remoteUuid,
      field: 'name',
      value: 'Maria',
    })
    store.addRawEvent(event)

    reconcilePersonAliases()

    // remoteUuid should now resolve to localUuid
    expect(store.resolvePersonId(remoteUuid)).toBe(localUuid)
  })

  it('does not register alias when multiple persons share the same name (ambiguous)', () => {
    const kp = deriveKeyMaterialFromMnemonic(generateUserMnemonic())
    const localUuid1 = '550e8400-0000-0000-0000-000000000030'
    const localUuid2 = '550e8400-0000-0000-0000-000000000031'
    const remoteUuid = '550e8400-0000-0000-0000-000000000032'

    store.upsertPerson({ id: localUuid1, displayName: 'Maria', isLiving: false, createdAt: 1000 })
    store.upsertPerson({ id: localUuid2, displayName: 'Maria', isLiving: false, createdAt: 1000 })

    const event = buildFactClaim({
      claimantNpub: kp.npub,
      claimantNsec: kp.nsec,
      subjectId: remoteUuid,
      field: 'name',
      value: 'Maria',
    })
    store.addRawEvent(event)

    reconcilePersonAliases()

    // Should NOT alias — two candidates, ambiguous
    expect(store.resolvePersonId(remoteUuid)).toBeNull()
  })

  it('does not register alias when subject ID is already a known local person', () => {
    const kp = deriveKeyMaterialFromMnemonic(generateUserMnemonic())
    const localUuid = '550e8400-0000-0000-0000-000000000040'

    store.upsertPerson({ id: localUuid, displayName: 'Maria', isLiving: false, createdAt: 1000 })

    // Fact claim where subject IS the known local person — should not create a self-alias
    const event = buildFactClaim({
      claimantNpub: kp.npub,
      claimantNsec: kp.nsec,
      subjectId: localUuid,
      field: 'name',
      value: 'Maria',
    })
    store.addRawEvent(event)

    reconcilePersonAliases()

    // localUuid is already a known person — no alias needed
    expect(store.getAliasesFor(localUuid)).toHaveLength(0)
  })

  it('is idempotent — calling twice does not create duplicate aliases', () => {
    const kp = deriveKeyMaterialFromMnemonic(generateUserMnemonic())
    const localUuid = '550e8400-0000-0000-0000-000000000050'
    const remoteUuid = '550e8400-0000-0000-0000-000000000051'

    store.upsertPerson({ id: localUuid, displayName: 'Maria', isLiving: true, createdAt: 1000 })

    const event = buildFactClaim({
      claimantNpub: kp.npub,
      claimantNsec: kp.nsec,
      subjectId: remoteUuid,
      field: 'name',
      value: 'Maria',
    })
    store.addRawEvent(event)

    reconcilePersonAliases()
    reconcilePersonAliases()

    expect(store.getAliasesFor(localUuid)).toHaveLength(1)
  })

  it('after alias, getAvatar finds avatar filed under remote UUID when queried by local UUID', () => {
    const kp = deriveKeyMaterialFromMnemonic(generateUserMnemonic())
    const localUuid = '550e8400-0000-0000-0000-000000000060'
    const remoteUuid = '550e8400-0000-0000-0000-000000000061'

    store.upsertPerson({ id: localUuid, displayName: 'Maria', isLiving: true, createdAt: 1000 })

    // Name claim for remoteUuid = "Maria"
    const nameClaim = buildFactClaim({
      claimantNpub: kp.npub,
      claimantNsec: kp.nsec,
      subjectId: remoteUuid,
      field: 'name',
      value: 'Maria',
    })
    store.addRawEvent(nameClaim)

    // Avatar filed under remoteUuid
    const avatarEvent = buildAvatarEvent(kp.npub, kp.nsec, remoteUuid, SAMPLE_DATA_URL, 'image/jpeg', 512)
    ingestAvatarEvent(avatarEvent)

    // Before reconcile: not found via localUuid
    expect(getAvatar(localUuid)).toBeUndefined()

    reconcilePersonAliases()

    // After reconcile: found via localUuid
    expect(getAvatar(localUuid)).toBeDefined()
    expect(getAvatar(localUuid)!.dataUrl).toBe(SAMPLE_DATA_URL)
  })
})
