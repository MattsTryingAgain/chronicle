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
import { startSync, fetchOnConnect, setJoinRequestHandler, setJoinAcceptHandler, replayPendingJoinRequests } from '../lib/relaySync'
import { buildJoinRequestEvent, buildJoinAcceptEvent } from '../lib/eventBuilder'
import { ContactListManager, type Contact } from '../lib/contactList'
import { MergeQueue, type SyncSession } from '../lib/syncMerge'
import { TrustRevocationStore, type TrustRevocation } from '../lib/trustRevocation'
import { RelayTable } from '../lib/relayGossip'
import { JoinRequestQueue, type JoinRequest } from '../lib/joinRequest'
import { generateFamilyKey, encodeFamilyKey, admitMember } from '../lib/privacyTier'
import { serialiseGraph, deserialiseGraph, retractRelationship, getRelationshipsFor } from '../lib/graph'
import { storageGet, storageSet } from '../lib/appStorage'
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

// Relay port is 4869 for the primary instance, 4870 for --instance=2, etc.
// In Electron the preload exposes a relayPort() function (async IPC call) so
// the main process can provide the correct port — process.argv is not available
// in sandboxed renderer processes, so we can't read the --instance flag directly.
// We resolve it once at module load and fall back to 4869 in browser/dev mode.
let _relayPort = 4869
export let LOCAL_RELAY_URL = `ws://127.0.0.1:${_relayPort}`

