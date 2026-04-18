/**
 * Chronicle Export Utilities
 *
 * Two formats:
 *  1. GEDCOM 5.5.1 — standard genealogy interchange format
 *  2. Chronicle Archive — full JSON dump of all local state (portable backup)
 *
 * Both are pure functions that take store data as arguments; no side effects.
 * The actual file download is triggered by the UI layer.
 */

import type { Person, FactClaim } from '../types/chronicle'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExportablePerson {
  person: Person
  claims: FactClaim[]
}

export interface ArchiveExport {
  version: '1'
  exportedAt: number
  identity: {
    npub: string
    displayName: string
  } | null
  persons: ExportablePerson[]
  recoveryContacts: Array<{ pubkey: string; displayName: string; addedAt: number }>
}

// ─── GEDCOM ───────────────────────────────────────────────────────────────────

/**
 * Generates a GEDCOM 5.5.1 string from a list of persons + their claims.
 *
 * Rules applied:
 * - Each person gets an INDI record; the pubkey is the cross-reference ID
 * - Highest-confidence non-retracted claim wins for each fact field
 * - GEDCOM IDs are sanitised (bech32 chars are safe, but we trim to 20 chars)
 * - No NOTE or SOUR records generated at Stage 1 — evidence text is dropped
 */
export function generateGedcom(persons: ExportablePerson[]): string {
  const lines: string[] = []

  // Header
  lines.push('0 HEAD')
  lines.push('1 SOUR CHRONICLE')
  lines.push('2 VERS 1.0')
  lines.push('2 NAME Chronicle')
  lines.push('1 GEDC')
  lines.push('2 VERS 5.5.1')
  lines.push('2 FORM LINEAGE-LINKED')
  lines.push('1 CHAR UTF-8')
  lines.push(`1 DATE ${gedcomDate(Date.now())}`)

  for (const { person, claims } of persons) {
    const id = gedcomId(person.pubkey)
    const activeClaims = claims.filter((c) => !c.retracted)
    const best = bestClaims(activeClaims)

    lines.push(`0 @${id}@ INDI`)

    const name = best.get('name')?.value ?? person.displayName
    lines.push(`1 NAME ${name}`)

    const born = best.get('born')?.value
    const birthplace = best.get('birthplace')?.value
    if (born || birthplace) {
      lines.push('1 BIRT')
      if (born) lines.push(`2 DATE ${born}`)
      if (birthplace) lines.push(`2 PLAC ${birthplace}`)
    }

    const died = best.get('died')?.value
    const deathplace = best.get('deathplace')?.value
    if (died || deathplace) {
      lines.push('1 DEAT')
      if (died) lines.push(`2 DATE ${died}`)
      if (deathplace) lines.push(`2 PLAC ${deathplace}`)
    }

    const occupation = best.get('occupation')?.value
    if (occupation) lines.push(`1 OCCU ${occupation}`)

    const bio = best.get('bio')?.value
    if (bio) {
      // GEDCOM NOTE can be multi-line; keep it simple
      lines.push(`1 NOTE ${bio.replace(/\n/g, ' ')}`)
    }
  }

  lines.push('0 TRLR')
  return lines.join('\n')
}

// ─── Chronicle Archive ────────────────────────────────────────────────────────

/**
 * Generates a Chronicle Archive JSON string.
 * This is the canonical backup format — includes all claims (including
 * retracted ones) so history is preserved. Encrypted nsec is NOT included
 * (the user's key backup is their mnemonic, not the encrypted blob).
 */
export function generateArchive(
  identity: ArchiveExport['identity'],
  persons: ExportablePerson[],
  recoveryContacts: ArchiveExport['recoveryContacts'],
): string {
  const archive: ArchiveExport = {
    version: '1',
    exportedAt: Math.floor(Date.now() / 1000),
    identity,
    persons,
    recoveryContacts,
  }
  return JSON.stringify(archive, null, 2)
}

/**
 * Triggers a browser file download of the given content.
 */
export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the last 20 non-space chars of a pubkey as a GEDCOM cross-ref id */
function gedcomId(npub: string): string {
  return npub.replace(/[^a-zA-Z0-9]/g, '').slice(-20).toUpperCase()
}

/** GEDCOM date format: DD MMM YYYY */
function gedcomDate(ms: number): string {
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
  const d = new Date(ms)
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`
}

/** Picks the highest-confidence claim for each field */
function bestClaims(claims: FactClaim[]): Map<string, FactClaim> {
  const map = new Map<string, FactClaim>()
  for (const claim of claims) {
    const existing = map.get(claim.field)
    if (!existing || claim.confidenceScore > existing.confidenceScore) {
      map.set(claim.field, claim)
    }
  }
  return map
}
