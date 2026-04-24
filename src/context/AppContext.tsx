/**
 * Chronicle App Context — Stage 4
 *
 * Adds to Stage 3:
 * - ContactListManager: encrypted private contact list (kind 30090)
 * - MergeQueue: peer-online sync prompt / selective merge
 * - TrustRevocationStore: bad actor revocation tracking
 * - RelayTable: relay gossip aggregation
 * - JoinRequestQueue: inbound join request handling
 * - addContact() / removeContact() helpers
 * - reportBadActor() helper
 * - ingestPeerEvent() — routes incoming events to merge queue
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react'
import { store, MemoryStore, type StoredIdentity } from '../lib/storage'
import { generateUserKeyMaterial, importKeyMaterial, nsecToHex } from '../lib/keys'
import { encryptWithPassword, decryptWithPassword } from '../lib/storage'
import { RelayPool, type RelayStatus } from '../lib/relay'
import { broadcastQueue } from '../lib/queue'
import { startSync, fetchOnConnect } from '../lib/relaySync'
import { ContactListManager, type Contact } from '../lib/contactList'
import { MergeQueue, type SyncSession } from '../lib/syncMerge'
import { TrustRevocationStore, type TrustRevocation } from '../lib/trustRevocation'
import { RelayTable } from '../lib/relayGossip'
import { JoinRequestQueue, type JoinRequest } from '../lib/joinRequest'
import { generateFamilyKey, encodeFamilyKey, admitMember } from '../lib/privacyTier'
import { keyRecoveryStore } from '../lib/keyRecovery'
import { mediaCache, type MediaCacheEntry } from '../lib/blossom'
import type { KeyMaterial, ChronicleEvent } from '../types/chronicle'

// ─── Broadcast Target ─────────────────────────────────────────────────────────

export type BroadcastTarget = 'local' | 'shared' | 'discovery'

export interface BroadcastSettings {
  target: BroadcastTarget
  sharedRelayUrl: string
  discoveryRelayUrl: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const LOCAL_RELAY_URL = 'ws://127.0.0.1:4869'

// ─── Types ────────────────────────────────────────────────────────────────────

export type AppScreen =
  | 'onboarding-create'
  | 'onboarding-phrase'
  | 'onboarding-start'
  | 'onboarding-import'
  | 'onboarding-unlock'
  | 'main'

export interface SessionIdentity {
  npub: string
  nsec: string
  displayName: string
}

interface AppContextValue {
  screen: AppScreen
  setScreen: (s: AppScreen) => void
  session: SessionIdentity | null
  createIdentity: (displayName: string, password: string) => Promise<KeyMaterial>
  unlockIdentity: (password: string) => Promise<boolean>
  importIdentity: (input: string, displayName: string, password: string) => Promise<KeyMaterial>
  signOut: () => void
  hasStoredIdentity: boolean
  isGeneratingKey: boolean
  generatedMnemonic: string | null
  publishEvent: (event: ChronicleEvent) => void
  relayStatuses: Record<string, RelayStatus>
  localRelayUrl: string
  broadcastSettings: BroadcastSettings
  updateBroadcastSettings: (settings: Partial<BroadcastSettings>) => void
  syncStatus: 'idle' | 'syncing' | 'done' | 'error'
  // Stage 4
  contacts: Contact[]
  addContact: (npub: string, relay: string, displayName: string) => void
  removeContact: (npub: string) => void
  mergeSessions: SyncSession[]
  acceptMergeItem: (peerNpub: string, eventId: string) => void
  skipMergeItem: (peerNpub: string, eventId: string) => void
  acceptAllMerge: (peerNpub: string) => void
  skipAllMerge: (peerNpub: string) => void
  dismissMerge: (peerNpub: string) => void
  revocations: TrustRevocation[]
  reportBadActor: (revokedNpub: string, reason: string) => void
  isRevoked: (npub: string) => boolean
  joinRequests: JoinRequest[]
  acceptJoinRequest: (eventId: string) => void
  rejectJoinRequest: (eventId: string) => void
  knownRelays: string[]
  // Stage 5
  familyKey: Uint8Array | null
  hasFamilyKey: boolean
  initFamilyKey: () => void
  admitFamilyMember: (recipientNpub: string, recipientCurve25519Pub: Uint8Array) => Promise<void>
  isKeyRevoked: (npub: string, eventTimestamp: number) => boolean
  isKeyCompromised: (npub: string) => boolean
  mediaCacheEntries: MediaCacheEntry[]
  registerMedia: (ref: import('../types/chronicle').BlossomRef) => void
}

// ─── Context ──────────────────────────────────────────────────────────────────

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [screen, setScreen] = useState<AppScreen>('onboarding-create')
  const [session, setSession] = useState<SessionIdentity | null>(null)
  const [hasStoredIdentity, setHasStoredIdentity] = useState(false)
  const [isGeneratingKey, setIsGeneratingKey] = useState(false)
  const [generatedMnemonic, setGeneratedMnemonic] = useState<string | null>(null)
  const [relayStatuses, setRelayStatuses] = useState<Record<string, RelayStatus>>({})
  const poolRef = useRef<RelayPool | null>(null)
  const syncUnsubRef = useRef<(() => void) | null>(null)

  const [broadcastSettings, setBroadcastSettings] = useState<BroadcastSettings>({
    target: 'local',
    sharedRelayUrl: '',
    discoveryRelayUrl: '',
  })
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'done' | 'error'>('idle')

  // ── Stage 4 state ──────────────────────────────────────────────────────────
  const contactMgrRef = useRef<ContactListManager>(new ContactListManager())
  const mergeQueueRef = useRef<MergeQueue>(new MergeQueue())
  const revocationStoreRef = useRef<TrustRevocationStore>(new TrustRevocationStore())
  const relayTableRef = useRef<RelayTable>(new RelayTable())
  const joinQueueRef = useRef<JoinRequestQueue>(new JoinRequestQueue())

  const [contacts, setContacts] = useState<Contact[]>([])
  const [mergeSessions, setMergeSessions] = useState<SyncSession[]>([])
  const [revocations, setRevocations] = useState<TrustRevocation[]>([])
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([])
  const [knownRelays, setKnownRelays] = useState<string[]>([LOCAL_RELAY_URL])
  // Stage 5
  const [familyKey, setFamilyKey] = useState<Uint8Array | null>(null)
  const [mediaCacheEntries, setMediaCacheEntries] = useState<MediaCacheEntry[]>([])

  // ── Contact helpers ────────────────────────────────────────────────────────

  const addContact = useCallback((npub: string, relay: string, displayName: string) => {
    contactMgrRef.current.add({ npub, relay, displayName, trusted: true })
    relayTableRef.current.addKnown(relay, npub)
    setContacts([...contactMgrRef.current.getAll()])
    setKnownRelays(relayTableRef.current.getRanked())
  }, [])

  const removeContact = useCallback((npub: string) => {
    contactMgrRef.current.remove(npub)
    setContacts([...contactMgrRef.current.getAll()])
  }, [])

  // ── Merge queue helpers ────────────────────────────────────────────────────

  const refreshMergeSessions = useCallback(() => {
    setMergeSessions([...mergeQueueRef.current.getAllSessions()])
  }, [])

  const acceptMergeItem = useCallback((peerNpub: string, eventId: string) => {
    mergeQueueRef.current.acceptItem(peerNpub, eventId)
    refreshMergeSessions()
  }, [refreshMergeSessions])

  const skipMergeItem = useCallback((peerNpub: string, eventId: string) => {
    mergeQueueRef.current.skipItem(peerNpub, eventId)
    refreshMergeSessions()
  }, [refreshMergeSessions])

  const acceptAllMerge = useCallback((peerNpub: string) => {
    mergeQueueRef.current.acceptAll(peerNpub)
    refreshMergeSessions()
  }, [refreshMergeSessions])

  const skipAllMerge = useCallback((peerNpub: string) => {
    mergeQueueRef.current.skipAll(peerNpub)
    refreshMergeSessions()
  }, [refreshMergeSessions])

  const dismissMerge = useCallback((peerNpub: string) => {
    mergeQueueRef.current.dismiss(peerNpub)
    refreshMergeSessions()
  }, [refreshMergeSessions])

  // ── Trust revocation helpers ───────────────────────────────────────────────

  const reportBadActor = useCallback((revokedNpub: string, reason: string) => {
    const rev: TrustRevocation = {
      revokerNpub: session?.npub ?? '',
      revokedNpub,
      reason,
      createdAt: Math.floor(Date.now() / 1000),
      eventId: `local-rev-${Date.now()}`,
      endorsedBy: [],
    }
    revocationStoreRef.current.add(rev)
    setRevocations([...revocationStoreRef.current.getAll()])
  }, [session])

  const isRevoked = useCallback((npub: string) => {
    return revocationStoreRef.current.isRevoked(npub)
  }, [])

  // ── Join request helpers ───────────────────────────────────────────────────

  const acceptJoinRequest = useCallback((eventId: string) => {
    const req = joinQueueRef.current.get(eventId)
    joinQueueRef.current.accept(eventId)
    if (req) addContact(req.requesterNpub, req.requesterRelay, req.displayName)
    setJoinRequests([...joinQueueRef.current.getAll()])
  }, [addContact])

  const rejectJoinRequest = useCallback((eventId: string) => {
    joinQueueRef.current.reject(eventId)
    setJoinRequests([...joinQueueRef.current.getAll()])
  }, [])

  // ── BroadcastSettings ─────────────────────────────────────────────────────

  const updateBroadcastSettings = useCallback((settings: Partial<BroadcastSettings>) => {
    setBroadcastSettings(prev => {
      const next = { ...prev, ...settings }
      if (poolRef.current) {
        const pool = poolRef.current
        if (next.target !== 'local' && next.sharedRelayUrl && next.target === 'shared') {
          pool.add(next.sharedRelayUrl).connect()
        } else if (prev.sharedRelayUrl && prev.sharedRelayUrl !== next.sharedRelayUrl) {
          pool.remove(prev.sharedRelayUrl)
        }
        if (next.target === 'discovery' && next.discoveryRelayUrl) {
          pool.add(next.discoveryRelayUrl).connect()
        } else if (prev.discoveryRelayUrl && prev.target === 'discovery' && next.target !== 'discovery') {
          pool.remove(prev.discoveryRelayUrl)
        }
        setRelayStatuses({ ...pool.getStatuses() })
      }
      return next
    })
  }, [])

  // ── Store restore on mount ─────────────────────────────────────────────────

  useEffect(() => {
    try {
      const saved = localStorage.getItem('chronicle:store')
      if (saved) {
        const restored = MemoryStore.deserialise(saved)
        const identity = restored.getIdentity()
        if (identity) {
          store.setIdentity(identity)
          for (const p of restored.getAllPersons()) store.upsertPerson(p)
          setHasStoredIdentity(true)
          setScreen('onboarding-unlock')
        }
      }
    } catch {
      // Fresh start
    }
  }, [])

  const persistStore = useCallback(() => {
    try {
      localStorage.setItem('chronicle:store', store.serialise())
    } catch { /* silent */ }
  }, [])

  // ── Relay lifecycle ────────────────────────────────────────────────────────

  const allowlistAdd = useCallback(async (npubOrHex: string): Promise<void> => {
    try {
      await fetch('http://127.0.0.1:4869/allowlist/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: npubOrHex }),
      })
    } catch {
      // Non-fatal — relay may not be running
    }
  }, [])

  const startRelay = useCallback(() => {
    if (poolRef.current) return
    const pool = new RelayPool()
    pool.add(LOCAL_RELAY_URL)
    poolRef.current = pool

    const client = pool.add(LOCAL_RELAY_URL)
    client.onStatusChange((status) => {
      setRelayStatuses({ ...pool.getStatuses() })
      if (status === 'connected' && !syncUnsubRef.current) {
        setSyncStatus('syncing')
        fetchOnConnect(client).then(() => setSyncStatus('done')).catch(() => setSyncStatus('error'))
        syncUnsubRef.current = startSync(client)
      }
    })

    broadcastQueue.attachToRelay(client)
    pool.connect()
    setRelayStatuses(pool.getStatuses())
  }, [])

  const stopRelay = useCallback(() => {
    syncUnsubRef.current?.()
    syncUnsubRef.current = null
    setSyncStatus('idle')
    poolRef.current?.destroy()
    poolRef.current = null
    setRelayStatuses({})
  }, [])

  // ── Session helpers ────────────────────────────────────────────────────────

  const beginSession = useCallback(
    (npub: string, nsec: string, displayName: string) => {
      setSession({ npub, nsec, displayName })
      setScreen('main')
      startRelay()
      // Load contact list if stored
      try {
        const saved = localStorage.getItem('chronicle:contacts')
        if (saved) {
          const nsecHex = nsecToHex(nsec)
          const mgr = ContactListManager.fromEncrypted(saved, nsecHex)
          if (mgr) {
            contactMgrRef.current = mgr
            setContacts([...mgr.getAll()])
          }
        }
      } catch { /* non-fatal */ }
    },
    [startRelay],
  )

  // ── createIdentity ─────────────────────────────────────────────────────────

  const createIdentity = useCallback(
    async (displayName: string, password: string): Promise<KeyMaterial> => {
      setIsGeneratingKey(true)
      try {
        const km = generateUserKeyMaterial()
        setGeneratedMnemonic(km.mnemonic)
        const encryptedNsec = await encryptWithPassword(km.nsec, password)
        const identity: StoredIdentity = {
          npub: km.npub,
          displayName,
          encryptedNsec,
          createdAt: Math.floor(Date.now() / 1000),
        }
        store.setIdentity(identity)
        store.upsertPerson({
          pubkey: km.npub,
          displayName,
          isLiving: true,
          createdAt: Math.floor(Date.now() / 1000),
        })
        void allowlistAdd(km.npub)
        setSession({ npub: km.npub, nsec: km.nsec, displayName })
        setHasStoredIdentity(true)
        persistStore()
        return km
      } finally {
        setIsGeneratingKey(false)
      }
    },
    [persistStore, allowlistAdd],
  )

  // ── unlockIdentity ─────────────────────────────────────────────────────────

  const unlockIdentity = useCallback(
    async (password: string): Promise<boolean> => {
      const identity = store.getIdentity()
      if (!identity) return false
      const nsec = await decryptWithPassword(identity.encryptedNsec, password)
      if (!nsec) return false
      beginSession(identity.npub, nsec, identity.displayName)
      return true
    },
    [beginSession],
  )

  // ── importIdentity ─────────────────────────────────────────────────────────

  const importIdentity = useCallback(
    async (input: string, displayName: string, password: string): Promise<KeyMaterial> => {
      const km = importKeyMaterial(input)
      const encryptedNsec = await encryptWithPassword(km.nsec, password)
      const identity: StoredIdentity = {
        npub: km.npub,
        displayName,
        encryptedNsec,
        createdAt: Math.floor(Date.now() / 1000),
      }
      store.setIdentity(identity)
      store.upsertPerson({
        pubkey: km.npub,
        displayName,
        isLiving: true,
        createdAt: Math.floor(Date.now() / 1000),
      })
      void allowlistAdd(km.npub)
      setGeneratedMnemonic(null)   // clear any stale mnemonic from a prior create-identity attempt
      setHasStoredIdentity(true)
      persistStore()
      beginSession(km.npub, km.nsec, displayName)
      return km
    },
    [persistStore, allowlistAdd, beginSession],
  )

  // ── signOut ────────────────────────────────────────────────────────────────

  const signOut = useCallback(() => {
    stopRelay()
    setSession(null)
    setGeneratedMnemonic(null)
    setScreen('onboarding-create')
    contactMgrRef.current = new ContactListManager()
    mergeQueueRef.current = new MergeQueue()
    revocationStoreRef.current = new TrustRevocationStore()
    relayTableRef.current = new RelayTable()
    joinQueueRef.current = new JoinRequestQueue()
    setContacts([])
    setMergeSessions([])
    setRevocations([])
    setJoinRequests([])
    setKnownRelays([LOCAL_RELAY_URL])
  }, [stopRelay])

  // ── publishEvent ───────────────────────────────────────────────────────────

  const publishEvent = useCallback((event: ChronicleEvent) => {
    store.addRawEvent(event)
    broadcastQueue.enqueue(event)
    if (poolRef.current) broadcastQueue.drain(poolRef.current)
    persistStore()
  }, [persistStore])

  // ── Start relay when reaching main ─────────────────────────────────────────

  useEffect(() => {
    if (screen === 'main' && !poolRef.current) {
      startRelay()
    }
  }, [screen, startRelay])

  // ── Stage 5: family key helpers ─────────────────────────────────────────────

  const initFamilyKey = useCallback(() => {
    const key = generateFamilyKey()
    setFamilyKey(key)
    // Persist encoded key in localStorage (encrypted at rest via storage layer in full impl)
    localStorage.setItem('chronicle_family_key', encodeFamilyKey(key))
  }, [])

  const admitFamilyMember = useCallback(async (
    recipientNpub: string,
    recipientCurve25519Pub: Uint8Array,
  ) => {
    if (!familyKey || !session) return
    await admitMember(familyKey, session.nsec, recipientCurve25519Pub, recipientNpub)
    // In full impl: publish FAMILY_KEY_ADMISSION event via relay
  }, [familyKey, session])

  const isKeyRevoked = useCallback((npub: string, eventTimestamp: number) => {
    return keyRecoveryStore.isRevoked(npub, eventTimestamp)
  }, [])

  const isKeyCompromised = useCallback((npub: string) => {
    return keyRecoveryStore.isCompromised(npub)
  }, [])

  const registerMedia = useCallback((ref: import('../types/chronicle').BlossomRef) => {
    mediaCache.register(ref)
    setMediaCacheEntries((prev) => [...prev, { ref, status: 'pending' as const }])
  }, [])

  return (
    <AppContext.Provider
      value={{
        screen,
        setScreen,
        session,
        createIdentity,
        unlockIdentity,
        importIdentity,
        signOut,
        hasStoredIdentity,
        isGeneratingKey,
        generatedMnemonic,
        publishEvent,
        relayStatuses,
        localRelayUrl: LOCAL_RELAY_URL,
        broadcastSettings,
        updateBroadcastSettings,
        syncStatus,
        // Stage 4
        contacts,
        addContact,
        removeContact,
        mergeSessions,
        acceptMergeItem,
        skipMergeItem,
        acceptAllMerge,
        skipAllMerge,
        dismissMerge,
        revocations,
        reportBadActor,
        isRevoked,
        joinRequests,
        acceptJoinRequest,
        rejectJoinRequest,
        knownRelays,
        // Stage 5
        familyKey,
        hasFamilyKey: familyKey !== null,
        initFamilyKey,
        admitFamilyMember,
        isKeyRevoked,
        isKeyCompromised,
        mediaCacheEntries,
        registerMedia,
      }}
    >
      {children}
    </AppContext.Provider>
  )
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside AppProvider')
  return ctx
}
