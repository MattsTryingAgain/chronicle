/**
 * Schema version checker tests — Stage 6
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  SchemaVersionChecker,
  getEventSchemaVersion,
  isKnownSchemaVersion,
} from './schemaVersion'
import type { ChronicleEvent } from '../types/chronicle'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(vTag: string | null, kind = 30081): ChronicleEvent {
  return {
    id: 'e1',
    pubkey: 'npub1test',
    created_at: 1000,
    kind: kind as any,
    tags: vTag !== null ? [['v', vTag]] : [],
    content: '',
    sig: '',
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SchemaVersionChecker', () => {
  let checker: SchemaVersionChecker

  beforeEach(() => {
    checker = new SchemaVersionChecker('1')
  })

  it('starts with no newer version detected', () => {
    expect(checker.hasNewerVersion).toBe(false)
    expect(checker.shouldShowPrompt).toBe(false)
  })

  it('does not flag same-version events', () => {
    checker.ingestEvent(makeEvent('1'))
    expect(checker.hasNewerVersion).toBe(false)
  })

  it('does not flag older-version events', () => {
    checker.ingestEvent(makeEvent('0'))
    expect(checker.hasNewerVersion).toBe(false)
  })

  it('detects a newer version event', () => {
    const result = checker.ingestEvent(makeEvent('2'))
    expect(result).toBe(true)
    expect(checker.hasNewerVersion).toBe(true)
    expect(checker.highestSeenVersion).toBe(2)
  })

  it('shouldShowPrompt is true after newer version seen', () => {
    checker.ingestEvent(makeEvent('2'))
    expect(checker.shouldShowPrompt).toBe(true)
  })

  it('dismiss hides the prompt', () => {
    checker.ingestEvent(makeEvent('2'))
    checker.dismiss()
    expect(checker.dismissed).toBe(true)
    expect(checker.shouldShowPrompt).toBe(false)
  })

  it('a further newer version resets dismissal', () => {
    checker.ingestEvent(makeEvent('2'))
    checker.dismiss()
    checker.ingestEvent(makeEvent('3'))
    expect(checker.dismissed).toBe(false)
    expect(checker.shouldShowPrompt).toBe(true)
    expect(checker.highestSeenVersion).toBe(3)
  })

  it('ignores events with no v-tag', () => {
    checker.ingestEvent(makeEvent(null))
    expect(checker.hasNewerVersion).toBe(false)
  })

  it('ignores events with unparseable v-tag', () => {
    checker.ingestEvent(makeEvent('banana'))
    expect(checker.hasNewerVersion).toBe(false)
  })

  it('returns false from ingestEvent if no upgrade detected', () => {
    expect(checker.ingestEvent(makeEvent('1'))).toBe(false)
  })

  it('getState returns complete snapshot', () => {
    checker.ingestEvent(makeEvent('2'))
    checker.dismiss()
    const state = checker.getState()
    expect(state.currentVersion).toBe(1)
    expect(state.highestSeenVersion).toBe(2)
    expect(state.hasNewerVersion).toBe(true)
    expect(state.dismissed).toBe(true)
  })

  it('_reset restores to initial state', () => {
    checker.ingestEvent(makeEvent('2'))
    checker.dismiss()
    checker._reset()
    expect(checker.hasNewerVersion).toBe(false)
    expect(checker.dismissed).toBe(false)
  })
})

// ─── getEventSchemaVersion ────────────────────────────────────────────────────

describe('getEventSchemaVersion', () => {
  it('returns null when no v-tag', () => {
    expect(getEventSchemaVersion(makeEvent(null))).toBeNull()
  })

  it('returns the version number', () => {
    expect(getEventSchemaVersion(makeEvent('1'))).toBe(1)
  })

  it('returns null for unparseable tag', () => {
    expect(getEventSchemaVersion(makeEvent('x'))).toBeNull()
  })
})

// ─── isKnownSchemaVersion ─────────────────────────────────────────────────────

describe('isKnownSchemaVersion', () => {
  it('returns true for events with current version', () => {
    expect(isKnownSchemaVersion(makeEvent('1'))).toBe(true)
  })

  it('returns true for events with no v-tag (old client compat)', () => {
    expect(isKnownSchemaVersion(makeEvent(null))).toBe(true)
  })

  it('returns true for events with older version', () => {
    expect(isKnownSchemaVersion(makeEvent('0'))).toBe(true)
  })

  it('returns false for events from a newer schema version', () => {
    expect(isKnownSchemaVersion(makeEvent('99'))).toBe(false)
  })
})
