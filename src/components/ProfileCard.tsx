/**
 * ProfileCard — displays a person with their resolved fact fields.
 * Uses resolveAllFields from confidence.ts to pick best claim per field.
 * Shows conflict state indicators.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { resolveAllFields } from '../lib/confidence'
import { getRelationshipsFor } from '../lib/graph'
import type { Person, FactClaim, Endorsement, ConflictState, FactField } from '../types/chronicle'
import { store } from '../lib/storage'

interface ProfileCardProps {
  person: Person
  claims: FactClaim[]
  endorsements: Endorsement[]
  isOwn?: boolean
  onAddInfo?: () => void
}

// ─── Conflict badge ────────────────────────────────────────────────────────────

function ConflictBadge({ state }: { state: ConflictState }) {
  const { t } = useTranslation()
  if (state === 'none') return null
  if (state === 'resolved') return <span className="badge badge-success">✓ {t('profile.conflict.resolvedTitle')}</span>
  if (state === 'hard') return <span className="badge badge-danger">⚡ {t('profile.card.conflictBadge')}</span>
  return <span className="badge badge-warn">~ {t('profile.conflict.softTitle')}</span>
}

// ─── Score bar ────────────────────────────────────────────────────────────────

function ScoreBar({ score }: { score: number }) {
  return (
    <div className="conflict-score-bar" style={{ width: 56 }}>
      <div className="conflict-score-fill" style={{ width: `${Math.round(score * 100)}%` }} />
    </div>
  )
}

// ─── Claims detail panel ──────────────────────────────────────────────────────

function ClaimsPanel({
  field,
  claims,
  winningId,
  onClose,
}: {
  field: FactField
  claims: FactClaim[]
  winningId: string | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{t(`profile.card.${field}` as never, field)}</span>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{ padding: 0 }}>
          <div className="conflict-panel" style={{ border: 'none', borderRadius: 0 }}>
            {claims.map(c => (
              <div key={c.eventId} className="conflict-claim-row">
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 500, color: 'var(--ink)' }}>{c.value}</span>
                    {c.retracted && <span className="badge badge-neutral">{t('profile.card.retractedBadge')}</span>}
                    {c.evidence && <span className="badge badge-success" title={c.evidence}>📄</span>}
                    {c.eventId === winningId && !c.retracted && (
                      <span className="badge badge-success">Best match</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 2 }}>
                    {c.claimantPubkey.slice(0, 20)}…
                  </div>
                </div>
                <ScoreBar score={c.confidenceScore} />
              </div>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

// ─── Individual fact row ───────────────────────────────────────────────────────

const FIELD_LABELS: FactField[] = ['born', 'died', 'birthplace', 'deathplace', 'occupation', 'bio']

// ─── Relationships section ────────────────────────────────────────────────────

function relTypeLabel(rel: string): string {
  const labels: Record<string, string> = {
    parent: 'Parent', child: 'Child', spouse: 'Partner / Spouse', sibling: 'Sibling',
  }
  return labels[rel] ?? rel
}

function RelationshipsSection({ pubkey }: { pubkey: string }) {
  const rels = getRelationshipsFor(pubkey)
    .filter(r => r.subjectPubkey === pubkey && !r.retracted)

  if (rels.length === 0) return null

  // Group: partners first, then parents, then children, then siblings
  const order = ['spouse', 'parent', 'child', 'sibling']
  const sorted = [...rels].sort((a, b) => order.indexOf(a.relationship) - order.indexOf(b.relationship))

  return (
    <div className="profile-card-body" style={{ borderTop: '1px solid var(--border-soft)' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-muted)', letterSpacing: '0.06em',
        textTransform: 'uppercase', marginBottom: 'var(--space-sm)' }}>
        Relationships
      </div>
      {sorted.map(rel => {
        const other = store.getPerson(rel.relatedPubkey)
        const meta = rel.meta
        return (
          <div key={rel.eventId} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--navy)' }}>
                {other?.displayName ?? rel.relatedPubkey.slice(0, 16) + '…'}
              </span>
              <span style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
                {relTypeLabel(rel.relationship)}
                {rel.subtype && ` (${rel.subtype})`}
              </span>
            </div>
            {meta && (
              <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 2, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {meta.status && <span style={{ textTransform: 'capitalize' }}>{meta.status}</span>}
                {meta.startDate && <span>from {meta.startDate}</span>}
                {meta.endDate && <span>to {meta.endDate}</span>}
                {meta.adopted && <span>· Adopted</span>}
                {(meta.childrenFromYear || meta.childrenToYear) && (
                  <span>· Children: {meta.childrenFromYear ?? '?'}{meta.childrenToYear ? `–${meta.childrenToYear}` : '+'}</span>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── ProfileCard ──────────────────────────────────────────────────────────────

export function ProfileCard({
  person,
  claims,
  endorsements,
  isOwn = false,
  onAddInfo,
}: ProfileCardProps) {
  const { t } = useTranslation()
  const [expandedField, setExpandedField] = useState<FactField | null>(null)

  const resolutions = useMemo(
    () => resolveAllFields(claims, endorsements),
    [claims, endorsements],
  )

  const initials = person.displayName
    .split(' ')
    .map(w => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  const expandedResolution = expandedField
    ? resolutions.find(r => r.field === expandedField) ?? null
    : null

  return (
    <>
      <div className="profile-card">
        {/* Header */}
        <div className="profile-card-header">
          <div className="profile-card-avatar">{initials}</div>
          <div>
            <div className="profile-card-name">{person.displayName}</div>
            <div className="profile-card-living">
              {isOwn ? 'Your profile' : person.isLiving ? 'Living' : 'Ancestor'}
            </div>
          </div>
        </div>

        {/* Facts */}
        <div className="profile-card-body">
          {FIELD_LABELS.map(field => {
            const resolution = resolutions.find(r => r.field === field)
            const value = resolution?.winningClaim?.value
            const state = resolution?.conflictState ?? 'none'
            const allClaims = resolution?.allClaims ?? []
            const hasMultiple = allClaims.filter(c => !c.retracted).length > 1

            return (
              <div key={field} className="profile-fact-row">
                <span className="profile-fact-label">
                  {t(`profile.card.${field}` as never, field)}
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                  <span className={`profile-fact-value${!value ? ' muted' : ''}`}>
                    {value ?? t('profile.card.noData')}
                  </span>
                  {state !== 'none' && (
                    <div className="profile-conflict-indicator">
                      <ConflictBadge state={state} />
                      {hasMultiple && (
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ fontSize: 12, padding: '2px 8px' }}
                          onClick={() => setExpandedField(field)}
                        >
                          {t('profile.conflict.viewAllClaims')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}

          {resolutions.every(r => !r.winningClaim) && (
            <p style={{ color: 'var(--ink-muted)', fontStyle: 'italic', fontSize: 14, textAlign: 'center', padding: 'var(--space-md) 0' }}>
              {t('profile.card.noData')}
            </p>
          )}
        </div>

        {/* Relationships */}
        <RelationshipsSection pubkey={person.pubkey} />

        {/* Footer */}
        <div className="profile-card-footer">
          <button className="btn btn-outline btn-sm" onClick={onAddInfo}>
            {t('profile.card.editButton')}
          </button>
        </div>
      </div>

      {/* Claims detail modal */}
      {expandedField && expandedResolution && (
        <ClaimsPanel
          field={expandedField}
          claims={expandedResolution.allClaims}
          winningId={expandedResolution.winningClaim?.eventId ?? null}
          onClose={() => setExpandedField(null)}
        />
      )}
    </>
  )
}
