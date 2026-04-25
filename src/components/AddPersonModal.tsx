/**
 * AddPersonModal
 * Modes: 'self' | 'ancestor' | 'edit'
 *
 * Relationship semantics (consistent throughout):
 *   RelationshipClaim { subjectPubkey, relatedPubkey, relationship }
 *   means: subjectPubkey IS relationship OF relatedPubkey
 *   e.g. subject=Matt, related=Stephen, relationship='child' → Matt is child of Stephen
 *
 * UI framing: "Who is [selected person] to [new/edited person]?"
 *   User picks "Parent" → selected person is parent of subject
 *   Stored: subject.relationship = 'child', related.relationship = 'parent'
 */

import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { store } from '../lib/storage'
import { serialiseGraph, getRelationshipsFor, retractRelationship } from '../lib/graph'
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
  selfPubkey?: string
  editPerson?: Person
  onSave: (person: Person) => void
  onDelete?: (pubkey: string) => void
  onCancel: () => void
}

type FormField = { field: FactField; labelKey: string; placeholderKey: string }

const FIELDS: FormField[] = [
  { field: 'born',       labelKey: 'profile.addPerson.bornLabel',       placeholderKey: 'profile.addPerson.bornPlaceholder' },
  { field: 'birthplace', labelKey: 'profile.addPerson.birthplaceLabel', placeholderKey: 'profile.addPerson.birthplacePlaceholder' },
  { field: 'died',       labelKey: 'profile.addPerson.diedLabel',       placeholderKey: 'profile.addPerson.diedPlaceholder' },
  { field: 'occupation', labelKey: 'profile.addPerson.occupationLabel', placeholderKey: 'profile.addPerson.occupationPlaceholder' },
]

// Options describe what the SELECTED (related) person is to the subject.
// e.g. "Parent" = selected person is parent of subject → subject is child of selected
const RELATIONSHIP_OPTIONS: { value: RelationshipType; label: string }[] = [
  { value: 'parent',      label: 'Parent' },
  { value: 'child',       label: 'Child' },
  { value: 'spouse',      label: 'Spouse' },
  { value: 'sibling',     label: 'Sibling' },
  { value: 'grandparent', label: 'Grandparent' },
  { value: 'grandchild',  label: 'Grandchild' },
]

// Given what the RELATED person is to the subject, return what the SUBJECT is to the related person
function subjectRel(relatedIsTo: RelationshipType): RelationshipType {
  const inv: Record<RelationshipType, RelationshipType> = {
    parent: 'child', child: 'parent',
    spouse: 'spouse', sibling: 'sibling',
    grandparent: 'grandchild', grandchild: 'grandparent',
  }
  return inv[relatedIsTo] ?? relatedIsTo
}

// Human-readable label for a stored relationship from subject's perspective
// subject=Matt, rel='child', related=Stephen → "Stephen is Parent of Matt"
function relLabel(subjectRelationship: RelationshipType): string {
  const labels: Record<RelationshipType, string> = {
    parent: 'Parent', child: 'Child',
    spouse: 'Spouse', sibling: 'Sibling',
    grandparent: 'Grandparent', grandchild: 'Grandchild',
  }
  // subjectRelationship is what subject IS to related → invert to get what related IS to subject
  return labels[subjectRel(subjectRelationship)] ?? subjectRelationship
}

function bestExistingValue(claims: FactClaim[], field: FactField): string {
  return claims
    .filter(c => c.field === field && !c.retracted)
    .sort((a, b) => b.confidenceScore - a.confidenceScore)[0]?.value ?? ''
}

