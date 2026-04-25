/**
 * AddPersonModal
 * Handles three modes:
 *  - 'self'     — adding yourself during onboarding
 *  - 'ancestor' — adding a new ancestor
 *  - 'edit'     — adding/updating fact claims on an existing person
 *
 * In edit mode the person already exists; we only add new fact claims for
 * fields the user fills in. The name field is hidden (person already named).
 */

import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { store } from '../lib/storage'
import { serialiseGraph, getRelationshipsFor } from '../lib/graph'
import { storageSet } from '../lib/appStorage'
import { useApp } from '../context/AppContext'
import { buildFactClaim, buildRelationshipClaim } from '../lib/eventBuilder'
import { addRelationship } from '../lib/graph'
import { generateAncestorKeyPair } from '../lib/keys'
import type { FactField, FactClaim, Person } from '../types/chronicle'
import type { RelationshipType } from '../types/chronicle'
import type { RelationshipClaim } from '../lib/graph'

interface AddPersonModalProps {
  mode: 'self' | 'ancestor' | 'edit'
  selfPubkey?: string       // required when mode === 'self'
  editPerson?: Person       // required when mode === 'edit'
  onSave: (person: Person) => void
  onCancel: () => void
}

type FormField = {
  field: FactField
  labelKey: string
  placeholderKey: string
}

const FIELDS: FormField[] = [
  { field: 'born',       labelKey: 'profile.addPerson.bornLabel',       placeholderKey: 'profile.addPerson.bornPlaceholder' },
  { field: 'birthplace', labelKey: 'profile.addPerson.birthplaceLabel', placeholderKey: 'profile.addPerson.birthplacePlaceholder' },
  { field: 'died',       labelKey: 'profile.addPerson.diedLabel',       placeholderKey: 'profile.addPerson.diedPlaceholder' },
  { field: 'occupation', labelKey: 'profile.addPerson.occupationLabel', placeholderKey: 'profile.addPerson.occupationPlaceholder' },
]

const RELATIONSHIP_OPTIONS: { value: RelationshipType; label: string }[] = [
  { value: 'parent',      label: 'Parent of' },
  { value: 'child',       label: 'Child of' },
  { value: 'spouse',      label: 'Spouse of' },
  { value: 'sibling',     label: 'Sibling of' },
  { value: 'grandparent', label: 'Grandparent of' },
  { value: 'grandchild',  label: 'Grandchild of' },
]

function bestExistingValue(claims: FactClaim[], field: FactField): string {
  const candidates = claims
    .filter(c => c.field === field && !c.retracted)
    .sort((a, b) => b.confidenceScore - a.confidenceScore)
  return candidates[0]?.value ?? ''
}

function inverseRelationship(r: RelationshipType): RelationshipType {
  const map: Record<RelationshipType, RelationshipType> = {
    parent: 'child', child: 'parent',
    spouse: 'spouse', sibling: 'sibling',
    grandparent: 'grandchild', grandchild: 'grandparent',
  }
  return map[r] ?? 'child'
}

