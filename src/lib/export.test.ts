/**
 * Tests for Chronicle export module
 */

import { describe, it, expect } from 'vitest'
import { generateGedcom, generateArchive, type ExportablePerson } from './export'
import type { Person, FactClaim } from '../types/chronicle'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const thomas: Person = {
  pubkey: 'npub1thomas',
  displayName: 'Thomas O\'Brien',
  isLiving: false,
  createdAt: 1_000,
}

const alice: Person = {
  pubkey: 'npub1alice',
  displayName: 'Alice O\'Brien',
  isLiving: true,
  createdAt: 2_000,
}

function makeClaim(overrides: Partial<FactClaim>): FactClaim {
  return {
    eventId: 'evt001',
    claimantPubkey: 'npub1claimant',
    subjectPubkey: 'npub1thomas',
    field: 'born',
    value: '1930',
    createdAt: 1_000,
    retracted: false,
    confidenceScore: 1.0,
    ...overrides,
  }
}

// ─── GEDCOM ───────────────────────────────────────────────────────────────────

describe('generateGedcom', () => {
  it('includes GEDCOM header and trailer', () => {
    const out = generateGedcom([])
    expect(out).toContain('0 HEAD')
    expect(out).toContain('0 TRLR')
    expect(out).toContain('1 SOUR CHRONICLE')
    expect(out).toContain('2 VERS 5.5.1')
    expect(out).toContain('1 CHAR UTF-8')
  })

  it('generates an INDI record for each person', () => {
    const persons: ExportablePerson[] = [
      { person: thomas, claims: [] },
      { person: alice, claims: [] },
    ]
    const out = generateGedcom(persons)
    expect(out).toContain('INDI')
    // Two INDI records
    expect((out.match(/@ INDI/g) ?? []).length).toBe(2)
  })

  it('uses displayName as NAME when no name claim exists', () => {
    const out = generateGedcom([{ person: thomas, claims: [] }])
    expect(out).toContain("1 NAME Thomas O'Brien")
  })

  it('uses claim value for NAME when claim exists', () => {
    const nameClaim = makeClaim({ field: 'name', value: 'Thomas Patrick O\'Brien' })
    const out = generateGedcom([{ person: thomas, claims: [nameClaim] }])
    expect(out).toContain("1 NAME Thomas Patrick O'Brien")
  })

  it('includes BIRT block when born or birthplace claim exists', () => {
    const bornClaim = makeClaim({ field: 'born', value: '1930' })
    const placeClaim = makeClaim({ eventId: 'evt002', field: 'birthplace', value: 'Cork, Ireland' })
    const out = generateGedcom([{ person: thomas, claims: [bornClaim, placeClaim] }])
    expect(out).toContain('1 BIRT')
    expect(out).toContain('2 DATE 1930')
    expect(out).toContain('2 PLAC Cork, Ireland')
  })

  it('includes DEAT block when died or deathplace claim exists', () => {
    const diedClaim = makeClaim({ eventId: 'evt003', field: 'died', value: '1995' })
    const out = generateGedcom([{ person: thomas, claims: [diedClaim] }])
    expect(out).toContain('1 DEAT')
    expect(out).toContain('2 DATE 1995')
  })

  it('includes OCCU when occupation claim exists', () => {
    const claim = makeClaim({ field: 'occupation', value: 'Farmer' })
    const out = generateGedcom([{ person: thomas, claims: [claim] }])
    expect(out).toContain('1 OCCU Farmer')
  })

  it('excludes retracted claims', () => {
    const retracted = makeClaim({ field: 'born', value: '1920', retracted: true })
    const active = makeClaim({ eventId: 'evt002', field: 'born', value: '1930', retracted: false })
    const out = generateGedcom([{ person: thomas, claims: [retracted, active] }])
    expect(out).toContain('2 DATE 1930')
    expect(out).not.toContain('2 DATE 1920')
  })

  it('picks highest-confidence claim when multiple exist for same field', () => {
    const low = makeClaim({ eventId: 'evt001', field: 'born', value: '1925', confidenceScore: 0.3 })
    const high = makeClaim({ eventId: 'evt002', field: 'born', value: '1930', confidenceScore: 0.9 })
    const out = generateGedcom([{ person: thomas, claims: [low, high] }])
    expect(out).toContain('2 DATE 1930')
    expect(out).not.toContain('2 DATE 1925')
  })

  it('produces valid UTF-8 output (no latin1 escaping)', () => {
    const claim = makeClaim({ field: 'birthplace', value: 'Köln, Deutschland' })
    const out = generateGedcom([{ person: thomas, claims: [claim] }])
    expect(out).toContain('Köln')
  })
})

// ─── Archive ──────────────────────────────────────────────────────────────────

describe('generateArchive', () => {
  it('produces valid JSON', () => {
    const json = generateArchive(null, [], [])
    expect(() => JSON.parse(json)).not.toThrow()
  })

  it('includes version and exportedAt', () => {
    const archive = JSON.parse(generateArchive(null, [], []))
    expect(archive.version).toBe('1')
    expect(typeof archive.exportedAt).toBe('number')
  })

  it('includes identity when provided', () => {
    const identity = { npub: 'npub1alice', displayName: 'Alice' }
    const archive = JSON.parse(generateArchive(identity, [], []))
    expect(archive.identity?.npub).toBe('npub1alice')
    expect(archive.identity?.displayName).toBe('Alice')
  })

  it('includes persons with their claims', () => {
    const claim = makeClaim({})
    const persons: ExportablePerson[] = [{ person: thomas, claims: [claim] }]
    const archive = JSON.parse(generateArchive(null, persons, []))
    expect(archive.persons).toHaveLength(1)
    expect(archive.persons[0].person.displayName).toBe("Thomas O'Brien")
    expect(archive.persons[0].claims).toHaveLength(1)
  })

  it('includes retracted claims (full history preserved)', () => {
    const retracted = makeClaim({ retracted: true })
    const archive = JSON.parse(generateArchive(null, [{ person: thomas, claims: [retracted] }], []))
    expect(archive.persons[0].claims[0].retracted).toBe(true)
  })

  it('includes recovery contacts', () => {
    const contacts = [{ pubkey: 'npub1r', displayName: 'Bob', addedAt: 1000 }]
    const archive = JSON.parse(generateArchive(null, [], contacts))
    expect(archive.recoveryContacts).toHaveLength(1)
    expect(archive.recoveryContacts[0].displayName).toBe('Bob')
  })

  it('identity is null when not provided', () => {
    const archive = JSON.parse(generateArchive(null, [], []))
    expect(archive.identity).toBeNull()
  })
})
