/**
 * AddPersonModal
 * Modes: 'self' | 'ancestor' | 'edit'
 *
 * Relationship semantics:
 *   RelationshipClaim { subjectPubkey, relatedPubkey, relationship }
 *   means: subjectPubkey IS relationship OF relatedPubkey
 *   e.g. subject=Matt, related=Stephen, relationship='child' → Matt is child of Stephen
 *
 * UI: "Who is [selected person] to [subject]?"
 *   Only parent / child / spouse / sibling — grandparent relationships
 *   emerge naturally from parent chains, no need to store explicitly.
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
import type { RelationshipType, RelationshipMeta } from '../types/chronicle'
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

// Only the four core types — grandparent/grandchild emerges from parent chains
const RELATIONSHIP_OPTIONS: { value: RelationshipType; label: string; inverse: RelationshipType }[] = [
  { value: 'parent',  label: 'Parent',  inverse: 'child'   },
  { value: 'child',   label: 'Child',   inverse: 'parent'  },
  { value: 'spouse',  label: 'Partner / Spouse', inverse: 'spouse'  },
  { value: 'sibling', label: 'Sibling', inverse: 'sibling' },
]

function subjectRel(relatedIsTo: RelationshipType): RelationshipType {
  return RELATIONSHIP_OPTIONS.find(o => o.value === relatedIsTo)?.inverse ?? relatedIsTo
}

function relLabel(subjectRelationship: RelationshipType): string {
  const opt = RELATIONSHIP_OPTIONS.find(o => o.value === subjectRel(subjectRelationship))
  return opt?.label ?? subjectRelationship
}

function bestExistingValue(claims: FactClaim[], field: FactField): string {
  return claims
    .filter(c => c.field === field && !c.retracted)
    .sort((a, b) => b.confidenceScore - a.confidenceScore)[0]?.value ?? ''
}

// ─── Relationship metadata form ───────────────────────────────────────────────

function SpouseMeta({ meta, onChange }: { meta: RelationshipMeta; onChange: (m: RelationshipMeta) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, color: 'var(--ink-muted)', display: 'block', marginBottom: 3 }}>
            Relationship start
          </label>
          <input className="form-control form-control-sm"
            placeholder="e.g. 1985 or June 1985"
            value={meta.startDate ?? ''}
            onChange={e => onChange({ ...meta, startDate: e.target.value || undefined })} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, color: 'var(--ink-muted)', display: 'block', marginBottom: 3 }}>
            Relationship end
          </label>
          <input className="form-control form-control-sm"
            placeholder="leave blank if ongoing"
            value={meta.endDate ?? ''}
            onChange={e => onChange({ ...meta, endDate: e.target.value || undefined })} />
        </div>
      </div>
      <div>
        <label style={{ fontSize: 12, color: 'var(--ink-muted)', display: 'block', marginBottom: 3 }}>
          Status
        </label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {(['married', 'unmarried', 'separated', 'divorced', 'widowed'] as const).map(s => (
            <button key={s} type="button"
              className={`btn btn-sm ${meta.status === s ? 'btn-primary' : 'btn-outline'}`}
              style={{ fontSize: 12, textTransform: 'capitalize' }}
              onClick={() => onChange({ ...meta, status: meta.status === s ? undefined : s })}>
              {s}
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, color: 'var(--ink-muted)', display: 'block', marginBottom: 3 }}>
            Children born from
          </label>
          <input className="form-control form-control-sm"
            placeholder="year"
            value={meta.childrenFromYear ?? ''}
            onChange={e => onChange({ ...meta, childrenFromYear: e.target.value || undefined })} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, color: 'var(--ink-muted)', display: 'block', marginBottom: 3 }}>
            Children born to
          </label>
          <input className="form-control form-control-sm"
            placeholder="year"
            value={meta.childrenToYear ?? ''}
            onChange={e => onChange({ ...meta, childrenToYear: e.target.value || undefined })} />
        </div>
      </div>
    </div>
  )
}

function ParentChildMeta({ meta, onChange }: { meta: RelationshipMeta; onChange: (m: RelationshipMeta) => void }) {
  return (
    <div style={{ marginTop: 8 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
        <input type="checkbox"
          checked={meta.adopted ?? false}
          onChange={e => onChange({ ...meta, adopted: e.target.checked || undefined })} />
        Adopted / non-biological relationship
      </label>
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AddPersonModal({ mode, selfPubkey, editPerson, onSave, onDelete, onCancel }: AddPersonModalProps) {
  const { t } = useTranslation()
  const { session, publishEvent } = useApp()

  const isEdit = mode === 'edit'
  const existingClaims = isEdit && editPerson ? store.getClaimsForPerson(editPerson.pubkey) : []
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

  const [relatedToPubkey, setRelatedToPubkey] = useState('')
  const [relationshipType, setRelationshipType] = useState<RelationshipType>('parent')
  const [relMeta, setRelMeta] = useState<RelationshipMeta>({})

  const allPersons = store.getAllPersons().filter(p => p.pubkey !== editPerson?.pubkey)

  const persistNow = useCallback(() => {
    void storageSet('chronicle:store', store.serialise())
    void storageSet('chronicle:graph', JSON.stringify(serialiseGraph()))
  }, [])

  const handleRemoveRelationship = useCallback((rel: RelationshipClaim) => {
    retractRelationship(rel.eventId)
    const inverseRels = getRelationshipsFor(rel.relatedPubkey)
      .filter(r => r.subjectPubkey === rel.relatedPubkey && r.relatedPubkey === rel.subjectPubkey)
    for (const inv of inverseRels) retractRelationship(inv.eventId)
    persistNow()
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
        let pubkey: string; let isLiving: boolean
        if (mode === 'self' && selfPubkey) { pubkey = selfPubkey; isLiving = true }
        else { const kp = generateAncestorKeyPair(); pubkey = kp.npub; isLiving = false }
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
          store.addClaim({ eventId: event.id, claimantPubkey, subjectPubkey: person.pubkey,
            field, value, evidence: evidenceText, createdAt: now, retracted: false,
            confidenceScore: evidenceText ? 1.5 : 1.0 })
          publishEvent(event)
        } else {
          store.addClaim({ eventId: `local-${person.pubkey}-${field}-${now}-${claimIdx++}`,
            claimantPubkey, subjectPubkey: person.pubkey, field, value, evidence: evidenceText,
            createdAt: now, retracted: false, confidenceScore: evidenceText ? 1.5 : 1.0 })
        }
      }

      if (!isEdit) addAndPublishClaim('name', name.trim())

      for (const { field } of FIELDS) {
        const value = fieldValues[field]?.trim()
        if (!value) continue
        if (isEdit && value === bestExistingValue(existingClaims, field)) continue
        addAndPublishClaim(field, value, evidence.trim() || undefined)
      }

      if (relatedToPubkey) {
        const subjRel = subjectRel(relationshipType)
        const metaToStore = Object.keys(relMeta).length > 0 ? relMeta : undefined

        const makeRel = (subjPubkey: string, relPubkey: string, rel: RelationshipType, meta?: RelationshipMeta): RelationshipClaim => {
          const eventId = session?.nsec
            ? (() => {
                const ev = buildRelationshipClaim({
                  claimantNpub: claimantPubkey, claimantNsec: session.nsec!,
                  subjectNpub: subjPubkey, relationship: rel, sensitive: false,
                })
                publishEvent(ev)
                return ev.id
              })()
            : `local-rel-${subjPubkey}-${relPubkey}-${rel}-${now}`
          return { eventId, claimantPubkey, subjectPubkey: subjPubkey, relatedPubkey: relPubkey,
            relationship: rel, sensitive: false, meta, createdAt: now, retracted: false }
        }

        addRelationship(makeRel(person.pubkey, relatedToPubkey, subjRel, metaToStore))
        addRelationship(makeRel(relatedToPubkey, person.pubkey, relationshipType, metaToStore))
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
      relatedToPubkey, relationshipType, relMeta, session, publishEvent, persistNow, onSave, t])

  const modalTitle = isEdit
    ? `Edit ${editPerson?.displayName ?? 'person'}`
    : mode === 'self' ? t('profile.addPerson.titleSelf') : t('profile.addPerson.titleAncestor')

  const selectedOtherName = relatedToPubkey ? (store.getPerson(relatedToPubkey)?.displayName ?? 'them') : ''
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

          {!isEdit && (
            <div className="form-group">
              <label htmlFor="ap-name">{t('profile.addPerson.nameLabel')}</label>
              <input id="ap-name" className="form-control" value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t('profile.addPerson.namePlaceholder')} autoFocus />
            </div>
          )}

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

          {/* Existing relationships */}
          {isEdit && existingRelationships.length > 0 && (
            <div className="form-group">
              <label>Relationships</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {existingRelationships.map(rel => {
                  const other = store.getPerson(rel.relatedPubkey)
                  const displayRel = relLabel(rel.relationship)
                  const meta = rel.meta
                  return (
                    <div key={rel.eventId} style={{
                      padding: '8px 10px', background: 'var(--cream)',
                      border: '1px solid var(--border-soft)', borderRadius: 8,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 500, flex: 1 }}>{other?.displayName ?? '…'}</span>
                        <span style={{ color: 'var(--ink-muted)', fontSize: 13 }}>
                          is {displayRel} of {editPerson?.displayName}
                        </span>
                        <button className="btn btn-ghost btn-sm"
                          style={{ color: '#d06040', padding: '2px 6px', fontSize: 12 }}
                          onClick={() => handleRemoveRelationship(rel)}>✕</button>
                      </div>
                      {meta && (
                        <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                          {meta.status && <span style={{ textTransform: 'capitalize' }}>{meta.status}</span>}
                          {meta.startDate && <span>from {meta.startDate}</span>}
                          {meta.endDate && <span>to {meta.endDate}</span>}
                          {meta.adopted && <span>Adopted</span>}
                          {(meta.childrenFromYear || meta.childrenToYear) && (
                            <span>Children: {meta.childrenFromYear ?? '?'}{meta.childrenToYear ? `–${meta.childrenToYear}` : '+'}</span>
                          )}
                        </div>
                      )}
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
                {isEdit ? 'Add a relationship' : 'Relationship to existing person'}
              </label>
              <select id="ap-related" className="form-select" value={relatedToPubkey}
                onChange={e => { setRelatedToPubkey(e.target.value); setRelMeta({}) }}>
                <option value="">— select a person —</option>
                {allPersons.map(p => (
                  <option key={p.pubkey} value={p.pubkey}>{p.displayName}</option>
                ))}
              </select>

              {relatedToPubkey && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 6 }}>
                    {selectedOtherName} is the … of {subjectName}:
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                    {RELATIONSHIP_OPTIONS.map(({ value, label }) => (
                      <button key={value} type="button"
                        className={`btn btn-sm ${relationshipType === value ? 'btn-primary' : 'btn-outline'}`}
                        style={{ fontSize: 13 }}
                        onClick={() => { setRelationshipType(value); setRelMeta({}) }}>
                        {label}
                      </button>
                    ))}
                  </div>

                  {/* Metadata per relationship type */}
                  {(relationshipType === 'spouse') && (
                    <SpouseMeta meta={relMeta} onChange={setRelMeta} />
                  )}
                  {(relationshipType === 'parent' || relationshipType === 'child') && (
                    <ParentChildMeta meta={relMeta} onChange={setRelMeta} />
                  )}

                  <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 8 }}>
                    Will store: {selectedOtherName} is {RELATIONSHIP_OPTIONS.find(o => o.value === relationshipType)?.label ?? ''} of {subjectName}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Delete */}
          {isEdit && onDelete && (
            <div style={{ marginTop: 'var(--space-lg)', borderTop: '1px solid var(--border)', paddingTop: 'var(--space-md)' }}>
              {!confirmDelete ? (
                <button className="btn btn-sm"
                  style={{ color: '#d06040', background: 'transparent', border: '1px solid #d06040' }}
                  onClick={() => setConfirmDelete(true)}>
                  Delete this person…
                </button>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, color: 'var(--ink-muted)' }}>
                    Permanently delete {editPerson?.displayName}? This cannot be undone.
                  </span>
                  <button className="btn btn-sm"
                    style={{ color: '#fff', background: '#c0392b', border: 'none' }}
                    onClick={() => { onDelete(editPerson!.pubkey); onCancel() }}>
                    Yes, delete
                  </button>
                  <button className="btn btn-outline btn-sm" onClick={() => setConfirmDelete(false)}>Cancel</button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onCancel}>{t('profile.addPerson.cancelButton')}</button>
          <button className="btn btn-primary" onClick={handleSave}
            disabled={saving || (!isEdit && !name.trim())}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : t('profile.addPerson.saveButton')}
          </button>
        </div>
      </div>
    </div>
  )
}
