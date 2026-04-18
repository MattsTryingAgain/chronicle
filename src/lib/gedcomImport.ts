/**
 * Chronicle GEDCOM Importer
 *
 * Parses GEDCOM 5.5.1 files and converts INDI records into Chronicle
 * Person + FactClaim objects. Does not touch the relay or the store —
 * callers decide what to do with the output.
 *
 * Scope (Stage 2):
 * - INDI records → Person + FactClaim for name, born, died, birthplace, deathplace, occupation
 * - FAM records are parsed but relationship claims are deferred to Stage 3
 * - Unrecognised tags are silently skipped (forward compatibility)
 * - Encoding: assumes UTF-8 (GEDCOM 5.5.1 allows ASCII/ANSEL; UTF-8 is the
 *   modern standard and what Chronicle exports)
 */

import type { Person, FactClaim, FactField } from '../types/chronicle'
import { generateAncestorKeyPair } from './keys'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ImportedPerson {
  gedcomId: string   // the @I1@ cross-reference id from the file
  person: Person
  claims: FactClaim[]
}

export interface GedcomImportResult {
  persons: ImportedPerson[]
  /** Non-fatal warnings (e.g. unrecognised encodings, skipped records) */
  warnings: string[]
  /** Number of INDI records found in the file */
  indiCount: number
  /** Number of FAM records found (not yet imported — Stage 3) */
  famCount: number
}

// ─── GEDCOM line ──────────────────────────────────────────────────────────────

interface GedLine {
  level: number
  id: string | null      // cross-reference, e.g. @I1@
  tag: string
  value: string
}

function parseLine(line: string): GedLine | null {
  // GEDCOM format: LEVEL [XREF] TAG [VALUE]
  const match = line.trim().match(/^(\d+)\s+(@[^@]+@\s+)?(\S+)(.*)$/)
  if (!match) return null
  return {
    level: parseInt(match[1], 10),
    id: match[2]?.trim().replace(/@/g, '') ?? null,
    tag: match[3].toUpperCase(),
    value: match[4]?.trim() ?? '',
  }
}

// ─── Record grouper ───────────────────────────────────────────────────────────

interface GedRecord {
  id: string | null
  tag: string
  value: string
  children: GedRecord[]
}

function groupRecords(lines: GedLine[]): GedRecord[] {
  const roots: GedRecord[] = []
  const stack: GedRecord[] = []

  for (const line of lines) {
    const record: GedRecord = { id: line.id, tag: line.tag, value: line.value, children: [] }

    if (line.level === 0) {
      roots.push(record)
      stack.length = 0
      stack.push(record)
    } else {
      // Pop back to the right parent level
      while (stack.length > line.level) stack.pop()
      const parent = stack[stack.length - 1]
      if (parent) parent.children.push(record)
      stack.push(record)
    }
  }

  return roots
}

// ─── INDI parser ──────────────────────────────────────────────────────────────

