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
import { generateUserKeyMaterial, importKeyMaterial, nsecToHex, npubToHex } from '../lib/keys'
import { encryptWithPassword, decryptWithPassword } from '../lib/storage'
import { RelayPool, type RelayStatus } from '../lib/relay'
import { broadcastQueue } from '../lib/queue'
import { startSync, fetchOnConnect, setJoinRequestHandler, setJoinAcceptHandler, replayPendingJoinRequests, replayStoredFactClaims, setContactPubkeysProvider, setSyncUpdateHandler } from '../lib/relaySync'
import { buildJoinRequestEvent, buildJoinAcceptEvent, buildRelationshipClaim } from '../lib/eventBuilder'
import { ContactListManager, type Contact } from '../lib/contactList'
import { MergeQueue, type SyncSession } from '../lib/syncMerge'
import { TrustRevocationStore, type TrustRevocation } from '../lib/trustRevocation'
import { RelayTable } from '../lib/relayGossip'
import { JoinRequestQueue, type JoinRequest } from '../lib/joinRequest'
import { generateFamilyKey, encodeFamilyKey, admitMember } from '../lib/privacyTier'
import { serialiseGraph, deserialiseGraph, retractRelationship, getRelationshipsFor, getAllRelationships } from '../lib/graph'
import { storageGet, storageSet } from '../lib/appStorage'
import { keyRecoveryStore } from '../lib/keyRecovery'
import { mediaCache, type MediaCacheEntry } from '../lib/blossom'
import type { KeyMaterial, ChronicleEvent } from '../types/chronicle'

// ─── Broadcast Target ─────────────────────────────────────────────────────────

// Broadcast tiers:
// 'peers'     — publish directly to connected family members (default, P2P)
// 'shared'    — also publish to a shared relay (persistent store, offline delivery,
//               backup/recovery) — URL configured by user
// 'discovery' — also publish minimal events to a public relay for distant relative
//               discovery (name fragment + relay address only, no ancestry data)
export type BroadcastTarget = 'peers' | 'shared' | 'discovery'

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
  /** Increments every time remote sync delivers new data — components use this to re-render */
  syncVersion: number
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
  /** Re-publishes all relationship events from the local graph with correct tags.
   *  Fixes relationships stored before v1.0.79 that lacked the 'related' tag. */
  repairRelationships: () => void
  repushAllEvents: () => void
  /** Immediately triggers a duplicate scan regardless of incoming events. */
  triggerDupesScan: () => void
}

