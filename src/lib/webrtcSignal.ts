/**
 * WebRTC Signalling over Nostr Relay
 *
 * Uses the Chronicle relay as a signalling channel for WebRTC peer connections.
 * SDP offers/answers and ICE candidates are published as signed Nostr events
 * (kinds 30097–30099) tagged to a specific recipient npub.
 *
 * The PeerManager maintains all active PeerConnections. AppContext calls:
 *   - initiateWebRTC(targetNpub)   — Alice calls this to start a connection
 *   - onSignalEvent(event)         — called from ingestEvent for kinds 30097–30099
 *
 * Once a data channel is open, all locally stored raw events are sent to the
 * peer, and all events received are passed to ingestEvent.
 */

import { signEvent, npubToHex, hexToNpub } from './keys'
import { EventKind, SCHEMA_VERSION } from '../types/chronicle'
import { PeerConnection, type PeerState } from './webrtc'
import type { RelayClient } from './relay'
import type { ChronicleEvent } from '../types/chronicle'
import type { UnsignedEvent } from 'nostr-tools'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SignallingDeps {
  /** The session user's npub */
  myNpub: string
  /** The session user's nsec (for signing signal events) */
  myNsec: string
  /** The active relay client for publishing signal events */
  relayClient: RelayClient
  /** All raw stored events to push to a newly connected peer */
  getRawEvents: () => ChronicleEvent[]
  /** Called when a new event arrives from a peer */
  onPeerEvent: (event: ChronicleEvent) => void
  /** Called when peer connection state changes (for UI) */
  onPeerStateChange?: (peerId: string, state: PeerState) => void
}

// ─── PeerManager ─────────────────────────────────────────────────────────────

export class PeerManager {
  private deps: SignallingDeps
  /** Map from remote npub → PeerConnection */
  private peers = new Map<string, PeerConnection>()

  constructor(deps: SignallingDeps) {
    this.deps = deps
  }

  /**
   * Initiator side: create a WebRTC offer for targetNpub and publish it.
   * The remote peer will receive it via their relay subscription and respond.
   */
  async initiateWebRTC(targetNpub: string): Promise<void> {
    // Don't double-connect — 'new' means offer is in progress, 'connecting'/'connected' are self-explanatory
    const existing = this.peers.get(targetNpub)
    if (existing && (existing.state === 'new' || existing.state === 'connecting' || existing.state === 'connected')) {
      return
    }
    existing?.close()

    const peer = this._createPeer(targetNpub)
    this.peers.set(targetNpub, peer)

    try {
      const sdp = await peer.createOffer()
      this._publishSignal(EventKind.WEBRTC_OFFER, targetNpub, sdp)
    } catch (err) {
      console.error('[WebRTC] Failed to create offer:', err)
      this.peers.delete(targetNpub)
      peer.close()
    }
  }

  /**
   * Called from ingestEvent for kinds 30097–30099.
   * Routes the signal to the correct handler based on kind.
   */
  async onSignalEvent(event: ChronicleEvent): Promise<void> {
    const to = event.tags.find(t => t[0] === 'to')?.[1]
    if (!to || to !== this.deps.myNpub) return  // Not addressed to us

    const from = event.pubkey.startsWith('npub') ? event.pubkey : this._hexToNpub(event.pubkey)
    const sdp = event.tags.find(t => t[0] === 'sdp')?.[1]
    const candidate = event.tags.find(t => t[0] === 'candidate')?.[1]

    switch (event.kind) {
      case EventKind.WEBRTC_OFFER:
        if (sdp) await this._handleOffer(from, sdp)
        break
      case EventKind.WEBRTC_ANSWER:
        if (sdp) await this._handleAnswer(from, sdp)
        break
      case EventKind.WEBRTC_ICE:
        if (candidate) await this._handleIce(from, candidate)
        break
    }
  }

