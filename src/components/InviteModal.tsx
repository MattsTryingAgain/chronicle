import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { generateInviteCode, parseInviteCode } from '../lib/invite.js'

interface Props {
  show: boolean
  onClose: () => void
  /** The local user's hex pubkey */
  userHexPubkey: string
  /** The local relay URL */
  relayUrl: string
  /** Called when an incoming invite code is validated — the caller handles the handshake */
  onIncomingInvite: (npub: string, relay: string) => void
}

type Tab = 'generate' | 'join'

export function InviteModal({ show, onClose, userHexPubkey, relayUrl, onIncomingInvite }: Props) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('generate')
  const [copied, setCopied] = useState(false)
  const [scanInput, setScanInput] = useState('')
  const [scanError, setScanError] = useState('')
  const [scanSuccess, setScanSuccess] = useState('')

  if (!show) return null

  const inviteCode = generateInviteCode(userHexPubkey, relayUrl)

  function handleCopy() {
    navigator.clipboard.writeText(inviteCode).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  function handleConnect() {
    setScanError('')
    setScanSuccess('')
    const parsed = parseInviteCode(scanInput.trim())
    if (!parsed) {
      setScanError(t('invite.scan.errorInvalid'))
      return
    }
    onIncomingInvite(parsed.npub, parsed.relay)
    setScanSuccess(t('invite.scan.success', { name: parsed.npub.slice(0, 12) + '…' }))
    setScanInput('')
  }

  return (
    <div className="modal d-block" tabIndex={-1} style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
      <div className="modal-dialog modal-dialog-centered">
        <div className="modal-content border-0 shadow">
          <div className="modal-header border-bottom-0 pb-0">
            <h5 className="modal-title">{t('invite.title')}</h5>
            <button type="button" className="btn-close" onClick={onClose} aria-label="Close" />
          </div>

          <div className="modal-body">
            {/* Tabs */}
            <ul className="nav nav-pills mb-3">
              <li className="nav-item">
                <button
                  className={`nav-link${tab === 'generate' ? ' active' : ''}`}
                  onClick={() => setTab('generate')}
                >
                  {t('invite.generate.title')}
                </button>
              </li>
              <li className="nav-item">
                <button
                  className={`nav-link${tab === 'join' ? ' active' : ''}`}
                  onClick={() => setTab('join')}
                >
                  {t('invite.scan.title')}
                </button>
              </li>
            </ul>

            {tab === 'generate' && (
              <div>
                <p className="text-muted small">{t('invite.generate.instruction')}</p>
                <label className="form-label fw-semibold">{t('invite.generate.codeLabel')}</label>
                <div className="input-group mb-3">
                  <input
                    type="text"
                    className="form-control font-monospace small"
                    value={inviteCode}
                    readOnly
                  />
                  <button className="btn btn-outline-secondary" onClick={handleCopy}>
                    {copied ? t('invite.generate.copied') : t('invite.generate.copyButton')}
                  </button>
                </div>
              </div>
            )}

            {tab === 'join' && (
              <div>
                <p className="text-muted small">{t('invite.scan.instruction')}</p>
                {scanSuccess && (
                  <div className="alert alert-success py-2 small">{scanSuccess}</div>
                )}
                {scanError && (
                  <div className="alert alert-danger py-2 small">{scanError}</div>
                )}
                <label className="form-label fw-semibold">{t('invite.scan.inputLabel')}</label>
                <textarea
                  className="form-control font-monospace small mb-3"
                  rows={3}
                  value={scanInput}
                  onChange={e => setScanInput(e.target.value)}
                  placeholder={t('invite.scan.inputPlaceholder')}
                />
                <button
                  className="btn btn-primary w-100"
                  onClick={handleConnect}
                  disabled={!scanInput.trim()}
                >
                  {t('invite.scan.connectButton')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