// ─── Context ──────────────────────────────────────────────────────────────────

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [screen, setScreen] = useState<AppScreen>('onboarding-create')
  const [session, setSession] = useState<SessionIdentity | null>(null)
  // sessionRef mirrors session state synchronously — useCallback closures
  // can read this without stale-closure issues
  const sessionRef = useRef<SessionIdentity | null>(null)
  const setSessionWithRef = useCallback((s: SessionIdentity | null) => {
    sessionRef.current = s
    setSession(s)
  }, [])
  const [hasStoredIdentity, setHasStoredIdentity] = useState(false)
  const [isGeneratingKey, setIsGeneratingKey] = useState(false)
  const [generatedMnemonic, setGeneratedMnemonic] = useState<string | null>(null)
  const [relayStatuses, setRelayStatuses] = useState<Record<string, RelayStatus>>({})
  const poolRef = useRef<RelayPool | null>(null)
  const syncUnsubRef = useRef<(() => void) | null>(null)

  const [broadcastSettings, setBroadcastSettings] = useState<BroadcastSettings>({
    target: 'peers',
    sharedRelayUrl: '',
    discoveryRelayUrl: '',
  })
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'done' | 'error'>('idle')
  const [syncVersion, setSyncVersion] = useState(0)

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
      // The relay requires a 64-char hex pubkey. Convert from npub if needed.
      let hexPubkey = npubOrHex
      if (npubOrHex.startsWith('npub1')) {
        try { hexPubkey = npubToHex(npubOrHex) } catch { return }
      }
      if (hexPubkey.length !== 64) return  // not a valid hex pubkey

      // In Electron: use IPC which writes the allowlist file directly AND
      // retries the HTTP call until the relay is up. This handles the case
      // where allowlistAdd is called before the relay HTTP server is ready.
      const electron = typeof window !== 'undefined' && (window as any).chronicleElectron
      if (electron?.allowlistAdd) {
        console.log('[allowlistAdd] calling IPC with hex:', hexPubkey.slice(0, 8) + '…')
        const result = await electron.allowlistAdd(hexPubkey)
        console.log('[allowlistAdd] IPC result:', result)
        return
      }
      console.log('[allowlistAdd] no IPC available, using HTTP fetch')

      // Browser dev mode fallback — relay must already be running
      await fetch(`http://127.0.0.1:${_relayPort}/allowlist/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: hexPubkey }),
      })
    } catch { /* non-fatal */ }
  }, [])

  // connectToRelay declared before addContact — addContact depends on it.
  const connectToRelay = useCallback((url: string, pool: InstanceType<typeof RelayPool>) => {
    // Never connect to external relays without an active session — prevents
    // instance 1 from connecting to instance 2's relay before instance 2 logs in
    if (!sessionRef.current) return
    const existing = pool.getStatuses()
    if (url in existing) return  // already added (may still be connecting)
    const client = pool.add(url)
    console.log(`[connectToRelay] added ${url}, status=${client.getStatus()}`)
    client.onStatusChange((status) => {
      console.log(`[connectToRelay] ${url} status → ${status}`)
      setRelayStatuses({ ...pool.getStatuses() })
      if (status === 'connected') {
        const ownEvents = store.getAllRawEvents()
        console.log(`[connectToRelay] connected to ${url}, pushing ${ownEvents.length} own events, fetching remote`)
        // Pull events from this relay authored by known pubkeys (including contacts)
        fetchOnConnect(client).then(() => replayStoredFactClaims()).catch((e) => console.error('[connectToRelay] fetchOnConnect error:', e))
        startSync(client)
        // Push our own events to this relay so the remote instance can see our tree data
        for (const event of ownEvents) {
          client.publish(event)
        }
        console.log(`[connectToRelay] push complete`)
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
    if (poolRef.current) {
      connectToRelay(relay, poolRef.current)
      // Re-fetch from all connected relays with updated pubkey list so we
      // immediately pull in the new contact's events
      for (const [url] of Object.entries(poolRef.current.getStatuses())) {
        const client = poolRef.current.add(url)
        if (client.getStatus() === 'connected') {
          fetchOnConnect(client).then(() => replayStoredFactClaims()).catch(() => {})
        }
      }
    }
    // Always allowlist a contact
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
        // Shared relay — connect when URL is set and target is 'shared' or 'discovery'
        if (next.sharedRelayUrl && (next.target === 'shared' || next.target === 'discovery')) {
          const client = pool.add(next.sharedRelayUrl)
          client.connect()
          broadcastQueue.attachToRelay(client)
        } else if (prev.sharedRelayUrl && prev.sharedRelayUrl !== next.sharedRelayUrl) {
          pool.remove(prev.sharedRelayUrl)
        }
        // Discovery relay — connect when URL is set and target is 'discovery'
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
            // Clear singleton store before restoring — prevents stale data from
            // a previous partial load (e.g. partially-migrated v1.0.86 data)
            // accumulating alongside the freshly-migrated records.
            store.clearAll()
            store.setIdentity(identity)
            // Restore persons from migration-cleaned data.
            // Deduplicate: if the same person appears under both old npub key
            // and a new UUID key (partial v1.0.87 run), keep the one whose id
            // matches a raw-event subject tag (more likely to be correct).
            for (const p of restored.getAllPersons()) store.upsertPerson(p)
            // Restore aliases from migration
            for (const alias of restored.getAllAliases()) store.addPersonAlias(alias)
            for (const c of restored.getAllClaims()) store.addClaim(c)
            for (const e of restored.getAllEndorsements()) store.addEndorsement(e)
            for (const ev of restored.getAllRawEvents()) store.addRawEvent(ev)
            // Backfill display names for any person stub whose name fact claim
            // was stored before the stub existed (shows as 'Unknown').
            replayStoredFactClaims()
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

  const startRelayStarting = useRef(false)
  const startRelay = useCallback(async () => {
    if (poolRef.current) return
    if (startRelayStarting.current) return  // prevent double-start during async await
    startRelayStarting.current = true

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
    startRelayStarting.current = false

    // Provide contact pubkeys to relaySync so it includes them in subscription
    // filters — without this, each instance only fetches events from pubkeys
    // it already knows locally, and never sees the other instance's tree data.
    setContactPubkeysProvider(() => contactMgrRef.current.getAll().map(c => c.npub))
    setSyncUpdateHandler(() => {
      replayStoredFactClaims()
      setSyncVersion(v => v + 1)
      // Persist after every sync batch so raw events and updated display names
      // survive app restarts. Without this, synced data (names, facts, relationships)
      // is lost on close because persistStore was only called at session start.
      persistStore()
    })

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
        fetchOnConnect(client).then(() => { replayStoredFactClaims(); setSyncStatus('done') }).catch(() => setSyncStatus('error'))
        syncUnsubRef.current = startSync(client)
      }
    })

    broadcastQueue.attachToRelay(client)
    pool.connect()
    setRelayStatuses(pool.getStatuses())

    // Connect to contact relays after the local relay is established.
    // Contact relay connections happen in beginSession after contacts are
    // loaded from storage — not here, because contacts aren't available yet
    // at the time startRelay runs.
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
      setSessionWithRef({ npub, nsec, displayName })
      setScreen('main')
      startRelay()
      // Allowlist own pubkey immediately — this is the most critical call.
      // Without it the relay blocks ALL events including our own.
      void allowlistAdd(npub)
      // Load contact list if stored
      void storageGet('chronicle:contacts').then(saved => {
        try {
          if (saved) {
            const nsecHex = nsecToHex(nsec)
            const mgr = ContactListManager.fromEncrypted(saved, nsecHex)
            if (mgr) {
              contactMgrRef.current = mgr
              setContacts([...mgr.getAll()])
              // Allowlist all saved contacts so their events are accepted
              for (const c of mgr.getAll()) {
                void allowlistAdd(c.npub)
              }
              // Connect to contact relays now that we have the list and
              // the session is confirmed active. Use a short delay to let
              // the local relay connection establish first.
              const pool = poolRef.current
              if (pool) {
                setTimeout(() => {
                  if (poolRef.current !== pool) return // session ended
                  for (const c of mgr.getAll()) {
                    connectToRelay(c.relay, pool)
                  }
                }, 2000)
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
        store.upsertPerson({ id: km.npub,
          displayName,
          isLiving: true,
          createdAt: Math.floor(Date.now() / 1000),
        })
        void allowlistAdd(km.npub)
        setSessionWithRef({ npub: km.npub, nsec: km.nsec, displayName })
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
      store.upsertPerson({ id: km.npub,
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
    setSessionWithRef(null)
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

  // ── repushAllEvents ────────────────────────────────────────────────────────
  // Forces a re-push of every raw event in the local store to all currently
  // connected relays. Use this when a contact's relay has restarted and lost
  // events — the relay's in-memory store is cleared on restart, so any events
  // published before the restart are gone.

  const repushAllEvents = useCallback(() => {
    const pool = poolRef.current
    if (!pool) return
    const all = store.getAllRawEvents()
    let count = 0
    for (const event of all) {
      pool.publish(event)
      count++
    }
    console.log(`[repushAllEvents] pushed ${count} events to all connected relays`)
  }, [])

  // ── repairRelationships ────────────────────────────────────────────────────
  // Re-publishes all locally-known relationship claims with the correct 'related'
  // tag. Needed for events stored before v1.0.79 when that tag was missing,
  // which caused remote instances to silently discard them on ingest.

  const repairRelationships = useCallback(() => {
    const sess = sessionRef.current
    if (!sess) return
    const allRels = getAllRelationships()
    let repaired = 0
    for (const rel of allRels) {
      if (rel.retracted) continue
      // Only re-publish relationships claimed by this session's own key
      if (rel.claimantPubkey !== sess.npub) continue
      const ev = buildRelationshipClaim({
        claimantNpub: sess.npub,
        claimantNsec: sess.nsec,
        subjectId: rel.subjectId,
        relatedId: rel.relatedId,
        relationship: rel.relationship,
        sensitive: rel.sensitive,
      })
      store.addRawEvent(ev)
      broadcastQueue.enqueue(ev)
      repaired++
    }
    if (poolRef.current) broadcastQueue.drain(poolRef.current)
    console.log(`[repairRelationships] re-published ${repaired} relationship events`)
  }, [])

  // ── triggerDupesScan ────────────────────────────────────────────────────────

  const triggerDupesScan = useCallback(() => {
    // Signal via syncVersion bump — PossibleMatchesPanel watches this
    setSyncVersion(v => v + 1)
  }, [])

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
        syncVersion,
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
        repairRelationships,
        repushAllEvents,
        triggerDupesScan,
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
