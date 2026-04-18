/**
 * Tests for GEDCOM importer
 */

import { describe, it, expect } from 'vitest'
import { importGedcom, normaliseDate } from './gedcomImport'

const CLAIMANT = 'npub1claimant'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MINIMAL_GEDCOM = `
0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Thomas /O'Brien/
1 BIRT
2 DATE 15 MAR 1930
2 PLAC Cork, Ireland
1 DEAT
2 DATE 1995
2 PLAC Dublin, Ireland
1 OCCU Farmer
0 TRLR
`.trim()

const TWO_PERSON_GEDCOM = `
0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Alice /Smith/
1 BIRT
2 DATE 1950
0 @I2@ INDI
1 NAME Bob /Jones/
1 BIRT
2 DATE ABT 1920
0 @F1@ FAM
1 HUSB @I2@
1 WIFE @I1@
0 TRLR
`.trim()

const NO_NAME_GEDCOM = `
0 HEAD
0 @I1@ INDI
1 BIRT
2 DATE 1900
0 TRLR
`.trim()

// ─── normaliseDate ────────────────────────────────────────────────────────────

describe('normaliseDate', () => {
  it('extracts year from full date', () => {
    expect(normaliseDate('15 MAR 1930')).toBe('1930')
  })

  it('handles year-only input', () => {
    expect(normaliseDate('1930')).toBe('1930')
  })

  it('converts ABT to c.', () => {
    expect(normaliseDate('ABT 1930')).toBe('c. 1930')
  })

  it('converts BEF', () => {
    expect(normaliseDate('BEF 1930')).toBe('before 1930')
  })

  it('converts AFT', () => {
    expect(normaliseDate('AFT 1930')).toBe('after 1930')
  })

  it('converts BET...AND range', () => {
    expect(normaliseDate('BET 1925 AND 1935')).toBe('1925–1935')
  })

  it('handles lowercase input', () => {
    expect(normaliseDate('abt 1900')).toBe('c. 1900')
  })
})

// ─── importGedcom ─────────────────────────────────────────────────────────────

describe('importGedcom — basic parsing', () => {
  it('parses a single INDI record', () => {
    const result = importGedcom(MINIMAL_GEDCOM, CLAIMANT)
    expect(result.indiCount).toBe(1)
    expect(result.persons).toHaveLength(1)
  })

  it('sets displayName from NAME tag (strips slashes)', () => {
    const result = importGedcom(MINIMAL_GEDCOM, CLAIMANT)
    expect(result.persons[0].person.displayName).toBe("Thomas O'Brien")
  })

  it('creates a name claim', () => {
    const result = importGedcom(MINIMAL_GEDCOM, CLAIMANT)
    const nameClaim = result.persons[0].claims.find(c => c.field === 'name')
    expect(nameClaim?.value).toBe("Thomas O'Brien")
  })

  it('creates born and birthplace claims', () => {
    const result = importGedcom(MINIMAL_GEDCOM, CLAIMANT)
    const claims = result.persons[0].claims
    expect(claims.find(c => c.field === 'born')?.value).toBe('1930')
    expect(claims.find(c => c.field === 'birthplace')?.value).toBe('Cork, Ireland')
  })

  it('creates died and deathplace claims', () => {
    const result = importGedcom(MINIMAL_GEDCOM, CLAIMANT)
    const claims = result.persons[0].claims
    expect(claims.find(c => c.field === 'died')?.value).toBe('1995')
    expect(claims.find(c => c.field === 'deathplace')?.value).toBe('Dublin, Ireland')
  })

  it('creates occupation claim', () => {
    const result = importGedcom(MINIMAL_GEDCOM, CLAIMANT)
    expect(result.persons[0].claims.find(c => c.field === 'occupation')?.value).toBe('Farmer')
  })

  it('sets claimantPubkey on all claims', () => {
    const result = importGedcom(MINIMAL_GEDCOM, CLAIMANT)
    for (const claim of result.persons[0].claims) {
      expect(claim.claimantPubkey).toBe(CLAIMANT)
    }
  })

  it('generates a unique npub for each person', () => {
    const result = importGedcom(TWO_PERSON_GEDCOM, CLAIMANT)
    const p1 = result.persons[0].person.pubkey
    const p2 = result.persons[1].person.pubkey
    expect(p1).not.toBe(p2)
    expect(p1).toMatch(/^npub1/)
    expect(p2).toMatch(/^npub1/)
  })

  it('parses two INDI records', () => {
    const result = importGedcom(TWO_PERSON_GEDCOM, CLAIMANT)
    expect(result.indiCount).toBe(2)
  })

  it('counts FAM records and adds a warning', () => {
    const result = importGedcom(TWO_PERSON_GEDCOM, CLAIMANT)
    expect(result.famCount).toBe(1)
    expect(result.warnings.some(w => w.includes('FAM'))).toBe(true)
  })

  it('handles approximate birth dates', () => {
    const result = importGedcom(TWO_PERSON_GEDCOM, CLAIMANT)
    const bob = result.persons.find(p => p.person.displayName === 'Bob Jones')
    expect(bob?.claims.find(c => c.field === 'born')?.value).toBe('c. 1920')
  })

  it('preserves gedcomId', () => {
    const result = importGedcom(MINIMAL_GEDCOM, CLAIMANT)
    expect(result.persons[0].gedcomId).toBe('I1')
  })
})

describe('importGedcom — edge cases', () => {
  it('falls back to gedcomId as displayName when no NAME tag', () => {
    const result = importGedcom(NO_NAME_GEDCOM, CLAIMANT)
    expect(result.persons[0].person.displayName).toBe('I1')
  })

  it('returns empty result for empty GEDCOM', () => {
    const result = importGedcom('0 HEAD\n0 TRLR', CLAIMANT)
    expect(result.indiCount).toBe(0)
    expect(result.persons).toHaveLength(0)
  })

  it('skips blank lines without warning', () => {
    const result = importGedcom('\n\n' + MINIMAL_GEDCOM + '\n\n', CLAIMANT)
    expect(result.warnings.filter(w => w.includes('Skipped'))).toHaveLength(0)
  })

  it('adds warning for unparseable lines', () => {
    const bad = MINIMAL_GEDCOM + '\nthis is not a gedcom line'
    const result = importGedcom(bad, CLAIMANT)
    expect(result.warnings.some(w => w.includes('Skipped'))).toBe(true)
  })

  it('all returned claims have retracted=false', () => {
    const result = importGedcom(MINIMAL_GEDCOM, CLAIMANT)
    for (const claim of result.persons[0].claims) {
      expect(claim.retracted).toBe(false)
    }
  })

  it('handles CRLF line endings', () => {
    const crlf = MINIMAL_GEDCOM.replace(/\n/g, '\r\n')
    const result = importGedcom(crlf, CLAIMANT)
    expect(result.indiCount).toBe(1)
  })
})
