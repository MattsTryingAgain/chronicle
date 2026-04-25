/**
 * SettingsView — Stage 2
 * Added: GEDCOM import, relay status display
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { store, type RecoveryContact } from '../lib/storage'
import { generateArchive, generateGedcom, downloadFile, type ExportablePerson } from '../lib/export'
import { importGedcom } from '../lib/gedcomImport'
import { useApp } from '../context/AppContext'
import type { UpdateStatus } from '../lib/appStorage'
import { FamilyKeyPanel } from './FamilyKeyPanel'
import { KeyRecoveryModal } from './KeyRecoveryModal'

// ─── Add Recovery Contact Modal ───────────────────────────────────────────────

function AddContactModal({ onSave, onCancel }: { onSave: (c: RecoveryContact) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [pubkey, setPubkey] = useState('')
  const [error, setError] = useState('')

  const handleSave = useCallback(() => {
    if (!name.trim()) { setError('Please enter a name.'); return }
    if (!pubkey.trim().startsWith('npub1')) { setError('Please enter a valid npub1… public key.'); return }
    onSave({ pubkey: pubkey.trim(), displayName: name.trim(), addedAt: Math.floor(Date.now() / 1000) })
  }, [name, pubkey, onSave])

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-panel" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Add recovery contact</h2>
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>✕</button>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 14, color: 'var(--ink-soft)', lineHeight: 1.5 }}>
            Add a trusted family member who can help you recover your account if you
            lose access. They must be registered <strong>before</strong> any loss event occurs.
          </p>
          <div className="field">
            <label htmlFor="rc-name">Display name</label>
            <input id="rc-name" type="text" placeholder="e.g. Aunt Mary" value={name}
              onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <label htmlFor="rc-pubkey">Their Chronicle public key (npub1…)</label>
            <input id="rc-pubkey" type="text" placeholder="npub1…" value={pubkey}
              onChange={e => setPubkey(e.target.value)}
              style={{ fontFamily: 'monospace', fontSize: 13 }} />
            <span className="field-hint">Ask them to share their public key from their Chronicle settings.</span>
          </div>
          {error && <div className="alert alert-danger">{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={!name.trim() || !pubkey.trim()}>
            Add contact
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Relay Status Section ─────────────────────────────────────────────────────

function RelayStatusSection() {
  const { t } = useTranslation()
  const { relayStatuses, localRelayUrl } = useApp()

  const statusColour: Record<string, string> = {
    connected: 'var(--success)',
    connecting: 'var(--warn)',
    disconnected: 'var(--ink-muted)',
    error: 'var(--danger)',
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">{t('settings.relay.title')}</h2>
      <div className="card" style={{ overflow: 'hidden' }}>
        {Object.keys(relayStatuses).length === 0 ? (
          <div style={{ padding: 'var(--space-md) var(--space-lg)', color: 'var(--ink-muted)', fontSize: 14 }}>
            {t('settings.relay.noConnections')}
          </div>
        ) : (
          Object.entries(relayStatuses).map(([url, status]) => (
            <div key={url} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: 'var(--space-md) var(--space-lg)',
              borderBottom: '1px solid var(--border-soft)',
            }}>
              <div>
                <div style={{ fontFamily: 'monospace', fontSize: 13, color: 'var(--ink)' }}>{url}</div>
                <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 2 }}>
                  {url === localRelayUrl ? t('settings.relay.localLabel') : t('settings.relay.remoteLabel')}
                </div>
              </div>
              <span style={{
                fontSize: 13, fontWeight: 500,
                color: statusColour[status] ?? 'var(--ink-muted)',
                textTransform: 'capitalize',
              }}>
                {status}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ─── Broadcast Controls Section ───────────────────────────────────────────────

function BroadcastControlsSection() {
  const { t } = useTranslation()
  const { broadcastSettings, updateBroadcastSettings, syncStatus } = useApp()

  const [sharedUrl, setSharedUrl] = useState(broadcastSettings.sharedRelayUrl)
  const [discoveryUrl, setDiscoveryUrl] = useState(broadcastSettings.discoveryRelayUrl)
  const [saved, setSaved] = useState(false)

  const handleTargetChange = useCallback((target: 'local' | 'shared' | 'discovery') => {
    updateBroadcastSettings({ target })
  }, [updateBroadcastSettings])

  const handleSaveUrls = useCallback(() => {
    updateBroadcastSettings({ sharedRelayUrl: sharedUrl.trim(), discoveryRelayUrl: discoveryUrl.trim() })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [sharedUrl, discoveryUrl, updateBroadcastSettings])

  const syncLabel: Record<string, string> = {
    idle: '',
    syncing: t('settings.broadcast.syncSyncing'),
    done: t('settings.broadcast.syncDone'),
    error: t('settings.broadcast.syncError'),
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">{t('settings.broadcast.title')}</h2>
      <div className="card" style={{ overflow: 'hidden' }}>
        {/* Local only */}
        <label style={{
          display: 'flex', alignItems: 'flex-start', gap: 'var(--space-md)',
          padding: 'var(--space-md) var(--space-lg)',
          borderBottom: '1px solid var(--border-soft)',
          cursor: 'pointer',
        }}>
          <input
            type="radio"
            name="broadcastTarget"
            checked={broadcastSettings.target === 'local'}
            onChange={() => handleTargetChange('local')}
            style={{ marginTop: 3, accentColor: 'var(--gold)' }}
          />
          <div>
            <div style={{ fontWeight: 500, color: 'var(--navy)' }}>{t('settings.broadcast.localTitle')}</div>
            <div style={{ fontSize: 13, color: 'var(--ink-muted)', marginTop: 2 }}>{t('settings.broadcast.localDesc')}</div>
          </div>
        </label>

        {/* Shared family relay */}
        <label style={{
          display: 'flex', alignItems: 'flex-start', gap: 'var(--space-md)',
          padding: 'var(--space-md) var(--space-lg)',
          borderBottom: '1px solid var(--border-soft)',
          cursor: 'pointer',
        }}>
          <input
            type="radio"
            name="broadcastTarget"
            checked={broadcastSettings.target === 'shared'}
            onChange={() => handleTargetChange('shared')}
            style={{ marginTop: 3, accentColor: 'var(--gold)' }}
          />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500, color: 'var(--navy)' }}>{t('settings.broadcast.sharedTitle')}</div>
            <div style={{ fontSize: 13, color: 'var(--ink-muted)', marginTop: 2 }}>{t('settings.broadcast.sharedDesc')}</div>
            {broadcastSettings.target === 'shared' && (
              <input
                type="url"
                placeholder="wss://your-family-relay.example"
                value={sharedUrl}
                onChange={e => setSharedUrl(e.target.value)}
                style={{ marginTop: 'var(--space-sm)', fontFamily: 'monospace', fontSize: 13, width: '100%' }}
                onClick={e => e.stopPropagation()}
              />
            )}
          </div>
        </label>

        {/* Discovery relay */}
        <label style={{
          display: 'flex', alignItems: 'flex-start', gap: 'var(--space-md)',
          padding: 'var(--space-md) var(--space-lg)',
          cursor: 'pointer',
        }}>
          <input
            type="radio"
            name="broadcastTarget"
            checked={broadcastSettings.target === 'discovery'}
            onChange={() => handleTargetChange('discovery')}
            style={{ marginTop: 3, accentColor: 'var(--gold)' }}
          />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500, color: 'var(--navy)' }}>{t('settings.broadcast.discoveryTitle')}</div>
            <div style={{ fontSize: 13, color: 'var(--ink-muted)', marginTop: 2 }}>{t('settings.broadcast.discoveryDesc')}</div>
            {broadcastSettings.target === 'discovery' && (
              <input
                type="url"
                placeholder="wss://discovery.example"
                value={discoveryUrl}
                onChange={e => setDiscoveryUrl(e.target.value)}
                style={{ marginTop: 'var(--space-sm)', fontFamily: 'monospace', fontSize: 13, width: '100%' }}
                onClick={e => e.stopPropagation()}
              />
            )}
          </div>
        </label>
      </div>

      {/* Save button — only shown if a URL field is visible */}
      {broadcastSettings.target !== 'local' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)', marginTop: 'var(--space-sm)' }}>
          <button className="btn btn-outline btn-sm" onClick={handleSaveUrls}>
            {saved ? t('settings.broadcast.saved') : t('settings.broadcast.saveUrl')}
          </button>
          {saved && <span style={{ fontSize: 13, color: 'var(--success)' }}>✓</span>}
        </div>
      )}

      {/* Sync status indicator */}
      {syncStatus !== 'idle' && (
        <div style={{ marginTop: 'var(--space-sm)', fontSize: 13, color: 'var(--ink-muted)' }}>
          {syncLabel[syncStatus]}
        </div>
      )}
    </div>
  )
}

