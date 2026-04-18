/**
 * NewVersionBanner — Stage 6
 *
 * Soft prompt shown when Chronicle encounters an event from a higher schema
 * version than the one it currently understands. Dismissible per session.
 */

import { useTranslation } from 'react-i18next'

interface Props {
  onDismiss: () => void
}

export function NewVersionBanner({ onDismiss }: Props) {
  const { t } = useTranslation()

  return (
    <div
      className="d-flex align-items-center justify-content-between px-3 py-2"
      style={{
        background: 'rgba(201,169,110,0.12)',
        borderBottom: '1px solid rgba(201,169,110,0.25)',
        fontSize: '0.85rem',
        flexShrink: 0,
      }}
    >
      <div className="d-flex align-items-center gap-2">
        <span style={{ color: 'var(--gold)' }}>✨</span>
        <span style={{ color: 'var(--gold-light)' }}>{t('version.newVersionAvailable')}</span>
      </div>
      <button
        className="btn btn-sm"
        style={{ fontSize: '0.75rem', padding: '2px 10px', background: 'rgba(201,169,110,0.2)', color: 'var(--gold)', border: '1px solid rgba(201,169,110,0.3)' }}
        onClick={onDismiss}
      >
        {t('version.dismiss')}
      </button>
    </div>
  )
}
