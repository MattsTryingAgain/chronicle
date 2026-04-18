import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  show: boolean
  targetNpub: string
  targetDisplayName: string
  onConfirm: (reason: string) => void
  onClose: () => void
}

export function TrustRevocationModal({
  show,
  targetNpub,
  targetDisplayName,
  onConfirm,
  onClose,
}: Props) {
  const { t } = useTranslation()
  const [reason, setReason] = useState('')

  if (!show) return null

  function handleSubmit() {
    if (!reason.trim()) return
    onConfirm(reason.trim())
    setReason('')
    onClose()
  }

  return (
    <div className="modal d-block" tabIndex={-1} style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
      <div className="modal-dialog modal-dialog-centered">
        <div className="modal-content border-0 shadow">
          <div className="modal-header border-bottom-0 pb-0">
            <h5 className="modal-title text-danger">{t('trust.revoke.title')}</h5>
            <button type="button" className="btn-close" onClick={onClose} aria-label="Close" />
          </div>

          <div className="modal-body">
            <p className="text-muted small">{t('trust.revoke.instruction')}</p>

            <div className="alert alert-warning py-2 small mb-3">
              <strong>{targetDisplayName}</strong>
              <div className="font-monospace text-muted" style={{ fontSize: 11 }}>
                {targetNpub.slice(0, 20)}…
              </div>
            </div>

            <label className="form-label fw-semibold">{t('trust.revoke.reasonLabel')}</label>
            <textarea
              className="form-control mb-3"
              rows={3}
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder={t('trust.revoke.reasonPlaceholder')}
            />

            <p className="text-muted small mb-0">
              {t('trust.revoke.effectiveWarning')}
            </p>
          </div>

          <div className="modal-footer border-top-0 pt-0">
            <button className="btn btn-outline-secondary" onClick={onClose}>
              {t('trust.revoke.cancel')}
            </button>
            <button
              className="btn btn-danger"
              onClick={handleSubmit}
              disabled={!reason.trim()}
            >
              {t('trust.revoke.submitButton')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
