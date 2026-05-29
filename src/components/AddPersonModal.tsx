/**
 * AddPersonModal
 * Modes: 'self' | 'ancestor' | 'edit'
 *
 * STORAGE INVARIANT — read carefully before touching:
 *
 *   A RelationshipClaim { subjectPubkey, relatedPubkey, relationship: REL }
 *   means literally: "subjectPubkey is REL of relatedPubkey".
 *
 *   Example: { subject: Matt, related: Stephen, relationship: 'child' }
 *            reads as "Matt is child of Stephen".
 *
 *   Every user-facing relationship is stored as TWO claims — forward and inverse:
 *     subject=Matt    related=Stephen relationship='child'   ("Matt is child of Stephen")
 *     subject=Stephen related=Matt    relationship='parent'  ("Stephen is parent of Matt")
 *
 * UI POLICY:
 *
 *   The dropdown selector lists EXISTING people. The relationship buttons
 *   describe what the NEW (or edited) person is to that existing person.
 *
 *   So if Matt already exists, and the user is adding Stephen and clicks the
 *   "Parent" button on a row where Matt is selected, the meaning is:
 *
 *       "Stephen is the parent of Matt"
 *
 *   This is the most natural reading: the verb is in subject-first order,
 *   the new person is the subject, the existing person is the object.
 *
 *   In edit mode the "subject" is the person being edited. Same rule applies.
 *
 *   Multiple relationship rows can be added at once (a parent with several
 *   existing children, or a child with several existing parents/siblings).
 */

import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { store } from '../lib/storage'
import { serialiseGraph, getRelationshipsFor, retractRelationship } from '../lib/graph'
import { storageSet } from '../lib/appStorage'
import { useApp } from '../context/AppContext'
import { buildFactClaim, buildRelationshipClaim, buildIdentityAnchor } from '../lib/eventBuilder'
import { addRelationship } from '../lib/graph'
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

// Relationship buttons: what the SUBJECT is to the RELATED person.
const REL_OPTIONS: { value: RelationshipType; label: string; inverse: RelationshipType }[] = [
  { value: 'parent',  label: 'Parent',           inverse: 'child'   },
  { value: 'child',   label: 'Child',            inverse: 'parent'  },
  { value: 'spouse',  label: 'Partner / Spouse', inverse: 'spouse'  },
  { value: 'sibling', label: 'Sibling',          inverse: 'sibling' },
]

function inverseOf(rel: RelationshipType): RelationshipType {
  return REL_OPTIONS.find(o => o.value === rel)?.inverse ?? rel
}

function relLabelForSubject(rel: RelationshipType): string {
  return REL_OPTIONS.find(o => o.value === rel)?.label ?? rel
}

function bestExistingValue(claims: FactClaim[], field: FactField): string {
  return claims
    .filter(c => c.field === field && !c.retracted)
    .sort((a, b) => b.confidenceScore - a.confidenceScore)[0]?.value ?? ''
}

// ─── Relationship row state ───────────────────────────────────────────────────

interface RelRow {
  id: string
  relatedId: string
  relationship: RelationshipType   // what the SUBJECT is to the RELATED person
  meta: RelationshipMeta
}

function newRelRow(): RelRow {
  return {
    id: `row-${Math.random().toString(36).slice(2, 10)}`,
    relatedId: '',
    relationship: 'child',
    meta: {},
  }
}

// ─── Spouse / parent-child metadata pickers ───────────────────────────────────

function SpouseMeta({ meta, onChange }: { meta: RelationshipMeta; onChange: (m: RelationshipMeta) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, color: 'var(--ink-muted)', display: 'block', marginBottom: 3 }}>
            Start date
          </label>
          <input className="form-control form-control-sm"
            placeholder="e.g. 1985"
            value={meta.startDate ?? ''}
            onChange={e => onChange({ ...meta, startDate: e.target.value || undefined })} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, color: 'var(--ink-muted)', display: 'block', marginBottom: 3 }}>
            End date
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
    </div>
  )
}

