/**
 * ConflictHistoryView — Stage 6
 *
 * Full conflict resolution panel for a single person.
 * Shows all fields, their claims, conflict states, and allows:
 *  - Endorsing (voting for) a claim
 *  - Retracting your own claim
 *  - Viewing full claim history per field
 */

import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import {
  buildFieldConflictState,
  buildVoteEvent,
  buildRetractEvent,
  hasUserEndorsed,
  describeConflictState,
  type FieldConflictState,
  type ClaimWithHistory,
} from '../lib/conflictResolution'
import { store } from '../lib/storage'
import type { Person, FactClaim, Endorsement, FactField, ProximityLevel } from '../types/chronicle'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  person: Person
  claims: FactClaim[]
  endorsements: Endorsement[]
  onClose: () => void
  onUpdate: () => void   // caller refreshes data after vote/retract
}

// ─── Conflict state colour ─────────────────────────────────────────────────────

function conflictColour(state: FieldConflictState['conflictState']): string {
  switch (state) {
    case 'hard': return 'var(--danger)'
    case 'soft': return 'var(--warn)'
    case 'resolved': return 'var(--success)'
    default: return 'var(--ink-muted)'
  }
}

function conflictIcon(state: FieldConflictState['conflictState']): string {
  switch (state) {
    case 'hard': return '⚡'
    case 'soft': return '~'
    case 'resolved': return '✓'
    default: return '·'
  }
}

// ─── Single claim row ─────────────────────────────────────────────────────────

