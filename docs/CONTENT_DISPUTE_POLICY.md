# Chronicle — Content Dispute Policy

## What this document covers

This document explains how Chronicle handles disputed content and what rights and
responsibilities users have when content is flagged as incorrect or objectionable.

---

## How disputes work

Any connected user can raise a dispute against any published record or media
reference. Disputes are permanent — they become part of the historical record.

When a dispute is raised:

1. A dispute event (kind 30087) is signed and published to your local relay
2. The event references the disputed record and includes the reason you provided
3. All connected family members can see the dispute indicator on the record
4. The original record is **not deleted** — it is flagged

Disputes are subject to the same claim/endorsement model as other Chronicle data.
They cannot be undone by the person who raised them.

---

## What Chronicle can and cannot do

**Chronicle can:**
- Record a dispute and make it visible to all connected family members
- Allow you to remove media from your own Blossom server
- Allow you to retract your own claims
- Flag events from revoked or compromised keys

**Chronicle cannot:**
- Remove data from another person's relay or Blossom server
- Force any connected client to delete content
- Guarantee that data published to a shared relay is erased on request

This is a consequence of the decentralised design — no central authority controls
all copies of the data.

---

## GDPR and right to erasure

Chronicle's good-faith approach to GDPR erasure requests:

### 1. Revoking attestation (link severing)
Revoking your attestation to an ancestor record severs the traversable cryptographic
link between you and that record. Clients that respect this will no longer display
the record in your tree context.

### 2. Encryption as functional erasure
Data encrypted to a family or private key becomes functionally inaccessible when
the key is not distributed further. Deleting your copy of the key achieves
functional erasure even if ciphertext remains on a relay.

### 3. Blossom media removal
Removing media from your Blossom server deletes it everywhere your server was the
authoritative source. Chronicle clients will show a "media unavailable" placeholder.

### 4. Relay data
Data on your local relay can be deleted by stopping the relay and deleting the
database file. Data on a shared relay can be removed by the relay operator.

### Limitation
Nostr's design means that once an event has been relayed to another peer, you
cannot guarantee deletion from that peer's storage. Chronicle documents this
honestly and does not make guarantees it cannot keep.

---

## Living persons

Extra care is taken with data about living people:

- Living person records default to **Family** tier (not public)
- Sensitive relationship subtypes default to **Family** or **Private** tier
- The `sensitive` flag on a claim causes clients to render it discreetly

Chronicle does not publish personally identifying information about living people
to public or discovery relays without explicit user action.

---

## Responsibility

The person who publishes a record is responsible for its accuracy and legality.
Chronicle is a tool; it does not moderate content. Dispute indicators make
objections visible — social accountability within the family group is the
primary governance mechanism.
