import { describe, it, expect } from 'vitest'
import {
  encryptContactList,
  decryptContactList,
  ContactListManager,
  type ContactList,
  type Contact,
} from './contactList.js'
import { generateAncestorKeyPair, nsecToHex } from './keys.js'

function makeNsecHex(): string {
  const kp = generateAncestorKeyPair()
  return nsecToHex(kp.nsec)
}

const SAMPLE_CONTACT: Omit<Contact, 'addedAt'> = {
  npub: 'npub1' + 'a'.repeat(58),
  relay: 'wss://relay.example.com',
  displayName: 'Alice',
  trusted: true,
}

describe('contactList encryption', () => {
  it('encrypts and decrypts successfully', () => {
    const nsecHex = makeNsecHex()
    const list: ContactList = {
      contacts: [{ ...SAMPLE_CONTACT, addedAt: Date.now() }],
      version: 1,
    }
    const ct = encryptContactList(list, nsecHex)
    const result = decryptContactList(ct, nsecHex)
    expect(result).not.toBeNull()
    expect(result!.contacts).toHaveLength(1)
    expect(result!.contacts[0].npub).toBe(SAMPLE_CONTACT.npub)
  })

  it('decryption fails with wrong key', () => {
    const nsecHex = makeNsecHex()
    const wrongHex = makeNsecHex()
    const list: ContactList = { contacts: [], version: 1 }
    const ct = encryptContactList(list, nsecHex)
    expect(decryptContactList(ct, wrongHex)).toBeNull()
  })

  it('decryption fails with tampered ciphertext', () => {
    const nsecHex = makeNsecHex()
    const list: ContactList = { contacts: [], version: 1 }
    const ct = encryptContactList(list, nsecHex)
    const tampered = ct.slice(0, -5) + 'ZZZZZ'
    expect(decryptContactList(tampered, nsecHex)).toBeNull()
  })

  it('decryption returns null for garbage input', () => {
    const nsecHex = makeNsecHex()
    expect(decryptContactList('not-valid', nsecHex)).toBeNull()
    expect(decryptContactList('', nsecHex)).toBeNull()
  })

  it('produces different ciphertext each time (random nonce)', () => {
    const nsecHex = makeNsecHex()
    const list: ContactList = { contacts: [], version: 1 }
    const ct1 = encryptContactList(list, nsecHex)
    const ct2 = encryptContactList(list, nsecHex)
    expect(ct1).not.toBe(ct2)
  })
})

describe('ContactListManager', () => {
  it('starts empty', () => {
    const mgr = new ContactListManager()
    expect(mgr.getAll()).toHaveLength(0)
  })

  it('adds a contact', () => {
    const mgr = new ContactListManager()
    mgr.add(SAMPLE_CONTACT)
    expect(mgr.getAll()).toHaveLength(1)
    expect(mgr.get(SAMPLE_CONTACT.npub)!.displayName).toBe('Alice')
  })

  it('has() returns correct boolean', () => {
    const mgr = new ContactListManager()
    expect(mgr.has(SAMPLE_CONTACT.npub)).toBe(false)
    mgr.add(SAMPLE_CONTACT)
    expect(mgr.has(SAMPLE_CONTACT.npub)).toBe(true)
  })

  it('updating existing contact preserves addedAt', () => {
    const mgr = new ContactListManager()
    mgr.add(SAMPLE_CONTACT)
    const before = mgr.get(SAMPLE_CONTACT.npub)!.addedAt
    mgr.add({ ...SAMPLE_CONTACT, displayName: 'Alice Updated' })
    expect(mgr.get(SAMPLE_CONTACT.npub)!.addedAt).toBe(before)
    expect(mgr.get(SAMPLE_CONTACT.npub)!.displayName).toBe('Alice Updated')
  })

  it('removes a contact', () => {
    const mgr = new ContactListManager()
    mgr.add(SAMPLE_CONTACT)
    mgr.remove(SAMPLE_CONTACT.npub)
    expect(mgr.has(SAMPLE_CONTACT.npub)).toBe(false)
  })

  it('setTrusted updates trust flag', () => {
    const mgr = new ContactListManager()
    mgr.add({ ...SAMPLE_CONTACT, trusted: true })
    mgr.setTrusted(SAMPLE_CONTACT.npub, false)
    expect(mgr.get(SAMPLE_CONTACT.npub)!.trusted).toBe(false)
  })

  it('updateRelay updates relay URL', () => {
    const mgr = new ContactListManager()
    mgr.add(SAMPLE_CONTACT)
    mgr.updateRelay(SAMPLE_CONTACT.npub, 'wss://new-relay.example.com')
    expect(mgr.get(SAMPLE_CONTACT.npub)!.relay).toBe('wss://new-relay.example.com')
  })

  it('round-trips through encrypt/fromEncrypted', () => {
    const nsecHex = makeNsecHex()
    const mgr = new ContactListManager()
    mgr.add(SAMPLE_CONTACT)
    const ct = mgr.encrypt(nsecHex)
    const restored = ContactListManager.fromEncrypted(ct, nsecHex)
    expect(restored).not.toBeNull()
    expect(restored!.has(SAMPLE_CONTACT.npub)).toBe(true)
    expect(restored!.get(SAMPLE_CONTACT.npub)!.displayName).toBe('Alice')
  })

  it('fromEncrypted returns null for bad key', () => {
    const nsecHex = makeNsecHex()
    const wrongHex = makeNsecHex()
    const mgr = new ContactListManager()
    const ct = mgr.encrypt(nsecHex)
    expect(ContactListManager.fromEncrypted(ct, wrongHex)).toBeNull()
  })

  it('fromList round-trips', () => {
    const list: ContactList = {
      contacts: [{ ...SAMPLE_CONTACT, addedAt: 12345 }],
      version: 1,
    }
    const mgr = ContactListManager.fromList(list)
    expect(mgr.get(SAMPLE_CONTACT.npub)!.addedAt).toBe(12345)
  })
})
