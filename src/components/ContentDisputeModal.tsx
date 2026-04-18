/**
 * ContentDisputeModal — Stage 6
 *
 * Allows a user to raise a content dispute against a specific event.
 * Shows existing disputes for context.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { raiseDispute, type ContentDispute } from '../lib/contentDispute'

interface Props {
  targetEventId: string
  targetDescription: string        // human-readable label, e.g. "Born: 1930"
  existingDisputes: ContentDispute[]
  onDisputed: () => void
  onCancel: () => void
}

export function ContentDisputeModal({
  targetEventId,
  targetDescription,
  existingDisputes,
  onDisputed,
  onCancel,
}: Props) {
  const { t } = useTranslation()
  const { session } = useApp()
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!session) return null

  async function handleSubmit() {
    if (!reason.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      raiseDispute({
        disputerNpub: session!.npub,
        disputerNsec: session!.nsec,
        targetEventId,
        reason: reason.trim(),
      })
      onDisputed()
    } catch (e) {
      setError(t('errors.generic'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal show d-block" tabIndex={-1} style={{ background: 'rgba(0,0,0,0.5)' }}>
      <div className="modal-dialog modal-dialog-centered">
        <div className="modal-content chronicle-card">
          <div className="modal-header border-0">
            <h5 className="modal-title chronicle-gold">{t('dispute.title')}</h5>
            <button
              className="btn-close btn-close-white"
              onClick={onCancel}
              disabled={submitting}
              aria-label={t('profile.addPerson.cancelButton')}
            />
          </div>

          <div className="modal-body">
            {/* Target record */}
            <div className="mb-3 p-2 rounded" style={{ background: 'rgba(201,169,110,0.08)', border: '1px solid rgba(201,169,110,0.2)' }}>
              <small className="text-muted d-block">{t('dispute.disputing')}</small>
              <span className="chronicle-gold fw-semibold">{targetDescription}</span>
            </div>

            {/* Existing disputes */}
            {existingDisputes.length > 0 && (
              <div className="mb-3">
                <small className="text-muted d-block mb-1">{t('dispute.existingDisputes', { count: existingDisputes.length })}</small>
                {existingDisputes.map(d => (
                  <div key={d.eventId} className="p-2 mb-1 rounded" style={{ background: 'rgba(255,255,255,0.04)', fontSize: '0.85rem' }}>
                    <span className="text-muted">{new Date(d.createdAt * 1000).toLocaleDateString()}: </span>
                    {d.reason || <em className="text-muted">{t('dispute.noReason')}</em>}
                  </div>
                ))}
              </div>
            )}

            {/* Reason input */}
            <div className="mb-3">
              <label className="form-label chronicle-label">{t('dispute.reasonLabel')}</label>
              <textarea
                className="form-control chronicle-input"
                rows={3}
                placeholder={t('dispute.reasonPlaceholder')}
                value={reason}
                onChange={e => setReason(e.target.value)}
                disabled={submitting}
              />
            </div>

            <div className="text-muted small">{t('dispute.permanentNote')}</div>

            {error && <div className="alert alert-danger mt-2 py-2">{error}</div>}
          </div>

          <div className="modal-footer border-0">
            <button className="btn btn-outline-secondary" onClick={onCancel} disabled={submitting}>
              {t('profile.addPerson.cancelButton')}
            </button>
            <button
              className="btn chronicle-btn-primary"
              onClick={handleSubmit}
              disabled={submitting || !reason.trim()}
            >
              {submitting ? t('dispute.submitting') : t('dispute.submitButton')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
