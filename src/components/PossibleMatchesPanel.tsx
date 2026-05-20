/**
 * PossibleMatchesPanel
 *
 * Shown in the Connect tab after sync completes. Compares all persons in the
 * local store and surfaces pairs that are likely the same real person (added
 * independently by different users with different pubkeys).
 *
 * Confirming a match publishes a kind-30083 same_person_link event, which
 * causes the tree view to treat both pubkeys as one person going forward.
 * Dismissing records the decision so the pair is not suggested again.
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { store } from '../lib/storage'
import { getAllSamePersonLinks, addSamePersonLink } from '../lib/graph'
import { findMatchCandidates, alreadyLinked } from '../lib/treeLinking'
import { buildSamePersonLink } from '../lib/eventBuilder'
import { useApp } from '../context/AppContext'
import type { MatchCandidate } from '../lib/treeLinking'
import type { SamePersonLink } from '../lib/graph'

// ─── Dismissed pairs (persisted to localStorage so they survive refreshes) ───

const DISMISSED_KEY = 'chronicle:dismissed-matches'

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY)
    if (raw) return new Set(JSON.parse(raw))
  } catch {}
  return new Set()
}

function saveDismissed(set: Set<string>) {
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...set])) } catch {}
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|')
}

// ─── Component ────────────────────────────────────────────────────────────────

interface PossibleMatchesPanelProps {
  syncVersion: number   // re-run matching when new sync data arrives
}

export function PossibleMatchesPanel({ syncVersion }: PossibleMatchesPanelProps) {
  const { session, publishEvent, contacts } = useApp()
  const [candidates, setCandidates] = useState<MatchCandidate[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed)
  const [confirming, setConfirming] = useState<string | null>(null)

  // Re-run matching whenever sync delivers new data or dismissed set changes
  useEffect(() => {
    const allPersons = store.getAllPersons()
    if (allPersons.length < 2) { setCandidates([]); return }

    const allClaims     = store.getAllClaims()
    const existingLinks = getAllSamePersonLinks()

    // Split persons into "local" (added by this instance's identity) vs
    // "remote" (came from a connected contact's sync). We only want to surface
    // cross-instance duplicates, not flag two different people in the same tree.
    // A person is "remote" if their claims are authored by a contact's pubkey.
    const contactNpubs = new Set(contacts.map(c => c.npub))
    const remotePubkeys = new Set<string>()
    for (const claim of allClaims) {
      if (contactNpubs.has(claim.claimantPubkey)) {
        remotePubkeys.add(claim.subjectPubkey)
      }
    }

    const localPubkeys = allPersons
      .map(p => p.pubkey)
      .filter(pk => !remotePubkeys.has(pk))

    // If we have no remote persons yet, fall back to comparing all vs all
    // (handles the case before contact distinction is established)
    const setA = localPubkeys.length > 0 && remotePubkeys.size > 0
      ? localPubkeys
      : allPersons.map(p => p.pubkey)
    const setB = localPubkeys.length > 0 && remotePubkeys.size > 0
      ? [...remotePubkeys]
      : allPersons.map(p => p.pubkey)

    // Lower threshold: exact name match scores 0.35, which is enough signal
    const raw = findMatchCandidates(setA, setB, allClaims, { minConfidence: 0.3 })

    // Filter out already-linked, dismissed, and same-pubkey pairs
    const seen = new Set<string>()
    const filtered = raw.filter(c => {
      if (c.pubkeyA === c.pubkeyB) return false
      const key = pairKey(c.pubkeyA, c.pubkeyB)
      if (seen.has(key)) return false
      seen.add(key)
      if (alreadyLinked(c.pubkeyA, c.pubkeyB, existingLinks)) return false
      if (dismissed.has(key)) return false
      return true
    })

    setCandidates(filtered)
  }, [syncVersion, dismissed, contacts])

  const handleConfirm = useCallback(async (candidate: MatchCandidate) => {
    if (!session) return
    setConfirming(pairKey(candidate.pubkeyA, candidate.pubkeyB))

    try {
      // Publish the same-person link event
      const event = buildSamePersonLink(
        session.npub, session.nsec,
        candidate.pubkeyA, candidate.pubkeyB,
      )
      publishEvent(event)

      // Add to local graph immediately (don't wait for relay round-trip)
      const link: SamePersonLink = {
        eventId: event.id,
        pubkeyA: candidate.pubkeyA,
        pubkeyB: candidate.pubkeyB,
        claimantPubkey: session.npub,
        createdAt: event.created_at,
        retracted: false,
      }
      addSamePersonLink(link)

      // Remove from candidates
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
    saveDismissed(next)
  }, [dismissed])

  if (candidates.length === 0) return null

  return (
    <div className="settings-section">
      <h2 className="settings-section-title" style={{ color: 'var(--gold)' }}>
        Possible duplicate people ({candidates.length})
      </h2>
      <p style={{ fontSize: 13, color: 'var(--ink-muted)', marginBottom: 12 }}>
        These pairs of people may be the same person, added independently by
        different family members. Confirm to link them — they'll appear as one
        person in the tree.
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
            {confirming ? 'Linking…' : 'Yes, same person'}
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
