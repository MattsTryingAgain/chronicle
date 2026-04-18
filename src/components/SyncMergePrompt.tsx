import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MergeItem, SyncSession } from '../lib/syncMerge.js'

interface Props {
  sessions: SyncSession[]
  onAcceptItem: (peerNpub: string, eventId: string) => void
  onSkipItem: (peerNpub: string, eventId: string) => void
  onAcceptAll: (peerNpub: string) => void
  onSkipAll: (peerNpub: string) => void
  onDismiss: (peerNpub: string) => void
}

export function SyncMergePrompt({
  sessions,
  onAcceptItem,
  onSkipItem,
  onAcceptAll,
  onSkipAll,
  onDismiss,
}: Props) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<string | null>(null)

  const activeSessions = sessions.filter(
    s => !s.dismissed && s.items.some(i => i.status === 'pending')
  )

  if (activeSessions.length === 0) return null

  return (
    <div
      className="position-fixed bottom-0 start-0 end-0 p-3"
      style={{ zIndex: 1040, pointerEvents: 'none' }}
    >
      <div style={{ pointerEvents: 'auto', maxWidth: 480, margin: '0 auto' }}>
        {activeSessions.map(session => {
          const pending = session.items.filter(i => i.status === 'pending')
          const isExpanded = expanded === session.peerNpub
          const shortPeer = session.peerNpub.slice(0, 12) + '…'

          return (
            <div
              key={session.peerNpub}
              className="card border-0 shadow mb-2"
              style={{ borderLeft: '4px solid #C9A96E' }}
            >
              {/* Banner header */}
              <div className="card-body py-2 px-3">
                <div className="d-flex align-items-center gap-2">
                  <span className="badge rounded-pill" style={{ background: '#C9A96E', color: '#0d1b2a' }}>
                    {pending.length}
                  </span>
                  <span className="small fw-semibold flex-grow-1">
                    {pending.length === 1
                      ? `1 update from ${shortPeer}`
                      : `${pending.length} updates from ${shortPeer}`}
                  </span>
                  <button
                    className="btn btn-sm btn-link p-0 text-decoration-none"
                    onClick={() => setExpanded(isExpanded ? null : session.peerNpub)}
                  >
                    {t('sync.reviewButton')}
                  </button>
                  <button
                    className="btn btn-sm btn-success py-0 px-2"
                    style={{ fontSize: 12 }}
                    onClick={() => onAcceptAll(session.peerNpub)}
                  >
                    {t('sync.acceptAll')}
                  </button>
                  <button
                    className="btn-close btn-sm"
                    style={{ fontSize: 10 }}
                    onClick={() => onDismiss(session.peerNpub)}
                    aria-label={t('sync.dismiss')}
                  />
                </div>

                {/* Expanded item list */}
                {isExpanded && (
                  <ul className="list-group list-group-flush mt-2">
                    {pending.map((item: MergeItem) => (
                      <li
                        key={item.id}
                        className="list-group-item d-flex align-items-center gap-2 px-0 py-1"
                      >
                        <span className="badge text-bg-secondary rounded-pill" style={{ fontSize: 10 }}>
                          {t(`sync.item.${item.category}` as const)}
                        </span>
                        <span className="small flex-grow-1 text-truncate">{item.summary}</span>
                        <button
                          className="btn btn-xs btn-outline-success py-0 px-1"
                          style={{ fontSize: 11 }}
                          onClick={() => onAcceptItem(session.peerNpub, item.id)}
                        >
                          ✓
                        </button>
                        <button
                          className="btn btn-xs btn-outline-secondary py-0 px-1"
                          style={{ fontSize: 11 }}
                          onClick={() => onSkipItem(session.peerNpub, item.id)}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                    <li className="list-group-item px-0 pt-2 pb-0 border-0">
                      <button
                        className="btn btn-sm btn-outline-secondary w-100"
                        onClick={() => onSkipAll(session.peerNpub)}
                      >
                        {t('sync.skipAll')}
                      </button>
                    </li>
                  </ul>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
