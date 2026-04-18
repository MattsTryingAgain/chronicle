# Chronicle — Key Custody Guide

## Your identity key

Your Chronicle identity is a secp256k1 keypair, derived from your BIP39 recovery
phrase using the derivation path `m/44'/1237'/0'/0/0` (the emerging Nostr standard).

**Your recovery phrase is the only thing you need to back up.** It is 12 English
words. Treat it like a bank PIN — store it physically, not digitally.

---

## Ancestor keys

When you add an ancestor to Chronicle, a random keypair is generated for them.
Unlike your own key, ancestor keys are **not** derived from your mnemonic. They
are stored encrypted in your local Chronicle database and backed up via the
Chronicle archive export.

Ancestor private keys are not load-bearing for identity — they don't need to be
kept secret to maintain the integrity of the family tree. The claim/endorsement
system handles conflicts socially. Ancestor keys are used only for the privacy
encryption layer (family and private tiers).

---

## Recovery contacts

Recovery contacts are pre-designated trusted family members who can co-sign
recovery events in the event of key loss or compromise. **You must set these up
before you need them.**

- Go to **Settings → Recovery Contacts**
- Add at least 3 trusted family members who are already on Chronicle
- They do not need to do anything — their inclusion is recorded in your local data

### Key loss recovery (supersession)

If you lose your recovery phrase and device access:

1. Install Chronicle on a new device
2. Generate a new keypair
3. Ask your pre-registered recovery contacts to co-sign a supersession event
4. 3 of your registered contacts must co-sign
5. Your new key is linked to your old identity going forward
6. Old claims remain valid and attributed — the link is transparent in the history

### Key compromise recovery (revocation)

If your recovery phrase is stolen or exposed:

1. Contact your recovery contacts immediately
2. Ask them to publish a **revocation event** naming your compromised key and the
   timestamp from which it should be considered invalid
3. 3 attestations are required
4. All connected Chronicle clients will treat events from your old key (after that
   timestamp) as coming from a compromised source — flagged but not deleted
5. You can then initiate supersession with a new key as above

**Important:** the compromised key cannot block its own revocation. Only
pre-registered recovery contacts have this authority.

---

## Shamir's Secret Sharing (Stage 5 — advanced)

For private-tier ancestor keys, Chronicle uses Shamir's Secret Sharing (3-of-5
by default). This splits a private key into 5 shares, any 3 of which can
reconstruct the key.

- **3-of-5** means any 3 out of your 5 designated shareholders can recover the key
- Shareholders are trusted family members
- No single shareholder can reconstruct the key alone
- This is used for the *privacy encryption layer only* — not for conflict resolution

Use the Chronicle archive export to back up your full key set, including Shamir
shares you hold for others.

---

## Security notes

- Chronicle never stores your recovery phrase after the onboarding screen
- Ancestor private keys are stored encrypted with your password (NaCl secretbox)
- The family shared key is distributed to admitted members via asymmetric encryption (NaCl box / Curve25519)
- No key material is ever sent to a Chronicle server — there is no Chronicle server
- All cryptographic operations use audited libraries: `@noble/curves`, `@scure/bip39`, `tweetnacl`
