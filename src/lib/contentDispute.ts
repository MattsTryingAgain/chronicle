/**
 * Chronicle Content Dispute Module — Stage 6
 *
 * Manages kind 30087 dispute events.
 *
 * Design:
 *  - Any connected user can dispute any event (fact claim, media ref, etc.)
 *  - Disputes are permanently recorded — they flag but do not delete the target
 *  - Client-side setting can hide disputed content by default
 *  - DisputeStore tracks disputes in memory; the raw events are also persisted
 *    via the standard rawEvents store
 */

import { buildContentDispute } from './eventBuilder'
import { hexToNpub } from './keys'
import type { ChronicleEvent } from '../types/chronicle'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ContentDispute {
  eventId: string            // id of the kind 30087 event
  disputedEventId: string    // id of the event being disputed
  disputerNpub: string       // who raised the dispute
  reason: string
  createdAt: number
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class DisputeStore {
  /** disputeEventId → ContentDispute */
  private disputes = new Map<string, ContentDispute>()
  /** disputedEventId → Set<disputeEventId> */
  private byTarget = new Map<string, Set<string>>()
  /** client-side preference: hide disputed content by default */
  private _hideDisputed = false

  // ── Ingestion ───────────────────────────────────────────────────────────────

  ingestDisputeEvent(event: ChronicleEvent): ContentDispute | null {
    if (event.kind !== 30087) return null
    const disputedEventId = event.tags.find(t => t[0] === 'disputed_event')?.[1]
    const reason = event.tags.find(t => t[0] === 'reason')?.[1] ?? ''
    if (!disputedEventId) return null

    const dispute: ContentDispute = {
      eventId: event.id,
      disputedEventId,
      disputerNpub: event.pubkey.startsWith('npub') ? event.pubkey : hexToNpub(event.pubkey),
      reason,
      createdAt: event.created_at,
    }

    this.disputes.set(event.id, dispute)
    if (!this.byTarget.has(disputedEventId)) {
      this.byTarget.set(disputedEventId, new Set())
    }
    this.byTarget.get(disputedEventId)!.add(event.id)

    return dispute
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  getDisputesForEvent(targetEventId: string): ContentDispute[] {
    const ids = this.byTarget.get(targetEventId)
    if (!ids) return []
    return [...ids]
      .map(id => this.disputes.get(id))
      .filter((d): d is ContentDispute => d !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  isDisputed(targetEventId: string): boolean {
    const ids = this.byTarget.get(targetEventId)
    return ids !== undefined && ids.size > 0
  }

  getAllDisputes(): ContentDispute[] {
    return [...this.disputes.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  getDispute(eventId: string): ContentDispute | undefined {
    return this.disputes.get(eventId)
  }

  disputeCount(targetEventId: string): number {
    return this.byTarget.get(targetEventId)?.size ?? 0
  }

  // ── Client-side hide preference ─────────────────────────────────────────────

  get hideDisputed(): boolean {
    return this._hideDisputed
  }

  setHideDisputed(value: boolean): void {
    this._hideDisputed = value
  }

  // ── Test helpers ────────────────────────────────────────────────────────────

  _reset(): void {
    this.disputes.clear()
    this.byTarget.clear()
    this._hideDisputed = false
  }

  get size(): number {
    return this.disputes.size
  }
}

export const disputeStore = new DisputeStore()

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build and ingest a new dispute event in one step.
 * Returns the signed ChronicleEvent (caller should persist/broadcast it).
 */
export function raiseDispute(params: {
  disputerNpub: string
  disputerNsec: string
  targetEventId: string
  reason: string
  store?: DisputeStore
}): ChronicleEvent {
  const s = params.store ?? disputeStore
  const event = buildContentDispute(
    params.disputerNpub,
    params.disputerNsec,
    params.targetEventId,
    params.reason,
  )
  s.ingestDisputeEvent(event)
  return event
}