function parseIndi(record: GedRecord, claimantNpub: string): ImportedPerson {
  const kp = generateAncestorKeyPair()
  const now = Math.floor(Date.now() / 1000)
  let claimIdx = 0

  function nextId(field: string): string {
    return `gedcom-import-${kp.npub}-${field}-${claimIdx++}`
  }

  const person: Person = {
    pubkey: kp.npub,
    displayName: '',
    isLiving: false,
    createdAt: now,
  }

  const claims: FactClaim[] = []

  function addClaim(field: FactField, value: string, evidence?: string): void {
    if (!value.trim()) return
    claims.push({
      eventId: nextId(field),
      claimantPubkey: claimantNpub,
      subjectPubkey: kp.npub,
      field,
      value: value.trim(),
      evidence,
      createdAt: now,
      retracted: false,
      confidenceScore: evidence ? 1.5 : 1.0,
    })
  }

  for (const child of record.children) {
    switch (child.tag) {
      case 'NAME': {
        // GEDCOM name format: "Given /Surname/"
        const raw = child.value.replace(/\//g, '').replace(/\s+/g, ' ').trim()
        if (raw) {
          person.displayName = raw
          addClaim('name', raw)
        }
        break
      }

      case 'BIRT': {
        const date = child.children.find(c => c.tag === 'DATE')?.value
        const plac = child.children.find(c => c.tag === 'PLAC')?.value
        if (date) addClaim('born', normaliseDate(date))
        if (plac) addClaim('birthplace', plac)
        break
      }

      case 'DEAT': {
        const date = child.children.find(c => c.tag === 'DATE')?.value
        const plac = child.children.find(c => c.tag === 'PLAC')?.value
        if (date) addClaim('died', normaliseDate(date))
        if (plac) addClaim('deathplace', plac)
        break
      }

      case 'OCCU': {
        if (child.value) addClaim('occupation', child.value)
        break
      }

      case 'NOTE': {
        if (child.value) addClaim('bio', child.value)
        break
      }

      case 'SEX': {
        // Not a FactField in Stage 2 — skip
        break
      }

      // All other tags silently skipped
    }
  }

  // Fall back to gedcom ID as display name if no NAME tag
  if (!person.displayName) {
    person.displayName = record.id ?? 'Unknown'
  }

  return {
    gedcomId: record.id ?? '',
    person,
    claims,
  }
}

// ─── Date normaliser ──────────────────────────────────────────────────────────

/**
 * Converts GEDCOM date formats to a simple string Chronicle can store.
 * "15 MAR 1930" → "1930" (year only, which is what Chronicle displays)
 * "ABT 1930"    → "c. 1930"
 * "BEF 1930"    → "before 1930"
 * "AFT 1930"    → "after 1930"
 * Other formats passed through as-is.
 */
export function normaliseDate(gedDate: string): string {
  const s = gedDate.trim().toUpperCase()

  const approx = s.match(/^ABT\s+(.+)/)
  if (approx) return `c. ${extractYear(approx[1])}`

  const before = s.match(/^BEF\s+(.+)/)
  if (before) return `before ${extractYear(before[1])}`

  const after = s.match(/^AFT\s+(.+)/)
  if (after) return `after ${extractYear(after[1])}`

  const between = s.match(/^BET\s+(.+?)\s+AND\s+(.+)/)
  if (between) return `${extractYear(between[1])}–${extractYear(between[2])}`

  return extractYear(s) || gedDate.trim()
}

function extractYear(s: string): string {
  const match = s.match(/\b(\d{3,4})\b/)
  return match ? match[1] : s.trim()
}

// ─── Main import function ─────────────────────────────────────────────────────

/**
 * Parse a GEDCOM 5.5.1 string and return imported persons.
 *
 * @param gedcomText - Full text content of the .ged file
 * @param claimantNpub - The importing user's npub; used as claimantPubkey on all claims
 */
export function importGedcom(gedcomText: string, claimantNpub: string): GedcomImportResult {
  const warnings: string[] = []
  const lines: GedLine[] = []

  for (const raw of gedcomText.split(/\r?\n/)) {
    if (!raw.trim()) continue
    const parsed = parseLine(raw)
    if (!parsed) {
      warnings.push(`Skipped unparseable line: ${raw.slice(0, 60)}`)
      continue
    }
    lines.push(parsed)
  }

  const records = groupRecords(lines)

  const persons: ImportedPerson[] = []
  let famCount = 0

  for (const record of records) {
    if (record.tag === 'INDI') {
      try {
        persons.push(parseIndi(record, claimantNpub))
      } catch (e) {
        warnings.push(`Failed to parse INDI record ${record.id ?? '?'}: ${String(e)}`)
      }
    } else if (record.tag === 'FAM') {
      famCount++
    }
    // HEAD, TRLR, SUBM, SOUR etc. — silently skipped
  }

  if (famCount > 0) {
    warnings.push(
      `${famCount} FAM record(s) found. Family relationships will be importable in a future version.`,
    )
  }

  return { persons, warnings, indiCount: persons.length, famCount }
}