// Kick off the async resolution immediately — by the time the user reaches
// the main screen (after onboarding/unlock) the port will be resolved.
if (typeof window !== 'undefined' && (window as any).chronicleElectron?.relayPort) {
  ;(async () => {
    try {
      const port = await (window as any).chronicleElectron.relayPort()
      if (typeof port === 'number' && port > 0) {
        _relayPort = port
        LOCAL_RELAY_URL = `ws://127.0.0.1:${_relayPort}`
      }
    } catch { /* non-fatal */ }
  })()
}

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
  deletePerson: (pubkey: string) => void
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
  sendJoinRequest: (targetNpub: string, targetRelay: string) => void
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
  // allowlistAdd first — startRelay's handlers reference it before it would
  // otherwise be declared. connectToRelay second — addContact depends on it.
  const allowlistAdd = useCallback(async (npubOrHex: string): Promise<void> => {
    try {
      await fetch(`http://127.0.0.1:${_relayPort}/allowlist/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: npubOrHex }),
      })
    } catch { /* non-fatal — relay may not be running */ }
  }, [])

  // connectToRelay declared before addContact — addContact depends on it.
  const connectToRelay = useCallback((url: string, pool: InstanceType<typeof RelayPool>) => {
    const existing = pool.getStatuses()
    if (url in existing) return  // already added (may still be connecting)
    const client = pool.add(url)
    client.onStatusChange((status) => {
      setRelayStatuses({ ...pool.getStatuses() })
      if (status === 'connected') {
        fetchOnConnect(client).catch(() => {})
        startSync(client)
      }
    })
    broadcastQueue.attachToRelay(client)
    client.connect()
    setRelayStatuses({ ...pool.getStatuses() })
  }, [])

  // Add a contact and connect to their relay so events can flow both ways
  const addContactAndConnect = useCallback((npub: string, relay: string, pool: InstanceType<typeof RelayPool>) => {
    contactMgrRef.current.add({ npub, relay, displayName: npub.slice(0, 16) + '…', trusted: true })
    relayTableRef.current.addKnown(relay, npub)
    setContacts([...contactMgrRef.current.getAll()])
    setKnownRelays(relayTableRef.current.getRanked())
    if (pool) connectToRelay(relay, pool)
    if (session?.nsec) void storageSet('chronicle:contacts', contactMgrRef.current.encrypt(nsecToHex(session.nsec)))
  }, [connectToRelay, session])

  const addContact = useCallback((npub: string, relay: string, displayName: string) => {
    contactMgrRef.current.add({ npub, relay, displayName, trusted: true })
    relayTableRef.current.addKnown(relay, npub)
    setContacts([...contactMgrRef.current.getAll()])
    setKnownRelays(relayTableRef.current.getRanked())
    if (poolRef.current) connectToRelay(relay, poolRef.current)
    // Always allowlist a contact — covers the mutual-invite case where the
    // formal accept flow was bypassed (both sides generated invites)
    void allowlistAdd(npub)
    if (session?.nsec) void storageSet('chronicle:contacts', contactMgrRef.current.encrypt(nsecToHex(session.nsec)))
  }, [connectToRelay, session, allowlistAdd])

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

  const sendJoinRequest = useCallback((targetNpub: string, targetRelay: string) => {
    if (!session) return
    // Build and sign the join request event
    const event = buildJoinRequestEvent(
      session.npub, session.nsec,
      targetNpub, LOCAL_RELAY_URL,
      session.displayName || session.npub.slice(0, 16) + '…',
    )
    // Publish the join request directly to the target relay — NOT via the
    // broadcast queue, which publishes to all relays and would drain to our
    // own local relay first. We need it to go specifically to targetRelay.
    if (poolRef.current) {
      const pool = poolRef.current
      // pool.add() returns the existing client if already connected
      const client = pool.add(targetRelay)
      const publishWhenReady = () => {
        client.publish(event)
      }
      if (client.getStatus() === 'connected') {
        publishWhenReady()
      } else {
        // Wait for the connection then publish once
        const unsub = client.onStatusChange((status) => {
          if (status === 'connected') {
            unsub()
            publishWhenReady()
          }
        })
        client.connect()
      }
    }
    // Add them locally so the contact shows while the request is in flight
    addContact(targetNpub, targetRelay, targetNpub.slice(0, 16) + '…')
  }, [session, addContact])

  const acceptJoinRequest = useCallback((eventId: string) => {
    const req = joinQueueRef.current.get(eventId)
    joinQueueRef.current.accept(eventId)
    if (req && session) {
      // Add the requester's pubkey to our relay allowlist so their future
      // events are accepted (join request already got through as a special case)
      void allowlistAdd(req.requesterNpub)
      // Add them as a contact and connect to their relay
      addContact(req.requesterNpub, req.requesterRelay, req.displayName)
      // Publish a JOIN_ACCEPT event to the requester's relay
      const acceptEvent = buildJoinAcceptEvent(
        session.npub, session.nsec,
        req.requesterNpub, req.eventId,
        LOCAL_RELAY_URL,
      )
      if (poolRef.current) {
        const pool = poolRef.current
        const client = pool.add(req.requesterRelay)
        const publishAccept = () => { client.publish(acceptEvent) }
        if (client.getStatus() === 'connected') {
          publishAccept()
        } else {
          const unsub = client.onStatusChange((status) => {
            if (status === 'connected') { unsub(); publishAccept() }
          })
          client.connect()
        }
      }
    }
    setJoinRequests([...joinQueueRef.current.getPending()])
  }, [addContact, allowlistAdd, session, connectToRelay])

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
    const restore = async () => {
      try {
        const saved = await storageGet('chronicle:store')
        if (saved) {
          const restored = MemoryStore.deserialise(saved)
          const identity = restored.getIdentity()
          if (identity) {
            store.setIdentity(identity)
            for (const p of restored.getAllPersons()) store.upsertPerson(p)
            for (const c of restored.getAllClaims()) store.addClaim(c)
            for (const e of restored.getAllEndorsements()) store.addEndorsement(e)
            for (const ev of restored.getAllRawEvents()) store.addRawEvent(ev)
            setHasStoredIdentity(true)
            setScreen('onboarding-unlock')
          }
        }
        const savedGraph = await storageGet('chronicle:graph')
        if (savedGraph) {
          deserialiseGraph(JSON.parse(savedGraph))
        }
      } catch {
        // Fresh start
      }
    }
    void restore()
  }, [])

  const persistStore = useCallback(() => {
    const data = store.serialise()
    const graph = JSON.stringify(serialiseGraph())
    void storageSet('chronicle:store', data)
    void storageSet('chronicle:graph', graph)
  }, [])

  // ── Relay lifecycle ────────────────────────────────────────────────────────

  const startRelay = useCallback(async () => {
    if (poolRef.current) return

    // Resolve the relay port from the main process before connecting.
    // This ensures instance 2 uses 4870, not 4869.
    if (typeof window !== 'undefined' && (window as any).chronicleElectron?.relayPort) {
      try {
        const port = await (window as any).chronicleElectron.relayPort()
        if (typeof port === 'number' && port > 0) {
          _relayPort = port
          LOCAL_RELAY_URL = `ws://127.0.0.1:${_relayPort}`
        }
      } catch { /* non-fatal */ }
    }

    const pool = new RelayPool()
    poolRef.current = pool

    // Register join request/accept handlers so incoming events update the UI
    setJoinRequestHandler((req) => {
      joinQueueRef.current.add(req)
      setJoinRequests([...joinQueueRef.current.getPending()])
    })
    // Replay any join requests that arrived before the handler was registered
    // (e.g. events stored during a previous session or before app was ready)
    replayPendingJoinRequests()
    setJoinAcceptHandler((accept) => {
      // When we receive a JOIN_ACCEPT, add the acceptor to our allowlist
      // so they can publish events to our relay, then add them as a contact.
      void allowlistAdd(accept.acceptorNpub)
      addContactAndConnect(accept.acceptorNpub, accept.acceptorRelay, pool)
    })

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
  }, [connectToRelay])

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
      void storageGet('chronicle:contacts').then(saved => {
        try {
          if (saved) {
            const nsecHex = nsecToHex(nsec)
            const mgr = ContactListManager.fromEncrypted(saved, nsecHex)
            if (mgr) {
              contactMgrRef.current = mgr
              setContacts([...mgr.getAll()])
              // Reconnect to all known contact relays on session restore
              const allContacts = mgr.getAll()
              if (poolRef.current && allContacts.length > 0) {
                for (const c of allContacts) {
                  connectToRelay(c.relay, poolRef.current)
                }
              }
            }
          }
        } catch { /* non-fatal */ }
      })
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

  // ── deletePerson ───────────────────────────────────────────────────────────

  const deletePerson = useCallback((pubkey: string) => {
    // Remove from store
    store.deletePerson(pubkey)
    // Retract all relationships involving this person
    const rels = getRelationshipsFor(pubkey)
    for (const rel of rels) {
      retractRelationship(rel.eventId)
    }
    persistStore()
  }, [persistStore])

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
    // Persist encoded key (encrypted at rest via storage layer in full impl)
    void storageSet('chronicle_family_key', encodeFamilyKey(key))
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
        deletePerson,
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
        sendJoinRequest,
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
