/**
 * PossibleMatchesPanel
 *
 * Surfaces pairs of persons that are likely the same real individual — added
 * independently by different users (or in different app instances) with
 * different pubkeys.
 *
 * Appears in the Connect tab. Also re-triggers automatically whenever
 * relaySync detects a new potential duplicate during event ingestion.
 *
 * Confirming a match publishes a kind-30083 same_person_link event, which
 * causes both the People list and the Family Tree to collapse the two entries
 * into one. Dismissing records the decision so the pair is not re-suggested.
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { store } from '../lib/storage'
import { getAllSamePersonLinks, addSamePersonLink } from '../lib/graph'
import { findMatchCandidates, alreadyLinked } from '../lib/treeLinking'
import { buildSamePersonLink } from '../lib/eventBuilder'
import { useApp } from '../context/AppContext'
import { storageGet, storageSet } from '../lib/appStorage'
import type { MatchCandidate } from '../lib/treeLinking'
import type { SamePersonLink } from '../lib/graph'

// ─── Dismissed pairs (persisted via Electron IPC storage) ─────────────────────

const DISMISSED_KEY = 'chronicle:dismissed-matches'

async function loadDismissed(): Promise<Set<string>> {
  try {
    const raw = await storageGet(DISMISSED_KEY)
    if (raw) return new Set(JSON.parse(raw))
  } catch {}
  return new Set()
}

async function saveDismissed(set: Set<string>): Promise<void> {
  try { await storageSet(DISMISSED_KEY, JSON.stringify([...set])) } catch {}
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|')
}

// ─── Matching logic ───────────────────────────────────────────────────────────

/**
 * Re-scans the full person store for duplicate candidates.
 *
 * We compare EVERY pair — not just mine-vs-theirs — because in the two-instance
 * scenario both persons end up in the same local store. The mine/theirs split
 * only works when there's a clean claimant boundary, which breaks when one
 * instance has synced all data locally.
 */
function computeCandidates(dismissed: Set<string>): MatchCandidate[] {
  const allPersons = store.getAllPersons()
  if (allPersons.length < 2) return []

  const allClaims   = store.getAllClaims()
  const existingLinks = getAllSamePersonLinks()
  const pubkeys = allPersons.map(p => p.pubkey)

  // findMatchCandidates compares setA × setB; passing the same set for both
  // gives us all cross-pair comparisons (same-pubkey pairs are skipped inside).
  const raw = findMatchCandidates(pubkeys, pubkeys, allClaims, { minConfidence: 0.3 })

  const seen = new Set<string>()
  return raw.filter(c => {
    if (c.pubkeyA === c.pubkeyB) return false
    const key = pairKey(c.pubkeyA, c.pubkeyB)
    if (seen.has(key)) return false
    seen.add(key)
    if (alreadyLinked(c.pubkeyA, c.pubkeyB, existingLinks)) return false
    if (dismissed.has(key)) return false
    return true
  })
}

// ─── Component ────────────────────────────────────────────────────────────────

interface PossibleMatchesPanelProps {
  /** Re-run matching when syncVersion bumps (remote sync) */
  syncVersion: number
  /** Re-run matching when pendingMatchVersion bumps (auto-detected on ingest) */
  pendingMatchVersion: number
}