  /** Gracefully close all peer connections */
  closeAll(): void {
    for (const peer of this.peers.values()) peer.close()
    this.peers.clear()
  }

  /** Returns list of connected peer npubs */
  connectedPeers(): string[] {
    return [...this.peers.entries()]
      .filter(([, p]) => p.state === 'connected')
      .map(([npub]) => npub)
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _createPeer(peerId: string): PeerConnection {
    return new PeerConnection(peerId, {
      onIceCandidate: (candidate) => {
        // Send incremental ICE candidates (in case ICE gathering didn't bundle)
        this._publishSignal(
          EventKind.WEBRTC_ICE,
          peerId,
          undefined,
          JSON.stringify(candidate.toJSON()),
        )
      },
      onStateChange: (state, id) => {
        this.deps.onPeerStateChange?.(id, state)
        if (state === 'connected') {
          this._syncAllEventsToPeer(id)
        }
        if (state === 'disconnected' || state === 'failed' || state === 'closed') {
          this.peers.delete(id)
        }
      },
      onMessage: (msg, _peerId) => {
        if (msg.type === 'event') {
          try {
            this.deps.onPeerEvent(msg.event as ChronicleEvent)
          } catch {
            // Ignore malformed events
          }
        }
      },
    })
  }

  /** Receiver side: got an offer, create answer */
  private async _handleOffer(fromNpub: string, sdp: string): Promise<void> {
    let peer = this.peers.get(fromNpub)
    if (!peer || peer.state === 'disconnected' || peer.state === 'failed' || peer.state === 'closed') {
      peer = this._createPeer(fromNpub)
      this.peers.set(fromNpub, peer)
    }
    try {
      const answerSdp = await peer.createAnswer(sdp)
      this._publishSignal(EventKind.WEBRTC_ANSWER, fromNpub, answerSdp)
    } catch (err) {
      console.error('[WebRTC] Failed to create answer:', err)
    }
  }

  /** Initiator side: got the answer, apply it */
  private async _handleAnswer(fromNpub: string, sdp: string): Promise<void> {
    const peer = this.peers.get(fromNpub)
    if (!peer) return
    try {
      await peer.applyAnswer(sdp)
    } catch (err) {
      console.error('[WebRTC] Failed to apply answer:', err)
    }
  }

  /** Either side: got an ICE candidate */
  private async _handleIce(fromNpub: string, candidateJson: string): Promise<void> {
    const peer = this.peers.get(fromNpub)
    if (!peer) return
    await peer.addIceCandidate(candidateJson)
  }

  /** Push all locally stored events to a newly connected peer */
  private _syncAllEventsToPeer(peerId: string): void {
    const peer = this.peers.get(peerId)
    if (!peer) return
    const events = this.deps.getRawEvents()
    for (const event of events) {
      peer.sendEvent(event)
    }
  }

  /** Build and publish a WebRTC signal event via the relay */
  private _publishSignal(
    kind: typeof EventKind.WEBRTC_OFFER | typeof EventKind.WEBRTC_ANSWER | typeof EventKind.WEBRTC_ICE,
    targetNpub: string,
    sdp?: string,
    candidate?: string,
  ): void {
    const tags: string[][] = [
      ['v', SCHEMA_VERSION],
      ['to', targetNpub],
    ]
    if (sdp) tags.push(['sdp', sdp])
    if (candidate) tags.push(['candidate', candidate])

    const unsigned: UnsignedEvent = {
      kind,
      pubkey: npubToHex(this.deps.myNpub),
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: '',
    }

    try {
      const signed = signEvent(unsigned, this.deps.myNsec)
      this.deps.relayClient.publish(signed as unknown as ChronicleEvent)
    } catch (err) {
      console.error('[WebRTC] Failed to publish signal event:', err)
    }
  }

  /** Convert hex pubkey to npub for incoming events */
  private _hexToNpub(hex: string): string {
    try {
      return hexToNpub(hex)
    } catch {
      return hex
    }
  }
}
