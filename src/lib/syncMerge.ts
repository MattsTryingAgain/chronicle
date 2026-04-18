/**
 * syncMerge.ts
 *
 * Peer-online sync prompt and selective merge queue.
 *
 * When a peer comes online, Chronicle detects new events and presents
 * a dismissible banner. The user can review incoming changes and
 * selectively accept or skip individual items. No automatic merging.
 */

import type { ChronicleEvent } from '../types/chronicle.js'

export type MergeItemStatus = 'pending' | 'accepted' | 'skipped'
export type MergeItemCategory = 'fact_claim' | 'endorsement' | 'relationship' | 'same_person' | 'retraction' | 'other'

export interface MergeItem {
  id: string                    // event id
  event: ChronicleEvent
  category: MergeItemCategory
  peerNpub: string              // who sent it
  receivedAt: number            // ms timestamp
  status: MergeItemStatus
  /** Human-readable summary for the UI banner */
  summary: string
}

export interface SyncSession {
  peerNpub: string
  startedAt: number
  items: MergeItem[]
  dismissed: boolean
}

// ---------------------------------------------------------------------------
// Category detection
// ---------------------------------------------------------------------------

const KIND_CATEGORIES: Record<number, MergeItemCategory> = {
  30081: 'fact_claim',
  30082: 'endorsement',
  30079: 'relationship',
  30083: 'same_person',
  30089: 'retraction',
}

export function categoriseEvent(event: ChronicleEvent): MergeItemCategory {
  return KIND_CATEGORIES[event.kind] ?? 'other'
}

/**
 * Build a human-readable summary line for a merge item.
 * This is intentionally simple — the UI adds proper i18n.
 */
export function summariseEvent(event: ChronicleEvent): string {
  const cat = categoriseEvent(event)
  const field   = event.tags.find(t => t[0] === 'field')?.[1]
  const value   = event.tags.find(t => t[0] === 'value')?.[1]

  switch (cat) {
    case 'fact_claim':
      return field && value
        ? `Claim: ${field} = ${value}`
        : 'New fact claim'
    case 'endorsement':
      return 'Endorsement of a claim'
    case 'relationship':
      return 'Relationship claim'
    case 'same_person':
      return 'Same-person link'
    case 'retraction':
      return 'Claim retraction'
    default:
      return `Event kind ${event.kind}`
  }
}

// ---------------------------------------------------------------------------
// MergeQueue — collects incoming events per peer session
// ---------------------------------------------------------------------------

export class MergeQueue {
  private sessions: Map<string, SyncSession> = new Map()

  /** Start or resume a sync session for a peer */
  startSession(peerNpub: string): SyncSession {
    if (!this.sessions.has(peerNpub)) {
      this.sessions.set(peerNpub, {
        peerNpub,
        startedAt: Date.now(),
        items: [],
        dismissed: false,
      })
    }
    return this.sessions.get(peerNpub)!
  }

  /** Add an incoming event to a peer's session */
  addEvent(peerNpub: string, event: ChronicleEvent): MergeItem {
    const session = this.startSession(peerNpub)
    const item: MergeItem = {
      id: event.id,
      event,
      category: categoriseEvent(event),
      peerNpub,
      receivedAt: Date.now(),
      status: 'pending',
      summary: summariseEvent(event),
    }
    // Deduplicate by event id
    if (!session.items.find(i => i.id === event.id)) {
      session.items.push(item)
    }
    return item
  }

  getSession(peerNpub: string): SyncSession | undefined {
    return this.sessions.get(peerNpub)
  }

  getAllSessions(): SyncSession[] {
    return Array.from(this.sessions.values())
  }

  /** All sessions with pending items (drives the banner) */
  getActiveSessions(): SyncSession[] {
    return this.getAllSessions().filter(
      s => !s.dismissed && s.items.some(i => i.status === 'pending')
    )
  }

  getPendingItems(peerNpub: string): MergeItem[] {
    return this.sessions.get(peerNpub)?.items.filter(i => i.status === 'pending') ?? []
  }

  acceptItem(peerNpub: string, eventId: string): void {
    const item = this.sessions.get(peerNpub)?.items.find(i => i.id === eventId)
    if (item) item.status = 'accepted'
  }

  skipItem(peerNpub: string, eventId: string): void {
    const item = this.sessions.get(peerNpub)?.items.find(i => i.id === eventId)
    if (item) item.status = 'skipped'
  }

  acceptAll(peerNpub: string): void {
    this.sessions.get(peerNpub)?.items
      .filter(i => i.status === 'pending')
      .forEach(i => { i.status = 'accepted' })
  }

  skipAll(peerNpub: string): void {
    this.sessions.get(peerNpub)?.items
      .filter(i => i.status === 'pending')
      .forEach(i => { i.status = 'skipped' })
  }

  dismiss(peerNpub: string): void {
    const session = this.sessions.get(peerNpub)
    if (session) session.dismissed = true
  }

  clearSession(peerNpub: string): void {
    this.sessions.delete(peerNpub)
  }

  totalPending(): number {
    let count = 0
    for (const s of this.sessions.values()) {
      count += s.items.filter(i => i.status === 'pending').length
    }
    return count
  }
}
