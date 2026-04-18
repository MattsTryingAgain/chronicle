/**
 * Chronicle App Shell — Stage 6
 * Added: About tab, NewVersionBanner (schema version prompt),
 *        ContentDisputeModal wiring, conflict history access
 */

import { useTranslation } from 'react-i18next'
import { AppProvider, useApp } from './context/AppContext'
import { Onboarding } from './components/Onboarding'
import { UnlockScreen } from './components/UnlockScreen'
import { TreeView } from './components/TreeView'
import { SettingsView } from './components/SettingsView'
import FamilyTreeView from './components/FamilyTreeView'
import { InviteModal } from './components/InviteModal'
import { ContactListView } from './components/ContactListView'
import { SyncMergePrompt } from './components/SyncMergePrompt'
import { JoinRequestView } from './components/JoinRequestView'
import { TrustRevocationModal } from './components/TrustRevocationModal'
import { AboutView } from './components/AboutView'
import { NewVersionBanner } from './components/NewVersionBanner'
import { useState, useEffect } from 'react'
import { schemaVersionChecker } from './lib/schemaVersion'
import './chronicle.css'

type Tab = 'tree' | 'graph' | 'connect' | 'settings' | 'about'

function RelayDot() {
  const { relayStatuses } = useApp()
  const statuses = Object.values(relayStatuses)
  const anyConnected = statuses.includes('connected')
  const anyConnecting = statuses.includes('connecting')
  const colour = anyConnected ? '#3a6b3a' : anyConnecting ? '#8b6000' : '#8a7d6a'
  const title = anyConnected ? 'Relay connected' : anyConnecting ? 'Connecting…' : 'Relay offline'
  return (
    <div
      title={title}
      style={{
        width: 8, height: 8, borderRadius: '50%', background: colour, flexShrink: 0,
        boxShadow: anyConnected ? '0 0 0 2px rgba(58,107,58,0.25)' : undefined,
      }}
    />
  )
}

function ConnectTab() {
  const { t } = useTranslation()
  const {
    session, localRelayUrl, contacts, addContact, removeContact,
    joinRequests, acceptJoinRequest, rejectJoinRequest, reportBadActor,
  } = useApp()

  const [showInvite, setShowInvite] = useState(false)
  const [revocationTarget, setRevocationTarget] = useState<{ npub: string; name: string } | null>(null)

  if (!session) return null

  return (
    <div className="p-3">
      <JoinRequestView
        requests={joinRequests}
        onAccept={acceptJoinRequest}
        onReject={rejectJoinRequest}
      />

      <div className="d-flex align-items-center justify-content-between mb-3">
        <h6 className="mb-0" style={{ color: 'var(--gold)' }}>{t('contacts.title')}</h6>
        <button className="btn btn-sm btn-primary" onClick={() => setShowInvite(true)}>
          + {t('invite.title')}
        </button>
      </div>

      <ContactListView contacts={contacts} onRemove={removeContact} />

      {contacts.length > 0 && (
        <div className="mt-3">
          <p className="text-muted small mb-1">
            If someone is not a genuine family member, you can report them.
          </p>
          {contacts.map(c => (
            <button
              key={c.npub}
              className="btn btn-sm btn-outline-danger w-100 text-start mb-1"
              onClick={() => setRevocationTarget({ npub: c.npub, name: c.displayName })}
            >
              {t('trust.revoke.title')}: {c.displayName}
            </button>
          ))}
        </div>
      )}

      <InviteModal
        show={showInvite}
        onClose={() => setShowInvite(false)}
        userHexPubkey={session.npub}
        relayUrl={localRelayUrl}
        onIncomingInvite={(npub, relay) => {
          addContact(npub, relay, npub.slice(0, 12) + '…')
          setShowInvite(false)
        }}
      />

      {revocationTarget && (
        <TrustRevocationModal
          show={true}
          targetNpub={revocationTarget.npub}
          targetDisplayName={revocationTarget.name}
          onConfirm={(reason) => { reportBadActor(revocationTarget.npub, reason); setRevocationTarget(null) }}
          onClose={() => setRevocationTarget(null)}
        />
      )}
    </div>
  )
}

function MainShell() {
  const { t } = useTranslation()
  const { session, mergeSessions, acceptMergeItem, skipMergeItem, acceptAllMerge, skipAllMerge, dismissMerge } = useApp()
  const [tab, setTab] = useState<Tab>('tree')
  const [graphRoot, setGraphRoot] = useState<string | null>(null)
  const [showVersionBanner, setShowVersionBanner] = useState(false)

  // Poll schema version checker — banner appears if a newer-version event is seen
  useEffect(() => {
    const interval = setInterval(() => {
      setShowVersionBanner(schemaVersionChecker.shouldShowPrompt)
    }, 5000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="app-shell">
      {/* New-version soft prompt */}
      {showVersionBanner && (
        <NewVersionBanner onDismiss={() => {
          schemaVersionChecker.dismiss()
          setShowVersionBanner(false)
        }} />
      )}

      <nav className="app-nav">
        <span className="app-nav-logo">Chr<span style={{ color: 'var(--gold)' }}>on</span>icle</span>
        <div className="app-nav-tabs">
          <button className={`app-nav-tab${tab === 'tree' ? ' active' : ''}`} onClick={() => setTab('tree')}>
            {t('nav.tree')}
          </button>
          <button
            className={`app-nav-tab${tab === 'graph' ? ' active' : ''}`}
            onClick={() => { setTab('graph'); if (!graphRoot && session?.npub) setGraphRoot(session.npub) }}
          >
            {t('nav.graph', { defaultValue: 'Family Tree' })}
          </button>
          <button className={`app-nav-tab${tab === 'connect' ? ' active' : ''}`} onClick={() => setTab('connect')}>
            Connect
          </button>
          <button className={`app-nav-tab${tab === 'settings' ? ' active' : ''}`} onClick={() => setTab('settings')}>
            {t('nav.settings')}
          </button>
          <button className={`app-nav-tab${tab === 'about' ? ' active' : ''}`} onClick={() => setTab('about')}>
            {t('nav.about')}
          </button>
        </div>
        <RelayDot />
      </nav>

      <main className="app-content" style={{ padding: tab === 'graph' ? 0 : undefined }}>
        {tab === 'tree' && <TreeView onSelectPerson={(pk) => { setGraphRoot(pk); setTab('graph') }} />}
        {tab === 'graph' && graphRoot && <FamilyTreeView rootPubkey={graphRoot} onSelectPerson={(pk) => setGraphRoot(pk)} />}
        {tab === 'graph' && !graphRoot && (
          <div className="p-4 text-muted">
            {t('tree.noRoot', { defaultValue: 'Select a person from the People list to view their family tree.' })}
          </div>
        )}
        {tab === 'connect' && <ConnectTab />}
        {tab === 'settings' && <SettingsView />}
        {tab === 'about' && <AboutView />}
      </main>

      <SyncMergePrompt
        sessions={mergeSessions}
        onAcceptItem={acceptMergeItem}
        onSkipItem={skipMergeItem}
        onAcceptAll={acceptAllMerge}
        onSkipAll={skipAllMerge}
        onDismiss={dismissMerge}
      />
    </div>
  )
}

function AppRouter() {
  const { screen } = useApp()
  if (screen === 'main') return <MainShell />
  if (screen === 'onboarding-unlock') return <UnlockScreen />
  return <Onboarding />
}

export default function App() {
  return <AppProvider><AppRouter /></AppProvider>
}
