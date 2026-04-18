# Chronicle — User Guide

## Getting Started

### Creating your account

When you first open Chronicle, you'll be asked to create your identity.

1. **Enter your name** — this is how you'll appear to connected family members
2. **Save your recovery phrase** — Chronicle shows you a 12-word phrase. Write it down and keep it somewhere safe. This is the only way to recover your account if you lose access to this device. Chronicle never sends it anywhere.
3. **Start your tree** — add yourself first, then begin adding ancestors

### Your recovery phrase

Your recovery phrase is a sequence of 12 ordinary English words, e.g.:
> *garden table river moon...*

It is the master key to your Chronicle identity. Anyone who has it can access your account. Keep it:
- Written on paper, stored somewhere safe
- Not in a photo on your phone
- Not in a cloud notes app

Chronicle derives your identity from this phrase using a cryptographic standard (BIP39). It is never stored by Chronicle and never sent over the network.

---

## Adding family members

### Adding yourself

Select **Add myself** during onboarding, or tap **Add information** on your profile card. You can record:
- Full name
- Year of birth / year of death
- Place of birth / place of death
- Occupation
- A short biography

### Adding ancestors

Tap **Add a family member** from the People list. Fill in as much as you know. It's fine to leave fields blank.

### Evidence sources

Each fact has an optional **Source or evidence** field. Citing a source (e.g. *birth certificate*, *family bible*, *1901 census*) increases the confidence score for that record and helps resolve disputes.

---

## Connecting with family

### Inviting someone

Go to the **Connect** tab and tap **Invite a family member**. You'll see:
- A text invite code — copy and send it by any means (email, text, etc.)
- A QR code — for in-person connection

The invite code encodes your relay address and public key. It contains no ancestry data.

### Joining someone's tree

If you received an invite code, go to **Connect → Invite a family member** and paste the code. Chronicle will establish an encrypted connection and begin syncing your trees.

### What happens when you connect

- You each receive the other's shared family events
- Trees that share a common ancestor are linked automatically
- Chronicle suggests possible matches when it detects the same person under different entries — you always confirm or dismiss these suggestions

---

## Disputes and conflicts

### When records disagree

If two family members have recorded different values for the same fact (e.g. different birth years for the same ancestor), Chronicle shows a **conflict indicator** on the profile card.

- **~** (soft conflict) — one version has more support, but alternatives exist
- **⚡** (disputed) — versions are roughly equally supported; your input is needed
- **✓** (settled) — a clear majority has endorsed one version

Tap **View history** on any conflicted field to see all versions and their confidence scores.

### Endorsing a record

If you believe one version is correct, tap **Support this record**. Your endorsement increases the confidence score for that version, weighted by your proximity to the ancestor.

### Retracting your own record

If you made a mistake, tap **Withdraw my record** on your own entry. The record is flagged as withdrawn and excluded from scoring. The full history is preserved — Chronicle never permanently deletes data.

### Disputing content

If a record or piece of media is factually wrong or objectionable, tap the **⚑ Dispute** button. Disputes are permanently recorded and visible to all connected family members. You must give a reason. Disputes do not remove the content — they flag it visibly.

**To hide disputed content by default**, go to Settings → Privacy and enable *Hide disputed content by default*.

---

## Privacy

Chronicle has three tiers of visibility:

| Tier | Visible to |
|---|---|
| **Public** | Anyone who connects to your relay |
| **Family** | Connected family members with the family key |
| **Private** | Specific keyholders only |

Most ancestry data (names, dates, places) defaults to **Family** tier. Sensitive relationship types (adopted, non-paternity events) default to **Family** or **Private**.

### Family key

The family key is a shared encryption key distributed to admitted family members. It allows family-tier data to be read by all trusted relatives. The first person in a group generates it; others are admitted by an existing keyholder.

---

## Recovery

### If you lose your device

As long as you have your **recovery phrase**, you can recover your account on any new device. Install Chronicle, select *Import existing identity*, and enter your phrase.

### If you lose your recovery phrase

This is serious. If you've set up **recovery contacts** — trusted family members designated during onboarding — they can co-sign a recovery event that links a new key to your old identity. You need at least 3 recovery contacts to have co-signed this event *before* you lose access.

Go to **Settings → Recovery Contacts** to set these up in advance.

### If your key is compromised

If someone else gains access to your recovery phrase, a recovery contact can publish a **revocation event** invalidating your old key from a given point in time. Historical events are flagged (not deleted); new events from the old key are ignored by all connected clients.

---

## Export and backup

### GEDCOM export

GEDCOM is the standard genealogy exchange format, compatible with Ancestry, FamilySearch, MyHeritage, and most genealogy software. Go to **Settings → Export → Export as GEDCOM**.

### Chronicle archive

A Chronicle archive is a full backup of your local data: all records, claims, endorsements, and encrypted ancestor keys. Go to **Settings → Export → Export Chronicle archive**. Keep this file safe — it is your complete backup.

---

## Settings reference

| Setting | Description |
|---|---|
| Recovery contacts | Trusted family members who can help recover your account |
| Broadcasting | Control whether events stay local, go to a shared family relay, or include a discovery relay |
| Discovery relay | Opt in to let distant relatives search for you by name |
| Language | Override the auto-detected display language |
| Family key | Generate or view the family encryption key |
| Hide disputed content | Client-side filter for flagged records |
