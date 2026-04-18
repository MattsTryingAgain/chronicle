/**
 * Chronicle Schema Version Checker — Stage 6
 *
 * Handles the "A newer version of Chronicle is available" prompt.
 *
 * When a client encounters an event with a schema version higher than its own,
 * it surfaces a soft prompt rather than failing silently.
 *
 * Design:
 *  - Every Chronicle event has a `["v", "<version>"]` tag (SCHEMA_VERSION = '1')
 *  - If we see a v-tag with a higher integer than our own, we record the highest
 *    seen version and expose a `hasNewerVersion` flag to the UI
 *  - The prompt is dismissible per session
 */

import { SCHEMA_VERSION } from '../types/chronicle'
import type { ChronicleEvent } from '../types/chronicle'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SchemaVersionState {
  currentVersion: number
  highestSeenVersion: number
  hasNewerVersion: boolean
  dismissed: boolean
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class SchemaVersionChecker {
  private _current: number
  private _highestSeen: number
  private _dismissed = false

  constructor(currentVersion: string = SCHEMA_VERSION) {
    this._current = parseInt(currentVersion, 10)
    this._highestSeen = this._current
  }

  /**
   * Inspect a Chronicle event for its v-tag.
   * If the version is higher than seen before, record it.
   * Returns true if a newer version was detected.
   */
  ingestEvent(event: ChronicleEvent): boolean {
    const vTag = event.tags.find(t => t[0] === 'v')
    if (!vTag) return false
    const version = parseInt(vTag[1], 10)
    if (isNaN(version)) return false

    if (version > this._highestSeen) {
      this._highestSeen = version
      this._dismissed = false   // reset dismissal when a newer version is seen
      return true
    }
    return false
  }

  get currentVersion(): number {
    return this._current
  }

  get highestSeenVersion(): number {
    return this._highestSeen
  }

  get hasNewerVersion(): boolean {
    return this._highestSeen > this._current
  }

  get dismissed(): boolean {
    return this._dismissed
  }

  /** User dismissed the "new version" prompt for this session. */
  dismiss(): void {
    this._dismissed = true
  }

  /** Whether to show the prompt (newer version seen AND not dismissed). */
  get shouldShowPrompt(): boolean {
    return this.hasNewerVersion && !this._dismissed
  }

  getState(): SchemaVersionState {
    return {
      currentVersion: this._current,
      highestSeenVersion: this._highestSeen,
      hasNewerVersion: this.hasNewerVersion,
      dismissed: this._dismissed,
    }
  }

  _reset(): void {
    this._highestSeen = this._current
    this._dismissed = false
  }
}

export const schemaVersionChecker = new SchemaVersionChecker()

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the schema version integer from a Chronicle event's v-tag.
 * Returns null if the tag is absent or unparseable.
 */
export function getEventSchemaVersion(event: ChronicleEvent): number | null {
  const vTag = event.tags.find(t => t[0] === 'v')
  if (!vTag) return null
  const v = parseInt(vTag[1], 10)
  return isNaN(v) ? null : v
}

/**
 * Check whether an event comes from a schema version this client understands.
 */
export function isKnownSchemaVersion(event: ChronicleEvent): boolean {
  const v = getEventSchemaVersion(event)
  if (v === null) return true  // no v-tag = treat as compatible (old client)
  return v <= parseInt(SCHEMA_VERSION, 10)
}
