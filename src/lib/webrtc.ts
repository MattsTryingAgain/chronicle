/**
 * WebRTC peer connection wrapper for Chronicle.
 *
 * Wraps RTCPeerConnection + RTCDataChannel.
 * All Chronicle events are exchanged over the data channel as JSON.
 * The signalling layer (webrtcSignal.ts) handles SDP/ICE exchange via the Nostr relay.
 */

export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
}

export type PeerMessage =
  | { type: 'event'; event: unknown }
  | { type: 'ping' }
  | { type: 'pong' }

export type PeerState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed'

export interface PeerCallbacks {
  onIceCandidate: (candidate: RTCIceCandidate) => void
  onMessage: (msg: PeerMessage, peerId: string) => void
  onStateChange: (state: PeerState, peerId: string) => void
}

export class PeerConnection {
  readonly peerId: string
  private pc: RTCPeerConnection
  private channel: RTCDataChannel | null = null
  private callbacks: PeerCallbacks
  private _state: PeerState = 'new'

  constructor(peerId: string, callbacks: PeerCallbacks) {
    this.peerId = peerId
    this.callbacks = callbacks
    this.pc = new RTCPeerConnection(RTC_CONFIG)

    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.callbacks.onIceCandidate(ev.candidate)
      }
    }

    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState as PeerState
      this._state = s
      this.callbacks.onStateChange(s, this.peerId)
    }

    // Receiver side: remote peer created the data channel
    this.pc.ondatachannel = (ev) => {
      this._attachChannel(ev.channel)
    }
  }

  get state(): PeerState {
    return this._state
  }

  /** Initiator: create offer + data channel */
  async createOffer(): Promise<string> {
    const ch = this.pc.createDataChannel('chronicle', { ordered: true })
    this._attachChannel(ch)
    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)
    // Wait for ICE gathering to complete (or timeout) before returning SDP
    await this._waitForIceGathering()
    return this.pc.localDescription!.sdp
  }

  /** Receiver: accept offer, return answer SDP */
  async createAnswer(remoteSdp: string): Promise<string> {
    await this.pc.setRemoteDescription({ type: 'offer', sdp: remoteSdp })
    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription(answer)
    await this._waitForIceGathering()
    return this.pc.localDescription!.sdp
  }

  /** Initiator: apply the answer received from the remote peer */
  async applyAnswer(remoteSdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: 'answer', sdp: remoteSdp })
  }

  /** Add a remote ICE candidate (incremental, after SDP exchange) */
  async addIceCandidate(candidateJson: string): Promise<void> {
    try {
      const candidate = new RTCIceCandidate(JSON.parse(candidateJson))
      await this.pc.addIceCandidate(candidate)
    } catch {
      // Ignore stale or invalid candidates
    }
  }

  /** Send a Chronicle event to the remote peer */
  sendEvent(event: unknown): void {
    this._send({ type: 'event', event })
  }

  /** Gracefully close the connection */
  close(): void {
    this.channel?.close()
    this.pc.close()
    this._state = 'closed'
    this.callbacks.onStateChange('closed', this.peerId)
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private _attachChannel(ch: RTCDataChannel): void {
    this.channel = ch
    ch.onopen = () => {
      this._state = 'connected'
      this.callbacks.onStateChange('connected', this.peerId)
    }
    ch.onclose = () => {
      this._state = 'disconnected'
      this.callbacks.onStateChange('disconnected', this.peerId)
    }
    ch.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as PeerMessage
        this.callbacks.onMessage(msg, this.peerId)
      } catch {
        // Ignore malformed messages
      }
    }
  }

  private _send(msg: PeerMessage): void {
    if (this.channel?.readyState === 'open') {
      this.channel.send(JSON.stringify(msg))
    }
  }

  /**
   * Wait for ICE gathering to finish (or 3 s timeout).
   * Bundling all candidates into the SDP simplifies the signalling flow —
   * no need to send incremental ICE events for most network topologies.
   */
  private _waitForIceGathering(): Promise<void> {
    return new Promise((resolve) => {
      if (this.pc.iceGatheringState === 'complete') {
        resolve()
        return
      }
      const timeout = setTimeout(resolve, 3000)
      this.pc.onicegatheringstatechange = () => {
        if (this.pc.iceGatheringState === 'complete') {
          clearTimeout(timeout)
          resolve()
        }
      }
    })
  }
}