export function AddPersonModal({ mode, selfPubkey, editPerson, onSave, onDelete, onCancel }: AddPersonModalProps) {
  const { t } = useTranslation()
  const { session, publishEvent } = useApp()

  const isEdit = mode === 'edit'
  const existingClaims = isEdit && editPerson ? store.getClaimsForPerson(editPerson.pubkey) : []

  // Only relationships where this person is subject (avoids showing both directions)
  const existingRelationships = isEdit && editPerson
    ? getRelationshipsFor(editPerson.pubkey).filter(r => r.subjectPubkey === editPerson.pubkey && !r.retracted)
    : []

  const initFieldValues = (): Partial<Record<FactField, string>> => {
    if (!isEdit) return {}
    const vals: Partial<Record<FactField, string>> = {}
    for (const { field } of FIELDS) {
      const v = bestExistingValue(existingClaims, field)
      if (v) vals[field] = v
    }
    return vals
  }

  const [name, setName] = useState(isEdit ? (editPerson?.displayName ?? '') : '')
  const [fieldValues, setFieldValues] = useState<Partial<Record<FactField, string>>>(initFieldValues)
  const [evidence, setEvidence] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  // New relationship to add
  const [relatedToPubkey, setRelatedToPubkey] = useState('')
  // Default: 'parent' = the selected person is parent of subject (most common when adding ancestors)
  const [relationshipType, setRelationshipType] = useState<RelationshipType>('parent')

  const allPersons = store.getAllPersons().filter(p => p.pubkey !== editPerson?.pubkey)

  const persistNow = useCallback(() => {
    void storageSet('chronicle:store', store.serialise())
    void storageSet('chronicle:graph', JSON.stringify(serialiseGraph()))
  }, [])

  const handleRemoveRelationship = useCallback((rel: RelationshipClaim) => {
    // Retract this edge and its inverse
    retractRelationship(rel.eventId)
    // Find and retract inverse (related→subject)
    const inverseRels = getRelationshipsFor(rel.relatedPubkey)
      .filter(r => r.subjectPubkey === rel.relatedPubkey && r.relatedPubkey === rel.subjectPubkey)
    for (const inv of inverseRels) retractRelationship(inv.eventId)
    persistNow()
    // Force re-render by triggering a save with no changes
    onSave(editPerson!)
  }, [editPerson, onSave, persistNow])

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
          pubkey = selfPubkey; isLiving = true
        } else {
          const kp = generateAncestorKeyPair(); pubkey = kp.npub; isLiving = false
        }
        person = { pubkey, displayName: name.trim(), isLiving, createdAt: now }
        store.upsertPerson(person)
      }

      const claimantPubkey = session?.npub ?? selfPubkey ?? person.pubkey
      let claimIdx = 0

      const addAndPublishClaim = (field: FactClaim['field'], value: string, evidenceText?: string) => {
        if (session?.nsec) {
          const event = buildFactClaim({
            claimantNpub: claimantPubkey, claimantNsec: session.nsec,
            subjectNpub: person.pubkey, field, value, evidence: evidenceText,
          })
          store.addClaim({
            eventId: event.id, claimantPubkey, subjectPubkey: person.pubkey,
            field, value, evidence: evidenceText, createdAt: now,
            retracted: false, confidenceScore: evidenceText ? 1.5 : 1.0,
          })
          publishEvent(event)
        } else {
          store.addClaim({
            eventId: `local-${person.pubkey}-${field}-${now}-${claimIdx++}`,
            claimantPubkey, subjectPubkey: person.pubkey,
            field, value, evidence: evidenceText, createdAt: now,
            retracted: false, confidenceScore: evidenceText ? 1.5 : 1.0,
          })
        }
      }

      if (!isEdit) addAndPublishClaim('name', name.trim())

      for (const { field } of FIELDS) {
        const value = fieldValues[field]?.trim()
        if (!value) continue
        if (isEdit && value === bestExistingValue(existingClaims, field)) continue
        addAndPublishClaim(field, value, evidence.trim() || undefined)
      }

      // Add new relationship if selected
      if (relatedToPubkey) {
        // relationshipType = what the RELATED person is to the subject
        // subjectRel(relationshipType) = what the SUBJECT is to the related person
        const subjRel = subjectRel(relationshipType)

        const addRel = (subjPubkey: string, relPubkey: string, rel: RelationshipType): RelationshipClaim => {
          const claim: RelationshipClaim = {
            eventId: session?.nsec
              ? (() => {
                  const ev = buildRelationshipClaim({
                    claimantNpub: claimantPubkey, claimantNsec: session.nsec!,
                    subjectNpub: subjPubkey, relationship: rel, sensitive: false,
                  })
                  publishEvent(ev)
                  return ev.id
                })()
              : `local-rel-${subjPubkey}-${relPubkey}-${rel}-${now}`,
            claimantPubkey, subjectPubkey: subjPubkey, relatedPubkey: relPubkey,
            relationship: rel, sensitive: false, createdAt: now, retracted: false,
          }
          addRelationship(claim)
          return claim
        }

        addRel(person.pubkey, relatedToPubkey, subjRel)   // subject is subjRel of related
        addRel(relatedToPubkey, person.pubkey, relationshipType) // related is relationshipType of subject
      }

      persistNow()
      onSave(person)
    } catch (e) {
      console.error(e)
      setError(t('errors.saveFailed'))
    } finally {
      setSaving(false)
    }
  }, [name, fieldValues, evidence, mode, isEdit, editPerson, existingClaims, selfPubkey,
      relatedToPubkey, relationshipType, session, publishEvent, persistNow, onSave, t])

  const modalTitle = isEdit
    ? `Edit ${editPerson?.displayName ?? 'person'}`
    : mode === 'self' ? t('profile.addPerson.titleSelf') : t('profile.addPerson.titleAncestor')

  const selectedOtherName = relatedToPubkey
    ? (store.getPerson(relatedToPubkey)?.displayName ?? 'them')
    : ''
  const subjectName = isEdit ? (editPerson?.displayName ?? 'this person') : (name.trim() || 'this person')

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-panel" onClick={e => e.stopPropagation()} style={{ maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="modal-header">
          <h2 className="modal-title">{modalTitle}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>✕</button>
        </div>

        <div className="modal-body">
          {error && <div className="alert alert-danger" style={{ marginBottom: 'var(--space-md)' }}>{error}</div>}

          {/* Name — add modes only */}
          {!isEdit && (
            <div className="form-group">
              <label htmlFor="ap-name">{t('profile.addPerson.nameLabel')}</label>
              <input id="ap-name" className="form-control" value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t('profile.addPerson.namePlaceholder')} autoFocus />
            </div>
          )}

          {/* Fact fields */}
          {FIELDS.map(({ field, labelKey, placeholderKey }) => (
            <div className="form-group" key={field}>
              <label htmlFor={`ap-${field}`}>{t(labelKey as never)}</label>
              <input id={`ap-${field}`} className="form-control"
                value={fieldValues[field] ?? ''}
                onChange={e => setFieldValues(prev => ({ ...prev, [field]: e.target.value }))}
                placeholder={t(placeholderKey as never)} />
            </div>
          ))}

          <div className="form-group">
            <label htmlFor="ap-evidence">{t('profile.addPerson.evidenceLabel')}</label>
            <input id="ap-evidence" className="form-control" value={evidence}
              onChange={e => setEvidence(e.target.value)}
              placeholder={t('profile.addPerson.evidencePlaceholder')} />
          </div>

          {/* Existing relationships with remove buttons */}
          {isEdit && existingRelationships.length > 0 && (
            <div className="form-group">
              <label>Relationships</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {existingRelationships.map(rel => {
                  const other = store.getPerson(rel.relatedPubkey)
                  // rel.relationship = what subject IS to related
                  // relLabel shows what related IS to subject (more natural reading)
                  const displayRel = relLabel(rel.relationship)
                  return (
                    <div key={rel.eventId} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 10px', background: 'var(--surface-raised)',
                      borderRadius: 6, fontSize: 13,
                    }}>
                      <span style={{ fontWeight: 500, flex: 1 }}>
                        {other?.displayName ?? '…'}
                      </span>
                      <span style={{ color: 'var(--ink-muted)' }}>
                        is {displayRel} of {editPerson?.displayName}
                      </span>
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ color: '#d06040', padding: '2px 6px', fontSize: 12 }}
                        onClick={() => handleRemoveRelationship(rel)}
                        title="Remove this relationship"
                      >
                        ✕
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Add a relationship */}
          {allPersons.length > 0 && (
            <div className="form-group">
              <label htmlFor="ap-related">
                {isEdit ? 'Add a relationship' : 'Relationship to an existing person'}
              </label>
              <select id="ap-related" className="form-select" value={relatedToPubkey}
                onChange={e => setRelatedToPubkey(e.target.value)}>
                <option value="">— select a person —</option>
                {allPersons.map(p => (
                  <option key={p.pubkey} value={p.pubkey}>{p.displayName}</option>
                ))}
              </select>

              {relatedToPubkey && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 6 }}>
                    {selectedOtherName} is the … of {subjectName}:
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {RELATIONSHIP_OPTIONS.map(({ value, label }) => (
                      <button
                        key={value}
                        className={`btn btn-sm ${relationshipType === value ? 'btn-primary' : 'btn-outline'}`}
                        onClick={() => setRelationshipType(value)}
                        style={{ fontSize: 13 }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 6 }}>
                    Will store: {selectedOtherName} is {RELATIONSHIP_OPTIONS.find(o => o.value === relationshipType)?.label ?? ''} of {subjectName}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Delete person — edit mode only */}
          {isEdit && onDelete && (
            <div style={{ marginTop: 'var(--space-lg)', borderTop: '1px solid var(--border)', paddingTop: 'var(--space-md)' }}>
              {!confirmDelete ? (
                <button
                  className="btn btn-sm"
                  style={{ color: '#d06040', background: 'transparent', border: '1px solid #d06040' }}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete this person…
                </button>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, color: 'var(--ink-muted)' }}>
                    Permanently delete {editPerson?.displayName}? This cannot be undone.
                  </span>
                  <button
                    className="btn btn-sm"
                    style={{ color: '#fff', background: '#c0392b', border: 'none' }}
                    onClick={() => { onDelete(editPerson!.pubkey); onCancel() }}
                  >
                    Yes, delete
                  </button>
                  <button className="btn btn-outline btn-sm" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onCancel}>
            {t('profile.addPerson.cancelButton')}
          </button>
          <button className="btn btn-primary" onClick={handleSave}
            disabled={saving || (!isEdit && !name.trim())}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : t('profile.addPerson.saveButton')}
          </button>
        </div>
      </div>
    </div>
  )
}
