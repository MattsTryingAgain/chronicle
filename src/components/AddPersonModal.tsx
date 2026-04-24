/**
 * AddPersonModal
 * Used for adding yourself (onboarding) or adding an ancestor.
 * Creates a Person record + FactClaim events in the store.
 * Optionally links the new person to an existing person via a RelationshipClaim.
 */

import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { store } from '../lib/storage'
import { useApp } from '../context/AppContext'
import { buildFactClaim, buildRelationshipClaim } from '../lib/eventBuilder'
import { addRelationship } from '../lib/graph'
import { generateAncestorKeyPair } from '../lib/keys'
import type { FactField, FactClaim, Person } from '../types/chronicle'
import type { RelationshipType } from '../types/chronicle'
import type { RelationshipClaim } from '../lib/graph'

interface AddPersonModalProps {
  mode: 'self' | 'ancestor'
  selfPubkey?: string    // pass in when mode === 'self' (already created)
  onSave: (person: Person) => void
  onCancel: () => void
}

type FormField = {
  field: FactField
  labelKey: string
  placeholderKey: string
}

const FIELDS: FormField[] = [
  { field: 'born',       labelKey: 'profile.addPerson.bornLabel',        placeholderKey: 'profile.addPerson.bornPlaceholder' },
  { field: 'birthplace', labelKey: 'profile.addPerson.birthplaceLabel',   placeholderKey: 'profile.addPerson.birthplacePlaceholder' },
  { field: 'died',       labelKey: 'profile.addPerson.diedLabel',         placeholderKey: 'profile.addPerson.diedPlaceholder' },
  { field: 'occupation', labelKey: 'profile.addPerson.occupationLabel',   placeholderKey: 'profile.addPerson.occupationPlaceholder' },
]

const RELATIONSHIP_OPTIONS: { value: RelationshipType; label: string }[] = [
  { value: 'parent',      label: 'Parent of' },
  { value: 'child',       label: 'Child of' },
  { value: 'spouse',      label: 'Spouse of' },
  { value: 'sibling',     label: 'Sibling of' },
  { value: 'grandparent', label: 'Grandparent of' },
  { value: 'grandchild',  label: 'Grandchild of' },
]

