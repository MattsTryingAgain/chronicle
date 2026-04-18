import { useTranslation } from 'react-i18next'
import type { Contact } from '../lib/contactList.js'

interface Props {
  contacts: Contact[]
  onRemove: (npub: string) => void
}

export function ContactListView({ contacts, onRemove }: Props) {
  const { t } = useTranslation()

  if (contacts.length === 0) {
    return (
      <div className="text-center text-muted py-5">
        <p className="mb-0">{t('contacts.noContacts')}</p>
      </div>
    )
  }

  return (
    <ul className="list-group list-group-flush">
      {contacts.map(c => (
        <li key={c.npub} className="list-group-item d-flex align-items-start gap-3 py-3">
          {/* Avatar initial */}
          <div
            className="rounded-circle d-flex align-items-center justify-content-center flex-shrink-0 text-white fw-bold"
            style={{ width: 40, height: 40, background: '#C9A96E', fontSize: 16 }}
          >
            {c.displayName.charAt(0).toUpperCase()}
          </div>

          <div className="flex-grow-1 min-width-0">
            <div className="d-flex align-items-center gap-2">
              <span className="fw-semibold">{c.displayName}</span>
              {c.trusted && (
                <span className="badge rounded-pill text-bg-success" style={{ fontSize: 10 }}>
                  {t('contacts.trusted')}
                </span>
              )}
            </div>
            <div className="text-muted small font-monospace text-truncate">{c.npub}</div>
            <div className="text-muted small">
              {t('contacts.relay')}: <span className="font-monospace">{c.relay}</span>
            </div>
          </div>

          <button
            className="btn btn-sm btn-outline-danger flex-shrink-0"
            onClick={() => onRemove(c.npub)}
            title={t('contacts.remove')}
          >
            {t('contacts.remove')}
          </button>
        </li>
      ))}
    </ul>
  )
}