// ─── SettingsView ─────────────────────────────────────────────────────────────

export function SettingsView() {
  const { t } = useTranslation()
  const { session, signOut } = useApp()
  const [showAddContact, setShowAddContact] = useState(false)
  const [importResult, setImportResult] = useState<{ count: number; warnings: string[] } | null>(null)
  const [importError, setImportError] = useState('')

  // ── Update checker state ─────────────────────────────────────────────────
  const [appVersion, setAppVersion] = useState<string>('')
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)

  useEffect(() => {
    if (window.chronicleElectron?.getVersion) {
      window.chronicleElectron.getVersion().then(v => setAppVersion(v)).catch(() => {})
    }
    const unsub = window.chronicleElectron?.onUpdateStatus?.((status) => {
      setUpdateStatus(status)
      setCheckingUpdate(false)
    })
    return () => { unsub?.() }
  }, [])

  const handleCheckForUpdate = async () => {
    if (!window.chronicleElectron?.checkForUpdate) return
    setCheckingUpdate(true)
    setUpdateStatus({ type: 'checking' })
    await window.chronicleElectron.checkForUpdate()
  }

  const handleInstallUpdate = () => {
    window.chronicleElectron?.installUpdate?.()
  }

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [, forceUpdate] = useState(0)
  const refresh = useCallback(() => forceUpdate(n => n + 1), [])

  const contacts = store.getRecoveryContacts()
  const [showKeyRecovery, setShowKeyRecovery] = useState(false)

  const handleAddContact = useCallback((contact: RecoveryContact) => {
    store.addRecoveryContact(contact)
    setShowAddContact(false)
    refresh()
  }, [refresh])

  const handleRemoveContact = useCallback((pubkey: string) => {
    if (confirm('Remove this recovery contact?')) {
      store.removeRecoveryContact(pubkey)
      refresh()
    }
  }, [refresh])

  const handleExportGedcom = useCallback(() => {
    const exportable: ExportablePerson[] = store.getAllPersons().map(p => ({
      person: p, claims: store.getClaimsForPerson(p.pubkey),
    }))
    downloadFile(generateGedcom(exportable), 'chronicle-export.ged', 'text/plain;charset=utf-8')
  }, [])

  const handleExportArchive = useCallback(() => {
    const identity = store.getIdentity()
    const exportable: ExportablePerson[] = store.getAllPersons().map(p => ({
      person: p, claims: store.getClaimsForPerson(p.pubkey),
    }))
    downloadFile(
      generateArchive(
        identity ? { npub: identity.npub, displayName: identity.displayName } : null,
        exportable,
        store.getRecoveryContacts(),
      ),
      'chronicle-archive.json',
      'application/json',
    )
  }, [])

  const handleGedcomFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !session) return
    setImportError('')
    setImportResult(null)
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const text = ev.target?.result as string
        const result = importGedcom(text, session.npub)
        for (const { person, claims } of result.persons) {
          store.upsertPerson(person)
          for (const claim of claims) store.addClaim(claim)
        }
        setImportResult({ count: result.indiCount, warnings: result.warnings })
        refresh()
      } catch {
        setImportError('Could not parse the GEDCOM file. Please check the file and try again.')
      }
    }
    reader.readAsText(file, 'utf-8')
    // Reset file input so same file can be re-imported
    e.target.value = ''
  }, [session, refresh])

  return (
    <div>
      <h1 className="page-title">{t('settings.title')}</h1>

      {/* Identity */}
      {session && (
        <div className="settings-section">
          <h2 className="settings-section-title">Your identity</h2>
          <div className="card" style={{ padding: 'var(--space-md) var(--space-lg)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-md)' }}>
              <div>
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 16, color: 'var(--navy)' }}>
                  {session.displayName}
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--ink-muted)', marginTop: 4, wordBreak: 'break-all' }}>
                  {session.npub}
                </div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={signOut} style={{ flexShrink: 0 }}>
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Relay status */}
      <RelayStatusSection />

      {/* Broadcast controls */}
      <BroadcastControlsSection />

      {/* Recovery contacts */}
      <div className="settings-section">
        <h2 className="settings-section-title">{t('settings.recoveryContacts.title')}</h2>
        <p style={{ fontSize: 14, color: 'var(--ink-soft)', marginBottom: 'var(--space-md)', lineHeight: 1.5 }}>
          {t('settings.recoveryContacts.description')}
        </p>
        {contacts.length === 0 ? (
          <div className="card" style={{ padding: 'var(--space-lg)', textAlign: 'center' }}>
            <p style={{ color: 'var(--ink-muted)', fontSize: 14, marginBottom: 'var(--space-md)' }}>
              {t('settings.recoveryContacts.noContacts')}
            </p>
            <button className="btn btn-outline" onClick={() => setShowAddContact(true)}>
              {t('settings.recoveryContacts.addButton')}
            </button>
          </div>
        ) : (
          <>
            {contacts.map(c => (
              <div key={c.pubkey} className="recovery-contact-item">
                <div>
                  <div style={{ fontWeight: 500, color: 'var(--navy)' }}>{c.displayName}</div>
                  <div style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--ink-muted)', marginTop: 2 }}>
                    {c.pubkey.slice(0, 24)}…
                  </div>
                </div>
                <button className="btn btn-danger btn-sm" onClick={() => handleRemoveContact(c.pubkey)}>
                  Remove
                </button>
              </div>
            ))}
            <button className="btn btn-outline btn-sm" onClick={() => setShowAddContact(true)} style={{ marginTop: 'var(--space-sm)' }}>
              {t('settings.recoveryContacts.addButton')}
            </button>
          </>
        )}
      </div>

      {/* Export & Import */}
      <div className="settings-section">
        <h2 className="settings-section-title">{t('settings.exportSection')}</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>

          {/* GEDCOM Import */}
          <div className="card" style={{ padding: 'var(--space-md) var(--space-lg)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500, color: 'var(--navy)', marginBottom: 4 }}>Import GEDCOM</div>
                <div style={{ fontSize: 13, color: 'var(--ink-muted)' }}>
                  Import a .ged file from Ancestry, FamilySearch, or any genealogy app.
                </div>
              </div>
              <div style={{ flexShrink: 0 }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".ged,.gedcom"
                  onChange={handleGedcomFile}
                  style={{ display: 'none' }}
                  aria-label="Import GEDCOM file"
                />
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!session}
                >
                  Choose file
                </button>
              </div>
            </div>
            {importResult && (
              <div className="alert alert-warn" style={{ marginTop: 'var(--space-md)' }}>
                <strong>Imported {importResult.count} {importResult.count === 1 ? 'person' : 'people'}.</strong>
                {importResult.warnings.length > 0 && (
                  <ul style={{ marginTop: 4, paddingLeft: 16, fontSize: 13 }}>
                    {importResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                )}
              </div>
            )}
            {importError && (
              <div className="alert alert-danger" style={{ marginTop: 'var(--space-md)' }}>{importError}</div>
            )}
          </div>

          {/* GEDCOM Export */}
          <div className="card" style={{ padding: 'var(--space-md) var(--space-lg)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-md)' }}>
            <div>
              <div style={{ fontWeight: 500, color: 'var(--navy)', marginBottom: 4 }}>{t('export.gedcomButton')}</div>
              <div style={{ fontSize: 13, color: 'var(--ink-muted)' }}>{t('export.gedcomDescription')}</div>
            </div>
            <button className="btn btn-outline btn-sm" onClick={handleExportGedcom} style={{ flexShrink: 0 }}>Export</button>
          </div>

          {/* Archive Export */}
          <div className="card" style={{ padding: 'var(--space-md) var(--space-lg)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-md)' }}>
            <div>
              <div style={{ fontWeight: 500, color: 'var(--navy)', marginBottom: 4 }}>{t('export.archiveButton')}</div>
              <div style={{ fontSize: 13, color: 'var(--ink-muted)' }}>{t('export.archiveDescription')}</div>
            </div>
            <button className="btn btn-outline btn-sm" onClick={handleExportArchive} style={{ flexShrink: 0 }}>Export</button>
          </div>
        </div>
      </div>

      {/* Privacy — Stage 5 */}
      <div className="settings-section">
        <h2 className="settings-section-title">{t('privacy.title')}</h2>
        <FamilyKeyPanel />
      </div>

      {/* Key recovery — Stage 5 */}
      <div className="settings-section">
        <h2 className="settings-section-title">{t('recovery.title')}</h2>
        <p style={{ fontSize: 14, color: 'var(--ink-soft)', marginBottom: 'var(--space-md)' }}>
          {t('recovery.supersession.description')}
        </p>
        <button className="btn btn-outline" onClick={() => setShowKeyRecovery(true)}>
          {t('recovery.title')}
        </button>
      </div>

      {/* App Updates */}
      {window.chronicleElectron?.isElectron && (
        <div className="settings-section">
          <h2 className="settings-section-title">App Updates</h2>
          <div className="card" style={{ padding: 'var(--space-md) var(--space-lg)' }}>

            {/* Current version */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-md)' }}>
              <div>
                <div style={{ fontWeight: 500, color: 'var(--navy)' }}>Chronicle</div>
                <div style={{ fontSize: 13, color: 'var(--ink-muted)' }}>
                  {appVersion ? <>Current version: <strong>v{appVersion}</strong></> : 'Loading version…'}
                </div>
              </div>
              <button
                className="btn btn-outline btn-sm"
                onClick={handleCheckForUpdate}
                disabled={checkingUpdate}
                style={{ flexShrink: 0 }}
              >
                {checkingUpdate ? 'Checking…' : 'Check for updates'}
              </button>
            </div>

            {/* Status display */}
            {updateStatus && (() => {
              const { type, currentVersion, newVersion, percent, message } = updateStatus
              if (type === 'checking') return (
                <div style={{ fontSize: 13, color: 'var(--ink-muted)' }}>
                  🔍 Checking for updates…
                </div>
              )
              if (type === 'up-to-date') return (
                <div style={{ fontSize: 13, color: '#4caf78' }}>
                  ✓ You're on the latest version{currentVersion ? ` (v${currentVersion})` : ''}.
                </div>
              )
              if (type === 'available') return (
                <div style={{ fontSize: 13, color: 'var(--gold)' }}>
                  ⬇ Update available — downloading v{newVersion}…
                  {currentVersion && <span style={{ color: 'var(--ink-muted)' }}> (you have v{currentVersion})</span>}
                </div>
              )
              if (type === 'downloading') return (
                <div style={{ fontSize: 13 }}>
                  <div style={{ color: 'var(--ink-muted)', marginBottom: 6 }}>
                    Downloading update… {percent ?? 0}%
                  </div>
                  <div style={{ background: 'var(--surface-raised)', borderRadius: 4, height: 6, overflow: 'hidden' }}>
                    <div style={{ background: 'var(--gold)', height: '100%', width: `${percent ?? 0}%`, transition: 'width 0.3s ease' }} />
                  </div>
                </div>
              )
              if (type === 'ready') return (
                <div>
                  <div style={{ fontSize: 13, marginBottom: 10 }}>
                    <span style={{ color: '#4caf78', fontWeight: 500 }}>✓ Ready to install</span>
                    {currentVersion && newVersion && (
                      <span style={{ color: 'var(--ink-muted)' }}>
                        {' '}— v{currentVersion} → <strong style={{ color: 'var(--ink)' }}>v{newVersion}</strong>
                      </span>
                    )}
                  </div>
                  <button className="btn btn-primary btn-sm" onClick={handleInstallUpdate}>
                    Restart and install v{newVersion}
                  </button>
                  <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 6 }}>
                    Chronicle will close, update, and reopen automatically.
                  </div>
                </div>
              )
              if (type === 'error') return (
                <div style={{ fontSize: 13, color: '#d06040' }}>
                  ✕ Update check failed: {message ?? 'Unknown error'}
                </div>
              )
              return null
            })()}
          </div>
        </div>
      )}

      {showAddContact && (
        <AddContactModal onSave={handleAddContact} onCancel={() => setShowAddContact(false)} />
      )}
      <KeyRecoveryModal show={showKeyRecovery} onHide={() => setShowKeyRecovery(false)} />
    </div>
  )
}