function ParentChildMeta({ meta, onChange }: { meta: RelationshipMeta; onChange: (m: RelationshipMeta) => void }) {
  return (
    <div style={{ marginTop: 6 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
        <input type="checkbox"
          checked={meta.adopted ?? false}
          onChange={e => onChange({ ...meta, adopted: e.target.checked || undefined })} />
        Adopted / non-biological
      </label>
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AddPersonModal({ mode, selfPubkey, editPerson, onSave, onDelete, onCancel }: AddPersonModalProps) {
  const { t } = useTranslation()
  const { session, publishEvent, contacts } = useApp()

  const isEdit = mode === 'edit'
  const existingClaims = isEdit && editPerson ? store.getClaimsForPerson(editPerson.id) : []
  const existingRelationships = isEdit && editPerson
    ? getRelationshipsFor(editPerson.id)
        .filter(r => r.subjectId === editPerson.id && !r.retracted)
    : []

  // In edit mode, the name is locked for connected contacts — their chosen name
  // takes precedence. For ancestors and local entries it's freely editable.
  const isConnectedContact = isEdit && editPerson
    ? contacts.some(c => c.npub === editPerson.id)
    : false

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

  // Pending relationship rows to save on submit.
  const [relRows, setRelRows] = useState<RelRow[]>([])

  const subjectId2 = editPerson?.id ?? null
  const allPersons = store.getAllPersons().filter(p => p.id !== subjectId2)

  const persistNow = useCallback(() => {
    void storageSet('chronicle:store', store.serialise())
    void storageSet('chronicle:graph', JSON.stringify(serialiseGraph()))
  }, [])

  const handleRemoveRelationship = useCallback((rel: RelationshipClaim) => {
    retractRelationship(rel.eventId)
    const inverseRels = getRelationshipsFor(rel.relatedId)
      .filter(r => r.subjectId === rel.relatedId && r.relatedId === rel.subjectId)
    for (const inv of inverseRels) retractRelationship(inv.eventId)
    persistNow()
    if (editPerson) onSave(editPerson)
  }, [editPerson, onSave, persistNow])

  const addRelRow = useCallback(() => {
    setRelRows(rows => [...rows, newRelRow()])
  }, [])

  const updateRelRow = useCallback((id: string, patch: Partial<RelRow>) => {
    setRelRows(rows => rows.map(r => r.id === id ? { ...r, ...patch } : r))
  }, [])

  const removeRelRow = useCallback((id: string) => {
    setRelRows(rows => rows.filter(r => r.id !== id))
  }, [])

  const handleSave = useCallback(async () => {
    setError('')
    if (!isEdit && !name.trim()) { setError('Please enter a name.'); return }

    for (const row of relRows) {
      if (!row.relatedId && !row.relatedId) {
        setError('Pick a person for each relationship, or remove the empty row.')
        return
      }
    }

    setSaving(true)
    try {
      const now = Math.floor(Date.now() / 1000)
      let person: Person

      if (isEdit && editPerson) {
        person = editPerson
        // Update display name in store if it was changed (only allowed for non-contacts)
        if (!isConnectedContact && name.trim() && name.trim() !== editPerson.displayName) {
          const updated: Person = { ...editPerson, displayName: name.trim() }
          store.upsertPerson(updated)
          person = updated
        }
      } else {
        let personId: string; let isLiving: boolean
        if (mode === 'self' && selfPubkey) { personId = selfPubkey; isLiving = true }
        else { personId = crypto.randomUUID(); isLiving = false }
        person = { id: personId, displayName: name.trim(), isLiving, createdAt: now }
        store.upsertPerson(person)
        // Publish an identity anchor event so remote instances know this person exists
        if (session?.nsec) {
          const anchor = buildIdentityAnchor(personId, session.npub, session.nsec)
          publishEvent(anchor)
        }
      }

      const claimantPubkey = session?.npub ?? selfPubkey ?? person.id
      let claimIdx = 0

      const addAndPublishClaim = (field: FactClaim['field'], value: string, evidenceText?: string) => {
        if (session?.nsec) {
          const event = buildFactClaim({
            claimantNpub: claimantPubkey, claimantNsec: session.nsec,
            subjectId: person.id, field, value, evidence: evidenceText,
          })
          store.addClaim({ eventId: event.id, claimantPubkey, subjectId: person.id,
            field, value, evidence: evidenceText, createdAt: now, retracted: false,
            confidenceScore: evidenceText ? 1.5 : 1.0 })
          publishEvent(event)
        } else {
          store.addClaim({ eventId: `local-${person.id}-${field}-${now}-${claimIdx++}`,
            claimantPubkey, subjectId: person.id, field, value, evidence: evidenceText,
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

      // Save relationships. For each row, store TWO claims: subject→related and related→subject.
      let relIdx = 0
      for (const row of relRows) {
        const subjRel = row.relationship
        const invRel = inverseOf(subjRel)
        const metaToStore = Object.keys(row.meta).length > 0 ? row.meta : undefined

        const relatedId = row.relatedId ?? row.relatedId

        const makeId = (subjId: string, rel: RelationshipType): string => {
          if (session?.nsec) {
            // subjId is the subject person ID; determine the other side:
            // forward = person.id (subject) → relatedId (related)
            // inverse = relatedId (subject) → person.id (related)
            const relatedFor = subjId === person.id ? relatedId : person.id
            const ev = buildRelationshipClaim({
              claimantNpub: claimantPubkey, claimantNsec: session.nsec,
              subjectId: subjId, relatedId: relatedFor,
              relationship: rel, sensitive: false,
            })
            publishEvent(ev)
            return ev.id
          }
          return `local-rel-${subjId}-${rel}-${now}-${relIdx++}`
        }

        const fwdId = makeId(person.id, subjRel)
        const invId = makeId(relatedId, invRel)

        addRelationship({
          eventId: fwdId, claimantPubkey,
          subjectId: person.id, relatedId,
          relationship: subjRel, sensitive: false, meta: metaToStore,
          createdAt: now, retracted: false,
        })
        addRelationship({
          eventId: invId, claimantPubkey,
          subjectId: relatedId, relatedId: person.id,
          relationship: invRel, sensitive: false, meta: metaToStore,
          createdAt: now, retracted: false,
        })
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
      relRows, session, publishEvent, persistNow, onSave, t, isConnectedContact])

  const modalTitle = isEdit
    ? `Edit ${editPerson?.displayName ?? 'person'}`
    : mode === 'self' ? t('profile.addPerson.titleSelf') : t('profile.addPerson.titleAncestor')

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

          {/* Name field — always shown.
               In edit mode it's editable for ancestors; locked for connected contacts
               (their chosen name takes precedence over anything we'd set locally). */}
          {!isEdit && (
            <div className="form-group">
              <label htmlFor="ap-name">{t('profile.addPerson.nameLabel')}</label>
              <input id="ap-name" className="form-control" value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t('profile.addPerson.namePlaceholder')} autoFocus />
            </div>
          )}
          {isEdit && (
            <div className="form-group">
              <label htmlFor="ap-name">{t('profile.addPerson.nameLabel')}</label>
              {isConnectedContact ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input id="ap-name" className="form-control" value={name} disabled
                    style={{ background: 'var(--cream)', color: 'var(--ink-muted)', cursor: 'not-allowed' }} />
                  <span style={{ fontSize: 12, color: 'var(--ink-muted)', whiteSpace: 'nowrap' }}>Set by them</span>
                </div>
              ) : (
                <input id="ap-name" className="form-control" value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder={t('profile.addPerson.namePlaceholder')} autoFocus />
              )}
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

          {/* Existing relationships (edit mode only) */}
          {isEdit && existingRelationships.length > 0 && (
            <div className="form-group">
              <label>Existing relationships</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {existingRelationships.map(rel => {
                  const other = store.getPerson(rel.relatedId)
                  const subjectLabel = relLabelForSubject(rel.relationship)
                  const meta = rel.meta
                  return (
                    <div key={rel.eventId} style={{
                      padding: '8px 10px', background: 'var(--cream)',
                      border: '1px solid var(--border-soft)', borderRadius: 8,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ color: 'var(--ink-muted)', fontSize: 13 }}>
                          {editPerson?.displayName} is <strong style={{ color: 'var(--navy)' }}>{subjectLabel}</strong> of {other?.displayName ?? '…'}
                        </span>
                        <button className="btn btn-ghost btn-sm"
                          style={{ marginLeft: 'auto', color: '#d06040', padding: '2px 6px', fontSize: 12 }}
                          onClick={() => handleRemoveRelationship(rel)}>✕ remove</button>
                      </div>
                      {meta && (
                        <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                          {meta.status && <span style={{ textTransform: 'capitalize' }}>{meta.status}</span>}
                          {meta.startDate && <span>from {meta.startDate}</span>}
                          {meta.endDate && <span>to {meta.endDate}</span>}
                          {meta.adopted && <span>Adopted</span>}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Add relationships */}
          {allPersons.length > 0 && (
            <div className="form-group">
              <label>{isEdit ? 'Add relationships' : 'Relationships'}</label>
              <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 8 }}>
                Tell us how <strong>{subjectName}</strong> is related to people already in the tree.
                You can add several at once — useful when this person has multiple children, parents, or siblings already in the tree.
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {relRows.map(row => {
                  const other = row.relatedId ? store.getPerson(row.relatedId) : null
                  const otherName = other?.displayName ?? 'them'
                  return (
                    <div key={row.id} style={{
                      padding: 10, border: '1px solid var(--border-soft)', borderRadius: 8, background: 'var(--cream)',
                    }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                        <select className="form-select form-select-sm" style={{ flex: 1 }}
                          value={row.relatedId}
                          onChange={e => updateRelRow(row.id, { relatedId: e.target.value })}>
                          <option value="">— select a person —</option>
                          {allPersons.map(p => (
                            <option key={p.id} value={p.id}>{p.displayName}</option>
                          ))}
                        </select>
                        <button type="button" className="btn btn-ghost btn-sm"
                          style={{ color: '#d06040' }} onClick={() => removeRelRow(row.id)}>✕</button>
                      </div>

                      {row.relatedId && (
                        <>
                          <div style={{ fontSize: 13, color: 'var(--ink-muted)', margin: '10px 0 6px' }}>
                            <strong style={{ color: 'var(--navy)' }}>{subjectName}</strong> is the … of {otherName}:
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {REL_OPTIONS.map(({ value, label }) => (
                              <button key={value} type="button"
                                className={`btn btn-sm ${row.relationship === value ? 'btn-primary' : 'btn-outline'}`}
                                style={{ fontSize: 13 }}
                                onClick={() => updateRelRow(row.id, { relationship: value, meta: {} })}>
                                {label}
                              </button>
                            ))}
                          </div>

                          {row.relationship === 'spouse' && (
                            <SpouseMeta meta={row.meta} onChange={m => updateRelRow(row.id, { meta: m })} />
                          )}
                          {(row.relationship === 'parent' || row.relationship === 'child') && (
                            <ParentChildMeta meta={row.meta} onChange={m => updateRelRow(row.id, { meta: m })} />
                          )}

                          <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 8 }}>
                            Will save: <strong>{subjectName} is {relLabelForSubject(row.relationship)} of {otherName}</strong>
                          </div>
                        </>
                      )}
                    </div>
                  )
                })}

                <button type="button" className="btn btn-outline btn-sm"
                  style={{ alignSelf: 'flex-start' }} onClick={addRelRow}>
                  + Add a relationship
                </button>
              </div>
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
                    onClick={() => { onDelete(editPerson!.id); onCancel() }}>
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