export function PossibleMatchesPanel({ syncVersion, pendingMatchVersion }: PossibleMatchesPanelProps) {
  const { session, publishEvent } = useApp()
  const [candidates, setCandidates] = useState<MatchCandidate[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  useEffect(() => {
    loadDismissed().then(setDismissed)
  }, [])
  const [confirming, setConfirming] = useState<string | null>(null)

  // Re-run whenever sync or ingest detects new data, or dismissed set changes
  useEffect(() => {
    setCandidates(computeCandidates(dismissed))
  }, [syncVersion, pendingMatchVersion, dismissed])

  const handleConfirm = useCallback(async (candidate: MatchCandidate) => {
    if (!session) return
    setConfirming(pairKey(candidate.pubkeyA, candidate.pubkeyB))

    try {
      const event = buildSamePersonLink(
        session.npub, session.nsec,
        candidate.pubkeyA, candidate.pubkeyB,
      )
      publishEvent(event)

      const link: SamePersonLink = {
        eventId: event.id,
        pubkeyA: candidate.pubkeyA,
        pubkeyB: candidate.pubkeyB,
        claimantPubkey: session.npub,
        createdAt: event.created_at,
        retracted: false,
      }
      addSamePersonLink(link)

      setCandidates(prev => prev.filter(c =>
        pairKey(c.pubkeyA, c.pubkeyB) !== pairKey(candidate.pubkeyA, candidate.pubkeyB)
      ))
    } finally {
      setConfirming(null)
    }
  }, [session, publishEvent])

  const handleDismiss = useCallback((candidate: MatchCandidate) => {
    const key = pairKey(candidate.pubkeyA, candidate.pubkeyB)
    const next = new Set(dismissed)
    next.add(key)
    setDismissed(next)
    void saveDismissed(next)
  }, [dismissed])

  if (candidates.length === 0) return (
    <div style={{ marginTop: 8 }}>
      <button
        className="btn btn-ghost btn-sm"
        onClick={() => setCandidates(computeCandidates(dismissed))}
        style={{ color: 'var(--ink-muted)', fontSize: 12 }}
      >
        🔍 Scan for duplicate people
      </button>
    </div>
  )

  return (
    <div className="settings-section">
      <h2 className="settings-section-title" style={{ color: 'var(--gold)' }}>
        Possible duplicate people ({candidates.length})
      </h2>
      <p style={{ fontSize: 13, color: 'var(--ink-muted)', marginBottom: 12 }}>
        These pairs of people may be the same person, added independently by
        different family members. Confirm to merge them — they'll appear as one
        person in the tree and People list.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {candidates.map(candidate => (
          <MatchCard
            key={pairKey(candidate.pubkeyA, candidate.pubkeyB)}
            candidate={candidate}
            confirming={confirming === pairKey(candidate.pubkeyA, candidate.pubkeyB)}
            onConfirm={() => handleConfirm(candidate)}
            onDismiss={() => handleDismiss(candidate)}
          />
        ))}
      </div>
    </div>
  )
}

// ─── Match Card ───────────────────────────────────────────────────────────────

interface MatchCardProps {
  candidate: MatchCandidate
  confirming: boolean
  onConfirm: () => void
  onDismiss: () => void
}

function MatchCard({ candidate, confirming, onConfirm, onDismiss }: MatchCardProps) {
  const { t } = useTranslation()
  const personA = store.getPerson(candidate.pubkeyA)
  const personB = store.getPerson(candidate.pubkeyB)
  const claimsA = store.getClaimsForPerson(candidate.pubkeyA)
  const claimsB = store.getClaimsForPerson(candidate.pubkeyB)

  const pct = Math.round(candidate.confidence * 100)

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      {/* Confidence bar */}
      <div style={{
        height: 3,
        background: `linear-gradient(to right, var(--gold) ${pct}%, var(--border-soft) ${pct}%)`,
      }} />

      <div style={{ padding: '16px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
            {pct}% confidence match
          </span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {candidate.reasons.map(r => (
              <span key={r} style={{
                fontSize: 11, padding: '2px 8px',
                background: 'var(--cream)', borderRadius: 99,
                border: '1px solid var(--border-soft)',
                color: 'var(--ink-muted)',
              }}>
                {t(`match.reasons.${r}`)}
              </span>
            ))}
          </div>
        </div>

        {/* Side-by-side comparison */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 12, alignItems: 'start' }}>
          <PersonSummary name={personA?.displayName ?? '?'} claims={claimsA} />
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 20, color: 'var(--gold)', paddingTop: 4, fontWeight: 300,
          }}>≈</div>
          <PersonSummary name={personB?.displayName ?? '?'} claims={claimsB} />
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={onDismiss}
            disabled={confirming}
          >
            Not the same person
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={onConfirm}
            disabled={confirming}
          >
            {confirming ? 'Merging…' : 'Yes, same person'}
          </button>
        </div>
      </div>
    </div>
  )
}

function PersonSummary({ name, claims }: { name: string; claims: ReturnType<typeof store.getClaimsForPerson> }) {
  const get = (field: string) => claims.find(c => c.field === field && !c.retracted)?.value

  const born      = get('born')
  const died      = get('died')
  const birthplace = get('birthplace')

  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--navy)', fontFamily: 'var(--font-display)' }}>
        {name}
      </div>
      {(born || died) && (
        <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 2 }}>
          {born && `b. ${born}`}{born && died && ' · '}{died && `d. ${died}`}
        </div>
      )}
      {birthplace && (
        <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{birthplace}</div>
      )}
      {!born && !died && !birthplace && (
        <div style={{ fontSize: 12, color: 'var(--ink-muted)', fontStyle: 'italic' }}>No dates recorded</div>
      )}
    </div>
  )
}