export function AddPersonModal({ mode, selfPubkey, onSave, onCancel }: AddPersonModalProps) {
  const { t } = useTranslation()
  const { session, publishEvent } = useApp()
  const [name, setName] = useState('')
  const [fieldValues, setFieldValues] = useState<Partial<Record<FactField, string>>>({})
  const [evidence, setEvidence] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Relationship linking
  const [relatedToPubkey, setRelatedToPubkey] = useState<string>('')
  const [relationshipType, setRelationshipType] = useState<RelationshipType>('child')

  const allPersons = store.getAllPersons()

  const handleSave = useCallback(async () => {
    setError('')
    if (!name.trim()) { setError('Please enter a name.'); return }
    setSaving(true)
    try {
      const now = Math.floor(Date.now() / 1000)

      // Determine pubkey
      let pubkey: string
      let isLiving: boolean

      if (mode === 'self' && selfPubkey) {
        pubkey = selfPubkey
        isLiving = true
      } else {
        // Ancestor — generate independent random keypair
        const kp = generateAncestorKeyPair()
        pubkey = kp.npub
        isLiving = false
      }

      // Create person record
      const person: Person = {
        pubkey,
        displayName: name.trim(),
        isLiving,
        createdAt: now,
      }
      store.upsertPerson(person)

      const claimantPubkey = session?.npub ?? selfPubkey ?? pubkey
      let claimIdx = 0

      // Helper: build, store, and publish a fact claim
      const addAndPublishClaim = (field: FactClaim['field'], value: string, evidenceText?: string) => {
        if (session?.nsec) {
          const event = buildFactClaim({
            claimantNpub: claimantPubkey,
            claimantNsec: session.nsec,
            subjectNpub: pubkey,
            field,
            value,
            evidence: evidenceText,
          })
          const claim: FactClaim = {
            eventId: event.id,
            claimantPubkey,
            subjectPubkey: pubkey,
            field,
            value,
            evidence: evidenceText,
            createdAt: now,
            retracted: false,
            confidenceScore: evidenceText ? 1.5 : 1.0,
          }
          store.addClaim(claim)
          publishEvent(event)
        } else {
          const claim: FactClaim = {
            eventId: `local-${pubkey}-${field}-${now}-${claimIdx++}`,
            claimantPubkey,
            subjectPubkey: pubkey,
            field,
            value,
            evidence: evidenceText,
            createdAt: now,
            retracted: false,
            confidenceScore: evidenceText ? 1.5 : 1.0,
          }
          store.addClaim(claim)
        }
      }

      // Name claim
      addAndPublishClaim('name', name.trim())

      // Other field claims
      for (const { field } of FIELDS) {
        const value = fieldValues[field]?.trim()
        if (!value) continue
        addAndPublishClaim(field, value, evidence.trim() || undefined)
      }

      // ── Relationship claim ────────────────────────────────────────────────
      if (relatedToPubkey && session?.nsec) {
        // Signed path: build a kind-30079 event and store in graph
        const relEvent = buildRelationshipClaim({
          claimantNpub: claimantPubkey,
          claimantNsec: session.nsec,
          subjectNpub: pubkey,
          relationship: relationshipType,
          sensitive: false,
        })
        const rel: RelationshipClaim = {
          eventId: relEvent.id,
          claimantPubkey,
          subjectPubkey: pubkey,
          relatedPubkey: relatedToPubkey,
          relationship: relationshipType,
          sensitive: false,
          createdAt: now,
          retracted: false,
        }
        addRelationship(rel)
        publishEvent(relEvent)

        // Also add the inverse edge so the graph traversal sees both directions
        const inverseType = inverseRelationship(relationshipType)
        const invEvent = buildRelationshipClaim({
          claimantNpub: claimantPubkey,
          claimantNsec: session.nsec,
          subjectNpub: relatedToPubkey,
          relationship: inverseType,
          sensitive: false,
        })
        const invRel: RelationshipClaim = {
          eventId: invEvent.id,
          claimantPubkey,
          subjectPubkey: relatedToPubkey,
          relatedPubkey: pubkey,
          relationship: inverseType,
          sensitive: false,
          createdAt: now,
          retracted: false,
        }
        addRelationship(invRel)
        publishEvent(invEvent)
      } else if (relatedToPubkey) {
        // Unsigned local path (no active session nsec)
        const rel: RelationshipClaim = {
          eventId: `local-rel-${pubkey}-${relatedToPubkey}-${now}`,
          claimantPubkey,
          subjectPubkey: pubkey,
          relatedPubkey: relatedToPubkey,
          relationship: relationshipType,
          sensitive: false,
          createdAt: now,
          retracted: false,
        }
        addRelationship(rel)

        const invRel: RelationshipClaim = {
          eventId: `local-rel-${relatedToPubkey}-${pubkey}-${now}`,
          claimantPubkey,
          subjectPubkey: relatedToPubkey,
          relatedPubkey: pubkey,
          relationship: inverseRelationship(relationshipType),
          sensitive: false,
          createdAt: now,
          retracted: false,
        }
        addRelationship(invRel)
      }

      onSave(person)
    } catch {
      setError(t('errors.saveFailed'))
    } finally {
      setSaving(false)
    }
  }, [name, fieldValues, evidence, mode, selfPubkey, relatedToPubkey, relationshipType, session, publishEvent, onSave, t])

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-panel" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">
            {mode === 'self'
              ? t('profile.addPerson.titleSelf')
              : t('profile.addPerson.titleAncestor')}
          </h2>
          <button className="btn btn-ghost btn-sm" onClick={onCancel} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label htmlFor="ap-name">{t('profile.addPerson.nameLabel')}</label>
            <input
              id="ap-name"
              type="text"
              placeholder={t('profile.addPerson.namePlaceholder')}
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
            />
          </div>

          <hr className="divider" style={{ margin: '4px 0' }} />

          {FIELDS.map(({ field, labelKey, placeholderKey }) => (
            <div key={field} className="field">
              <label htmlFor={`ap-${field}`}>{t(labelKey as never)}</label>
              <input
                id={`ap-${field}`}
                type="text"
                placeholder={t(placeholderKey as never)}
                value={fieldValues[field] ?? ''}
                onChange={e => setFieldValues(prev => ({ ...prev, [field]: e.target.value }))}
              />
            </div>
          ))}

          <div className="field">
            <label htmlFor="ap-evidence">{t('profile.addPerson.evidenceLabel')}</label>
            <input
              id="ap-evidence"
              type="text"
              placeholder={t('profile.addPerson.evidencePlaceholder')}
              value={evidence}
              onChange={e => setEvidence(e.target.value)}
            />
            <span className="field-hint">Citing a source improves confidence in this record.</span>
          </div>

          {/* ── Relationship section ── */}
          {mode !== 'self' && allPersons.length > 0 && (
            <>
              <hr className="divider" style={{ margin: '8px 0' }} />
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                Relationship
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div className="field" style={{ flex: '1 1 auto', marginBottom: 0 }}>
                  <select
                    value={relationshipType}
                    onChange={e => setRelationshipType(e.target.value as RelationshipType)}
                    style={{ width: '100%' }}
                  >
                    {RELATIONSHIP_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div className="field" style={{ flex: '2 1 auto', marginBottom: 0 }}>
                  <select
                    value={relatedToPubkey}
                    onChange={e => setRelatedToPubkey(e.target.value)}
                    style={{ width: '100%' }}
                  >
                    <option value="">— select a person —</option>
                    {allPersons.map(p => (
                      <option key={p.pubkey} value={p.pubkey}>{p.displayName}</option>
                    ))}
                  </select>
                </div>
              </div>
              {!relatedToPubkey && (
                <span className="field-hint" style={{ marginTop: 4 }}>
                  Optional — link this person to someone already in your tree.
                </span>
              )}
            </>
          )}

          {error && <div className="alert alert-danger">{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onCancel}>
            {t('profile.addPerson.cancelButton')}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving || !name.trim()}
          >
            {saving ? 'Saving…' : t('profile.addPerson.saveButton')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function inverseRelationship(r: RelationshipType): RelationshipType {
  switch (r) {
    case 'parent':      return 'child'
    case 'child':       return 'parent'
    case 'grandparent': return 'grandchild'
    case 'grandchild':  return 'grandparent'
    case 'spouse':      return 'spouse'
    case 'sibling':     return 'sibling'
  }
}
