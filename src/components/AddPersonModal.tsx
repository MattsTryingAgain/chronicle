/**
 * AddPersonModal
 * Used for adding yourself (onboarding) or adding an ancestor.
 * Creates a Person record + FactClaim events in the store.
 */

import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { store } from '../lib/storage'
import { useApp } from '../context/AppContext'
import { buildFactClaim } from '../lib/eventBuilder'
import { generateAncestorKeyPair } from '../lib/keys'
import type { FactField, FactClaim, Person } from '../types/chronicle'

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
  required?: boolean
  type?: string
}

const FIELDS: FormField[] = [
  { field: 'born',       labelKey: 'profile.addPerson.bornLabel',        placeholderKey: 'profile.addPerson.bornPlaceholder' },
  { field: 'birthplace', labelKey: 'profile.addPerson.birthplaceLabel',   placeholderKey: 'profile.addPerson.birthplacePlaceholder' },
  { field: 'died',       labelKey: 'profile.addPerson.diedLabel',         placeholderKey: 'profile.addPerson.diedPlaceholder' },
  { field: 'occupation', labelKey: 'profile.addPerson.evidenceLabel',     placeholderKey: 'profile.addPerson.evidencePlaceholder' },
]

export function AddPersonModal({ mode, selfPubkey, onSave, onCancel }: AddPersonModalProps) {
  const { t } = useTranslation()
  const { session, publishEvent } = useApp()
  const [name, setName] = useState('')
  const [fieldValues, setFieldValues] = useState<Partial<Record<FactField, string>>>({})
  const [evidence, setEvidence] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

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

      // Create fact claims for each filled field
      // In Stage 1 we create minimal claim objects (no cryptographic signing yet —
      // signing is wired in Stage 2 when relay infrastructure is in place).
      const claimantPubkey = selfPubkey ?? pubkey
      let claimIdx = 0

      // Helper: build, store, and publish a fact claim
      const addAndPublishClaim = (field: FactClaim['field'], value: string, evidenceText?: string) => {
        if (session?.nsec) {
          // Signed event path — used when session is active
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
          // Unsigned local path — ancestor key held by us, no session nsec
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

      onSave(person)
    } catch (e) {
      setError(t('errors.saveFailed'))
    } finally {
      setSaving(false)
    }
  }, [name, fieldValues, evidence, mode, selfPubkey, onSave, t])

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