function ClaimRow({
  entry,
  myNpub,
  allEndorsements,
  onVote,
  onRetract,
}: {
  entry: ClaimWithHistory
  myNpub: string
  allEndorsements: Endorsement[]
  onVote: (claimEventId: string, agree: boolean) => void
  onRetract: (claimEventId: string) => void
}) {
  const { t } = useTranslation()
  const alreadyEndorsed = hasUserEndorsed(entry.claim.eventId, myNpub, allEndorsements)
  const agreeCount = entry.endorsements.filter(e => e.agree).length
  const disagreeCount = entry.endorsements.filter(e => !e.agree).length

  return (
    <div
      className={`p-3 mb-2 rounded${entry.isWinner ? ' chronicle-winner-row' : ''}`}
      style={{
        background: entry.isWinner
          ? 'rgba(201,169,110,0.10)'
          : 'rgba(255,255,255,0.03)',
        border: entry.isWinner
          ? '1px solid rgba(201,169,110,0.3)'
          : '1px solid rgba(255,255,255,0.07)',
        opacity: entry.isRetracted ? 0.5 : 1,
      }}
    >
      <div className="d-flex justify-content-between align-items-start">
        <div>
          <span style={{ fontWeight: 600, color: 'var(--gold-light)', fontSize: '1rem' }}>
            {entry.claim.value}
          </span>
          {entry.isWinner && (
            <span className="ms-2 badge" style={{ background: 'rgba(201,169,110,0.2)', color: 'var(--gold)', fontSize: '0.7rem' }}>
              {t('conflict.bestRecord')}
            </span>
          )}
          {entry.isRetracted && (
            <span className="ms-2 badge bg-secondary" style={{ fontSize: '0.7rem' }}>
              {t('profile.card.retractedBadge')}
            </span>
          )}
          {entry.isMine && !entry.isRetracted && (
            <span className="ms-2 badge" style={{ background: 'rgba(58,107,58,0.2)', color: '#6fbf6f', fontSize: '0.7rem' }}>
              {t('conflict.myRecord')}
            </span>
          )}
          <div className="mt-1" style={{ fontSize: '0.78rem', color: 'var(--ink-muted)' }}>
            {entry.claim.claimantPubkey.slice(0, 16)}…
            {entry.claim.evidence && (
              <span className="ms-2" title={entry.claim.evidence} style={{ color: 'var(--gold)' }}>
                📄 {t('profile.card.evidenceBadge')}
              </span>
            )}
          </div>
          <div className="mt-1" style={{ fontSize: '0.75rem', color: 'var(--ink-muted)' }}>
            {t('conflict.score')}: <strong style={{ color: 'var(--gold-light)' }}>{entry.score}</strong>
            {agreeCount > 0 && <span className="ms-2" style={{ color: 'var(--success)' }}>+{agreeCount}</span>}
            {disagreeCount > 0 && <span className="ms-2" style={{ color: 'var(--danger)' }}>−{disagreeCount}</span>}
          </div>
        </div>

        {!entry.isRetracted && (
          <div className="d-flex flex-column gap-1 ms-3" style={{ flexShrink: 0 }}>
            {!alreadyEndorsed && !entry.isMine && (
              <button
                className="btn btn-sm"
                style={{ fontSize: '0.75rem', padding: '2px 10px', background: 'rgba(58,107,58,0.2)', color: '#6fbf6f', border: '1px solid rgba(58,107,58,0.3)' }}
                onClick={() => onVote(entry.claim.eventId, true)}
              >
                {t('profile.conflict.endorseButton')}
              </button>
            )}
            {alreadyEndorsed && (
              <span style={{ fontSize: '0.72rem', color: 'var(--success)' }}>✓ {t('conflict.endorsed')}</span>
            )}
            {entry.isMine && (
              <button
                className="btn btn-sm"
                style={{ fontSize: '0.75rem', padding: '2px 10px', background: 'rgba(184,64,64,0.15)', color: '#e07070', border: '1px solid rgba(184,64,64,0.3)' }}
                onClick={() => onRetract(entry.claim.eventId)}
              >
                {t('profile.conflict.retractButton')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Field section ────────────────────────────────────────────────────────────

function FieldSection({
  fieldState,
  myNpub,
  allEndorsements,
  onVote,
  onRetract,
}: {
  fieldState: FieldConflictState
  myNpub: string
  allEndorsements: Endorsement[]
  onVote: (claimEventId: string, agree: boolean) => void
  onRetract: (claimEventId: string) => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(
    fieldState.conflictState === 'hard' || fieldState.conflictState === 'soft'
  )
  const colour = conflictColour(fieldState.conflictState)
  const icon = conflictIcon(fieldState.conflictState)

  return (
    <div className="mb-3">
      <button
        className="d-flex align-items-center justify-content-between w-100 py-2 px-0 border-0"
        style={{ background: 'transparent', cursor: 'pointer' }}
        onClick={() => setExpanded(e => !e)}
      >
        <div className="d-flex align-items-center gap-2">
          <span style={{ color: colour, fontWeight: 700, width: 16 }}>{icon}</span>
          <span style={{ fontFamily: 'var(--font-display)', color: 'var(--gold-light)', fontWeight: 600 }}>
            {t(`profile.card.${fieldState.field}` as never, fieldState.field)}
          </span>
          <span style={{ fontSize: '0.75rem', color: colour }}>
            {describeConflictState(fieldState.conflictState)}
          </span>
        </div>
        <span style={{ color: 'var(--ink-muted)', fontSize: '0.8rem' }}>
          {fieldState.activeClaimCount} {t('conflict.records')} {expanded ? '▲' : '▼'}
        </span>
      </button>

      {expanded && (
        <div className="mt-1 ps-3" style={{ borderLeft: `2px solid ${colour}33` }}>
          {fieldState.claims.map(entry => (
            <ClaimRow
              key={entry.claim.eventId}
              entry={entry}
              myNpub={myNpub}
              allEndorsements={allEndorsements}
              onVote={onVote}
              onRetract={onRetract}
            />
          ))}
          {fieldState.claims.length === 0 && (
            <p style={{ color: 'var(--ink-muted)', fontSize: '0.85rem', fontStyle: 'italic' }}>
              {t('profile.card.noData')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ─── ConflictHistoryView ───────────────────────────────────────────────────────

const FIELDS: FactField[] = ['name', 'born', 'died', 'birthplace', 'deathplace', 'occupation', 'bio']

export function ConflictHistoryView({ person, claims, endorsements, onClose, onUpdate }: Props) {
  const { t } = useTranslation()
  const { session } = useApp()

  const fieldStates = useMemo(() =>
    FIELDS
      .map(f => buildFieldConflictState(f, claims, endorsements, session?.npub ?? ''))
      .filter(fs => fs.totalClaimCount > 0),
    [claims, endorsements, session?.npub]
  )

  if (!session) return null

  function handleVote(claimEventId: string, agree: boolean) {
    const proximity: ProximityLevel = 'other'
    const event = buildVoteEvent({
      claimEventId,
      voterNpub: session!.npub,
      voterNsec: session!.nsec,
      agree,
      proximity,
    })
    // Ingest the endorsement locally
    const endorsement: Endorsement = {
      eventId: event.id,
      claimEventId,
      endorserPubkey: session!.npub,
      proximity,
      agree,
      createdAt: event.created_at,
    }
    store.addEndorsement(endorsement)
    store.addRawEvent(event)
    onUpdate()
  }

  function handleRetract(claimEventId: string) {
    const event = buildRetractEvent({
      claimEventId,
      claimantNpub: session!.npub,
      claimantNsec: session!.nsec,
    })
    store.retractClaim(claimEventId)
    store.addRawEvent(event)
    onUpdate()
  }

  const hardCount = fieldStates.filter(f => f.conflictState === 'hard').length
  const softCount = fieldStates.filter(f => f.conflictState === 'soft').length

  return (
    <div className="modal show d-block" tabIndex={-1} style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div className="modal-dialog modal-dialog-centered modal-lg">
        <div className="modal-content chronicle-card" style={{ maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
          <div className="modal-header border-0">
            <div>
              <h5 className="modal-title chronicle-gold mb-0">{t('conflict.title')}</h5>
              <div style={{ fontSize: '0.8rem', color: 'var(--ink-muted)' }}>{person.displayName}</div>
            </div>
            <button className="btn-close btn-close-white" onClick={onClose} />
          </div>

          {/* Summary bar */}
          {(hardCount > 0 || softCount > 0) && (
            <div className="px-4 pb-2">
              {hardCount > 0 && (
                <span className="badge me-2" style={{ background: 'rgba(184,64,64,0.15)', color: '#e07070' }}>
                  ⚡ {hardCount} {t('conflict.hardCount')}
                </span>
              )}
              {softCount > 0 && (
                <span className="badge" style={{ background: 'rgba(139,96,0,0.15)', color: '#d4a030' }}>
                  ~ {softCount} {t('conflict.softCount')}
                </span>
              )}
            </div>
          )}

          <div className="modal-body" style={{ overflowY: 'auto' }}>
            {fieldStates.length === 0 ? (
              <p style={{ color: 'var(--ink-muted)', textAlign: 'center', padding: '2rem', fontStyle: 'italic' }}>
                {t('conflict.noClaims')}
              </p>
            ) : (
              fieldStates.map(fs => (
                <FieldSection
                  key={fs.field}
                  fieldState={fs}
                  myNpub={session.npub}
                  allEndorsements={endorsements}
                  onVote={handleVote}
                  onRetract={handleRetract}
                />
              ))
            )}
          </div>

          <div className="modal-footer border-0">
            <button className="btn btn-outline-secondary" onClick={onClose}>
              {t('profile.addPerson.cancelButton')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
