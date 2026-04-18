/**
 * contactList.ts
 *
 * Encrypted private contact list (kind 30090).
 * Stored as an event encrypted to the user's own key.
 * Never published to public relays — local relay only.
 *
 * Contact list is kept in memory and serialised/deserialised
 * as needed. The raw encrypted event is what gets stored/published.
 */

import nacl from 'tweetnacl'
import { encodeBase64, decodeBase64 } from 'tweetnacl-util'

const _enc = new TextEncoder()
const _dec = new TextDecoder()

export interface Contact {
  npub: string
  relay: string
  displayName: string
  addedAt: number // unix timestamp ms
  trusted: boolean
}

export interface ContactList {
  contacts: Contact[]
  version: 1
}

// ---------------------------------------------------------------------------
// Encryption helpers (symmetric — encrypted to user's own NaCl secretbox key)
// ---------------------------------------------------------------------------

/**
 * Derive a 32-byte symmetric key from the user's nsec hex string.
 * We just take the first 32 bytes of the hex-decoded private key.
 * The private key is already 32 bytes of entropy.
 */
function keyFromNsecHex(nsecHex: string): Uint8Array {
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(nsecHex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/**
 * Encrypt a contact list to a JSON ciphertext string.
 */
export function encryptContactList(list: ContactList, nsecHex: string): string {
  const key = keyFromNsecHex(nsecHex)
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength)
  const message = _enc.encode(JSON.stringify(list))
  const box = nacl.secretbox(message, nonce, key)
  return encodeBase64(nonce) + '.' + encodeBase64(box)
}

/**
 * Decrypt a contact list ciphertext string.
 * Returns null if decryption fails (wrong key or tampered data).
 */
export function decryptContactList(ciphertext: string, nsecHex: string): ContactList | null {
  try {
    const parts = ciphertext.split('.')
    if (parts.length !== 2) return null
    const nonce = decodeBase64(parts[0])
    const box = decodeBase64(parts[1])
    const key = keyFromNsecHex(nsecHex)
    const opened = nacl.secretbox.open(box, nonce, key)
    if (!opened) return null
    const list = JSON.parse(_dec.decode(opened)) as ContactList
    if (!list.contacts || list.version !== 1) return null
    return list
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// In-memory contact list manager
// ---------------------------------------------------------------------------

export class ContactListManager {
  private list: ContactList = { contacts: [], version: 1 }

  constructor(initial?: ContactList) {
    if (initial) this.list = initial
  }

  getAll(): Contact[] {
    return [...this.list.contacts]
  }

  get(npub: string): Contact | undefined {
    return this.list.contacts.find(c => c.npub === npub)
  }

  has(npub: string): boolean {
    return this.list.contacts.some(c => c.npub === npub)
  }

  add(contact: Omit<Contact, 'addedAt'>): void {
    if (this.has(contact.npub)) {
      // update existing
      this.list.contacts = this.list.contacts.map(c =>
        c.npub === contact.npub ? { ...c, ...contact, addedAt: c.addedAt } : c
      )
    } else {
      this.list.contacts.push({ ...contact, addedAt: Date.now() })
    }
  }

  remove(npub: string): void {
    this.list.contacts = this.list.contacts.filter(c => c.npub !== npub)
  }

  setTrusted(npub: string, trusted: boolean): void {
    this.list.contacts = this.list.contacts.map(c =>
      c.npub === npub ? { ...c, trusted } : c
    )
  }

  updateRelay(npub: string, relay: string): void {
    this.list.contacts = this.list.contacts.map(c =>
      c.npub === npub ? { ...c, relay } : c
    )
  }

  /** Serialise for encryption / storage */
  toList(): ContactList {
    return { ...this.list, contacts: [...this.list.contacts] }
  }

  /** Encrypt to ciphertext (for kind 30090 content field) */
  encrypt(nsecHex: string): string {
    return encryptContactList(this.toList(), nsecHex)
  }

  /** Load from decrypted ContactList */
  static fromList(list: ContactList): ContactListManager {
    return new ContactListManager(list)
  }

  /** Load from encrypted ciphertext, returns null if decryption fails */
  static fromEncrypted(ciphertext: string, nsecHex: string): ContactListManager | null {
    const list = decryptContactList(ciphertext, nsecHex)
    if (!list) return null
    return new ContactListManager(list)
  }
}