export function AddPersonModal({ mode, selfPubkey, editPerson, onSave, onCancel }: AddPersonModalProps) {
  const { t } = useTranslation()
  const { session, publishEvent } = useApp()

  const isEdit = mode === 'edit'
  const existingClaims = isEdit && editPerson
    ? store.getClaimsForPerson(editPerson.pubkey)
    : []

  // Existing relationships shown in edit mode (for reference)
  const existingRelationships = isEdit && editPerson
    ? getRelationshipsFor(editPerson.pubkey)
    : []

  const initialFieldValues = (): Partial<Record<FactField, string>> => {
    if (!isEdit) return {}
    const vals: Partial<Record<FactField, string>> = {}
    for (const { field } of FIELDS) {
      const v = bestExistingValue(existingClaims, field)
      if (v) vals[field] = v
    }
    return vals
  }

  const [name, setName] = useState(isEdit ? (editPerson?.displayName ?? '') : '')
  const [fieldValues, setFieldValues] = useState<Partial<Record<FactField, string>>>(initialFieldValues)
  const [evidence, setEvidence] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [relatedToPubkey, setRelatedToPubkey] = useState<string>('')
  const [relationshipType, setRelationshipType] = useState<RelationshipType>('child')

  const allPersons = store.getAllPersons()

  const persistNow = useCallback(() => {
    void storageSet('chronicle:store', store.serialise())
    void storageSet('chronicle:graph', JSON.stringify(serialiseGraph()))
  }, [])

  const handleSave = useCallback(async () => {
    setError('')
    if (!isEdit && !name.trim()) { setError('Please enter a name.'); return }
    setSaving(true)
    try {
      const now = Math.floor(Date.now() / 1000)

      let person: Person

      if (isEdit && editPerson) {
        person = editPerson
      } else {
        let pubkey: string
        let isLiving: boolean

        if (mode === 'self' && selfPubkey) {
          pubkey = selfPubkey
          isLiving = true
        } else {
          const kp = generateAncestorKeyPair()
          pubkey = kp.npub
          isLiving = false
        }

        person = { pubkey, displayName: name.trim(), isLiving, createdAt: now }
        store.upsertPerson(person)
      }

      const claimantPubkey = session?.npub ?? selfPubkey ?? person.pubkey
      let claimIdx = 0

      const addAndPublishClaim = (field: FactClaim['field'], value: string, evidenceText?: string) => {
        if (session?.nsec) {
          const event = buildFactClaim({
            claimantNpub: claimantPubkey,
            claimantNsec: session.nsec,
            subjectNpub: person.pubkey,
            field,
            value,
            evidence: evidenceText,
          })
          const claim: FactClaim = {
            eventId: event.id,
            claimantPubkey,
            subjectPubkey: person.pubkey,
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
            eventId: `local-${person.pubkey}-${field}-${now}-${claimIdx++}`,
            claimantPubkey,
            subjectPubkey: person.pubkey,
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

      if (!isEdit) {
        addAndPublishClaim('name', name.trim())
      }

      for (const { field } of FIELDS) {
        const value = fieldValues[field]?.trim()
        if (!value) continue
        if (isEdit) {
          const existing = bestExistingValue(existingClaims, field)
          if (value === existing) continue
        }
        addAndPublishClaim(field, value, evidence.trim() || undefined)
      }

      // Always persist explicitly — signed path via publishEvent also persists, but
      // unsigned path and edit mode need this guarantee.
      persistNow()

      // Relationship linking — works in both add and edit modes
      if (relatedToPubkey && session?.nsec) {
        const relEvent = buildRelationshipClaim({
          claimantNpub: claimantPubkey,
          claimantNsec: session.nsec,
          subjectNpub: person.pubkey,
          relationship: relationshipType,
          sensitive: false,
        })
        const rel: RelationshipClaim = {
          eventId: relEvent.id,
          claimantPubkey,
          subjectPubkey: person.pubkey,
          relatedPubkey: relatedToPubkey,
          relationship: relationshipType,
          sensitive: false,
          createdAt: now,
          retracted: false,
        }
        addRelationship(rel)
        publishEvent(relEvent)

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
          relatedPubkey: person.pubkey,
          relationship: inverseType,
          sensitive: false,
          createdAt: now,
          retracted: false,
        }
        addRelationship(invRel)
        publishEvent(invEvent)
      } else if (relatedToPubkey) {
        const rel: RelationshipClaim = {
          eventId: `local-rel-${person.pubkey}-${relatedToPubkey}-${now}`,
          claimantPubkey,
          subjectPubkey: person.pubkey,
          relatedPubkey: relatedToPubkey,
          relationship: relationshipType,
          sensitive: false,
          createdAt: now,
          retracted: false,
        }
        addRelationship(rel)

        const invRel: RelationshipClaim = {
          eventId: `local-rel-${relatedToPubkey}-${person.pubkey}-${now}`,
          claimantPubkey,
          subjectPubkey: relatedToPubkey,
          relatedPubkey: person.pubkey,
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
  }, [name, fieldValues, evidence, mode, isEdit, editPerson, existingClaims, selfPubkey,
      relatedToPubkey, relationshipType, session, publishEvent, persistNow, onSave, t])

  const modalTitle = isEdit
    ? `Edit ${editPerson?.displayName ?? 'person'}`
    : mode === 'self'
      ? t('profile.addPerson.titleSelf')
      : t('profile.addPerson.titleAncestor')

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-panel" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">{modalTitle}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>✕</button>
        </div>

        <div className="modal-body">
          {error && (
            <div className="alert alert-danger" style={{ marginBottom: 'var(--space-md)' }}>
              {error}
            </div>
          )}

          {/* Name — only shown in add modes */}
          {!isEdit && (
            <div className="form-group">
              <label htmlFor="ap-name">{t('profile.addPerson.nameLabel')}</label>
              <input
                id="ap-name"
                className="form-control"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t('profile.addPerson.namePlaceholder')}
                autoFocus
              />
            </div>
          )}

          {/* Fact fields */}
          {FIELDS.map(({ field, labelKey, placeholderKey }) => (
            <div className="form-group" key={field}>
              <label htmlFor={`ap-${field}`}>{t(labelKey as never)}</label>
              <input
                id={`ap-${field}`}
                className="form-control"
                value={fieldValues[field] ?? ''}
                onChange={e => setFieldValues(prev => ({ ...prev, [field]: e.target.value }))}
                placeholder={t(placeholderKey as never)}
              />
            </div>
          ))}

          <div className="form-group">
            <label htmlFor="ap-evidence">{t('profile.addPerson.evidenceLabel')}</label>
            <input
              id="ap-evidence"
              className="form-control"
              value={evidence}
              onChange={e => setEvidence(e.target.value)}
              placeholder={t('profile.addPerson.evidencePlaceholder')}
            />
          </div>

          {/* Existing relationships (edit mode) */}
          {isEdit && existingRelationships.length > 0 && (
            <div className="form-group">
              <label>Current relationships</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {existingRelationships.map(rel => {
                  const other = store.getPerson(
                    rel.subjectPubkey === editPerson?.pubkey ? rel.relatedPubkey : rel.subjectPubkey
                  )
                  return (
                    <div key={rel.eventId} style={{
                      padding: '6px 10px',
                      background: 'var(--surface-raised)',
                      borderRadius: 6,
                      fontSize: 13,
                      color: 'var(--ink)',
                      display: 'flex',
                      gap: 8,
                    }}>
                      <span style={{ color: 'var(--ink-muted)', textTransform: 'capitalize' }}>{rel.relationship}</span>
                      <span>of</span>
                      <span style={{ fontWeight: 500 }}>{other?.displayName ?? rel.relatedPubkey.slice(0, 12) + '…'}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Add a relationship — available in both add and edit modes */}
          {allPersons.filter(p => p.pubkey !== editPerson?.pubkey).length > 0 && (
            <div className="form-group">
              <label htmlFor="ap-related">
                {isEdit ? 'Add a relationship' : t('profile.addPerson.relatedToLabel', { defaultValue: 'Related to' })}
              </label>
              <select
                id="ap-related"
                className="form-select"
                value={relatedToPubkey}
                onChange={e => setRelatedToPubkey(e.target.value)}
              >
                <option value="">{t('profile.addPerson.noRelation', { defaultValue: 'No relationship' })}</option>
                {allPersons
                  .filter(p => p.pubkey !== editPerson?.pubkey)
                  .map(p => (
                    <option key={p.pubkey} value={p.pubkey}>{p.displayName}</option>
                  ))}
              </select>
              {relatedToPubkey && (
                <select
                  className="form-select mt-2"
                  value={relationshipType}
                  onChange={e => setRelationshipType(e.target.value as RelationshipType)}
                >
                  {RELATIONSHIP_OPTIONS.map(({ value, label }) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onCancel}>
            {t('profile.addPerson.cancelButton')}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving || (!isEdit && !name.trim())}
          >
            {saving ? 'Saving…' : isEdit ? 'Save changes' : t('profile.addPerson.saveButton')}
          </button>
        </div>
      </div>
    </div>
  )
}
