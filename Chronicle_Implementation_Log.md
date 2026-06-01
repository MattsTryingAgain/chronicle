# Chronicle — Implementation Log

This document records what has been built, decisions made during implementation, and known gotchas. It supplements the Design Plan and should be read alongside it at the start of each new session.

---

## Developer Workflow — Read This Each Session

### Applying a new tarball from Claude

1. Download the `.tar.gz` file from the Claude chat — save it to `C:\Users\Matt\Desktop\Websites\Chronicle\`

2. Extract it — overwrites only changed files into `chronicle-export\`:
```bat
tar -xzf C:\Users\Matt\Desktop\Websites\Chronicle\<filename>.tar.gz -C C:\Users\Matt\Desktop\Websites\Chronicle\
```

3. Commit and push:
```bat
cd C:\Users\Matt\Desktop\Websites\Chronicle\chronicle-export
git add -A
git commit -m "Brief description of what changed"
git push
```

4. To trigger a release build (builds installers for Mac, Windows, Linux via GitHub Actions):
```bat
git tag v1.0.X
git push origin v1.0.X
```

GitHub Actions runs the tests and builds the installers automatically on tag push. A regular `git push` without a tag runs CI only — no release produced.

### Workflow files
The `.github/workflows/` files are sometimes delivered as individual `.yml` downloads rather than inside a tarball. Save them directly to:
- `C:\Users\Matt\Desktop\Websites\Chronicle\chronicle-export\.github\workflows\release.yml`
- `C:\Users\Matt\Desktop\Websites\Chronicle\chronicle-export\.github\workflows\ci.yml`

Then commit normally with `git add -A`.

### What NOT to do locally
- No need to run `npm install` or `npm test` locally — GitHub Actions handles this
- No need to restore the `better-sqlite3` mock locally — only needed in Claude's container
- No need to run `vite build` locally

### Starting a new Claude session
1. Upload the latest tarball (download from the previous session or export from working directory)
2. Claude reads the Design Plan and Implementation Log before writing any code
3. Claude verifies baseline test count before making changes
4. At end of session: Claude delivers a new tarball + updated `Chronicle_Implementation_Log.md`

### Version numbering
- Version in `package.json` is synced from the git tag at build time by the release workflow — do NOT edit manually
- Current version series: `v1.0.x` — increment patch number for each release
- Last tag pushed: `v1.0.23`

### GitHub repo
- Owner: MattsTryingAgain
- Repo: chronicle
- URL: https://github.com/MattsTryingAgain/chronicle

---

## Current State

**Stage 1 — complete.**
**Stage 2 — complete.**
**Stage 3 — complete.**
**Stage 4 — complete.**
**Stage 5 — complete.**
**Stage 6 — complete.**
**Stage 7 — complete.**

**Test summary: 616/616 passing**
**TypeScript: clean**
**Build: clean**
**Current release: v1.0.23**

---

## Bug Fixes Applied (Post-Stage 7, April 2026 Session)

### Fix 1 — nsec import generating stale mnemonic / not starting relay
**Root cause:** `importIdentity` called `setSession` directly instead of `beginSession`, bypassing relay startup and contact-list restore. If the user had partially started "Create identity" first, the stale mnemonic was never cleared.

**Files changed:**
- `src/context/AppContext.tsx`: `importIdentity` now calls `setGeneratedMnemonic(null)` then `beginSession(...)`.
- `src/components/Onboarding.tsx`: `ImportScreen` no longer calls `setScreen('main')` redundantly.

### Fix 2 — No relationship links shown in family tree
**Root cause:** `AddPersonModal` never created `RelationshipClaim` events. `traverseGraph()` had no edges so the D3 tree only showed the root node.

**Files changed:**
- `src/components/AddPersonModal.tsx`: Rewritten with relationship selector UI (relationship-type dropdown + person picker). Creates forward and inverse `RelationshipClaim` via `addRelationship()`, publishes signed kind-30079 events.
- `src/i18n/locales/en.json` + `fr.json`: Added missing `occupationLabel` / `occupationPlaceholder` keys.

### Fix 3 — Data not persisting across app restarts
**Root cause:** App used `sessionStorage` (cleared on close). Electron also lacked a named persistent partition so `localStorage` was also in-memory only.

**Files changed:**
- `src/context/AppContext.tsx`: All `sessionStorage` replaced with `localStorage`.
- `electron/main.cjs`: Added `partition: 'persist:chronicle'` to `webPreferences`. Tells Electron to persist the browser session to disk in userData folder.

### Fix 4 — Multiple app windows opening on launch
**Root cause:** Single instance lock was in place but `app.whenReady()` (which creates the window) was outside the lock's `else` block, so every instance briefly opened a window before quitting.

**Files changed:**
- `electron/main.cjs`: Entire app lifecycle (`whenReady`, window creation, relay startup, auto-updater) moved inside the `else` block. Added EPIPE suppression on `process.stdout/stderr` to prevent Windows error dialogs when second instances quit abruptly.

### Fix 5 — Auto-updater not working
**Root causes:**
1. `electron-updater` missing from `package.json` — not bundled in production.
2. No `publish` config in `package.json` — `electron-builder` didn't upload `latest.yml` to GitHub Releases.
3. Release workflow passed `GH_TOKEN` to build step, causing 403 errors when electron-builder tried to publish.
4. Artifact paths pointed at `dist-electron/` but electron-builder outputs to `dist/`.
5. Entire `dist/` folder was uploaded (Electron internals, locale files) instead of just installer files.

**Files changed:**
- `package.json`: Added `electron-updater` to `dependencies`. Added `publish` block for MattsTryingAgain/chronicle. Changed `build:electron` to append `--publish never`.
- `.github/workflows/release.yml`: Removed `GH_TOKEN` from build steps. Build calls `vite build` + `electron-builder --publish never` directly. Artifact paths narrowed to `*.exe`, `*.dmg`, `*.AppImage`, `*.deb`, `*.blockmap`, `*.yml` only. Node bumped to 22. `npm ci` replaced with `npm install --ignore-scripts`.
- `.github/workflows/ci.yml`: Same Node and npm fixes.

---


## Known Gotchas — Read Before Writing Any Import Statements

### 1. `.js` extension required for subpath imports under Vite/ESM

Vite's ESM resolver requires the **explicit `.js` extension** on subpath exports, even for TypeScript source. Two packages affected:

```ts
// WRONG
import { wordlist } from '@scure/bip39/wordlists/english'
import { schnorr } from '@noble/curves/secp256k1'

// CORRECT
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { schnorr } from '@noble/curves/secp256k1.js'
```

### 2. nostr-tools `verifyEvent` caches via a non-enumerable Symbol

`finalizeEvent` attaches an internal `verifiedSymbol` to the event object. A plain object spread (`{ ...signed }`) **copies this symbol**, so the cached result is returned immediately — even after tampering.

**In tests, always JSON round-trip before mutating a signed event:**

```ts
const tampered = { ...JSON.parse(JSON.stringify(signed)), content: 'tampered' }
```

### 3. `nostr-tools` `getPublicKey` expects `Uint8Array`, not hex string

Use `@noble/curves/secp256k1.js` `schnorr.getPublicKey(privKeyBytes)` instead.

### 4. NaCl / PBKDF2 cross-environment

`storage.ts` `deriveKey()` detects Node via `globalThis.process?.versions?.node` and uses `pbkdf2Sync` from `node:crypto`. In the browser it uses `SubtleCrypto`. Do not change this — tests run in Node and the production app runs in the browser.

### 5. Test files excluded from app tsconfig

`tsconfig.app.json` has `"exclude": ["src/**/*.test.ts", "src/**/*.test.tsx"]` to prevent `noUnusedLocals` errors from test fixtures bleeding into the app build. Test files are still compiled by Vitest directly.

### 6. `vite.config.ts` imports from `vitest/config`

The `test` key requires this import — `vite` alone does not type it.

### 7. `tsc -b` vs `tsc -p tsconfig.app.json --noEmit`

`tsc -b` (build mode) may exit silently with code 1 due to the npm config prefix issue in this environment. Always use `node_modules/.bin/tsc -p tsconfig.app.json --noEmit` to type-check accurately.

### 8. `better-sqlite3` requires native compilation

`better-sqlite3` uses native Node addons and must be compiled against the Node version in use. It cannot be installed in restricted environments (no Node headers). When working in a Claude artifact/container, install it in the `relay/` directory on the developer's own machine:

```bash
cd relay && npm install
```

A **mock implementation** lives in `node_modules/better-sqlite3/` (rewritten in Stage 7) which satisfies `require('better-sqlite3')` in the test environment. The mock is a pure-JS in-memory implementation with the same synchronous API surface (`prepare/run/get/all/exec/pragma`).

**On the developer's machine:** `npm install better-sqlite3 @types/better-sqlite3` in the root to get the real native module. The mock `node_modules/better-sqlite3/` entry will be overwritten by `npm install`.

### 9. `FactClaim` uses `eventId`, not `id`; `Endorsement` also uses `eventId`

Both types use `eventId` as the primary key field (not `id`). The store's `addClaim()` and `addEndorsement()` key by `claim.eventId` / `endorsement.eventId`. Confusing this causes silent failures where claims are stored but retraction lookups miss them.

### 10. `Person` type has no `claimedBy` field

The `Person` interface in `src/types/chronicle.ts` has only: `pubkey`, `displayName`, `isLiving`, `createdAt`. There is no `claimedBy` field — that is modelled via `RelationshipClaim` in the graph module.

### 11. Graph store uses pluggable backend (Stage 7)

`src/lib/graph.ts` now exposes a `GraphBackend` interface. The default backend is `MemoryGraphStore` (module-level). In Electron, inject `SqliteStore` via `setGraphBackend(sqliteStore)` after construction. Call `_resetGraphStore()` in tests for a clean slate — this also reverts the backend to in-memory.

### 12. Storage method names

- `store.getClaimsForPerson(pubkey)` — NOT `getClaimsFor()`
- `store.getAllEndorsements()` — added Stage 3; returns all endorsements regardless of claim
- `store.getEndorsementsForClaim(claimEventId)` — filtered by claim

### 13. Electron binary cannot be downloaded in the Claude container

`electron` npm package requires a binary download from GitHub Releases (blocked domain). The full Electron scaffold is written — install on the developer's machine:

```bash
npm install --save-dev electron
npm run dev:electron   # dev mode (Vite + Electron concurrently)
npm run build:electron # production build via electron-builder
```

### 14. NaCl encoding in Node test environment

`tweetnacl-util`'s `encodeUTF8` / `decodeUTF8` cause `TypeError: unexpected type, use Uint8Array` in the Node test environment. **Always use native `TextEncoder` / `TextDecoder`** for string↔Uint8Array conversion in any module that uses `nacl.secretbox`. See `contactList.ts` and `storage.ts` for the correct pattern.

### 15. Actual exported function names in `keys.ts`

| Wrong assumption | Correct name |
|---|---|
| `generateKeypair()` | `generateAncestorKeyPair()` |
| `encodePubkey()` | `hexToNpub()` |
| `decodePubkey()` | `npubToHex()` |
| `encodePrivkey()` | `hexToNsec()` |
| `decodePrivkey()` | `nsecToHex()` |

### 16. `AncestorKeyPair` shape

```ts
interface AncestorKeyPair { npub: string; nsec: string }
```
No `publicKeyHex` field. To get hex: `npubToHex(kp.npub)`.

### 17. `invite.ts` — base64url encoding

Invite codes use `btoa` / `atob` with manual `+→-`, `/→_`, padding strip. Works in both Node (18+) and browser.

### 18. `joinRequest.ts` kinds

`KIND_JOIN_REQUEST = 30091`, `KIND_JOIN_ACCEPT = 30092`.

### 19. `relayGossip.ts` kind

`KIND_RELAY_GOSSIP = 30093`. Pass `gossipTtlMs = 0` in tests to bypass rate limiting.

### 20. Archive packaging

Always copy source to a clean `/tmp/chronicle-export/` directory before tarring — previous outputs in `/mnt/user-data/outputs/` caused bloated/broken archives.

### 21. Build command

```bash
node_modules/.bin/vite build
```

### 22. Stage 5 — `secrets.js-34r7h` for Shamir SSS

`shamir.ts` uses `require('secrets.js-34r7h')` (CommonJS). Do not switch to an ESM import.

### 23. Stage 5 — `better-sqlite3` mock in `node_modules/`

A pure-JS mock at `node_modules/better-sqlite3/index.js` lets tests run without native compilation. **On the developer's machine, `npm install` will replace the mock with the real binary** — this is intentional and correct.

### 24. Stage 5 — Curve25519 key derivation for family key admission

`privacyTier.ts` derives Curve25519 keypairs from Nostr nsec using SHA-512(nsec_hex_bytes). The first 32 bytes become the Curve25519 secret key seed.

### 25. Stage 5 — `node:crypto` externalized in Vite build

`blossom.ts` and `storage.ts` dynamically import `node:crypto` for SHA-256 and PBKDF2. The build warning is harmless.

### 26. Stage 6/7 — Vite 8 / Vitest 4 OXC tsconfig resolution fix ⚠️

**Breaking change.** Vite 8 uses a Rust-based OXC transformer that searches for `tsconfig.json` by walking up from each source file. The composite `tsconfig.json` (`"files": []`) fails this lookup.

**Fix applied:**
- `tsconfig.json` replaced with a non-composite version containing real `compilerOptions` (identical to `tsconfig.app.json` content, without the `exclude` list — OXC does not apply lint exclusions)
- `oxc.tsconfigFilename` removed from `vite.config.ts` (no longer a valid key in Vite 8)

If tests fail with `[TSCONFIG_ERROR] Failed to load tsconfig`, this is the cause.

### 27. Stage 6 — `secrets.js-34r7h` version

Package version `^1.1.3` no longer resolves. **`package.json` uses `^2.0.2`**.

### 28. Stage 6 — `DisputeStore` is module-level (like graph store)

`src/lib/contentDispute.ts` exports a module-level `disputeStore` singleton. Tests use `new DisputeStore()` directly.

### 29. Stage 7 — `contentDispute.ts` pubkey guard

`ingestDisputeEvent` converts `event.pubkey` to npub via `hexToNpub()`. Some test fixtures pass `pubkey` already as npub bech32. Guard added:
```ts
disputerNpub: event.pubkey.startsWith('npub') ? event.pubkey : hexToNpub(event.pubkey)
```


### 31. `better-sqlite3` mock wiped by `npm install`

`npm install` overwrites `node_modules/better-sqlite3/`. The authoritative mock lives at **`src/__mocks__/better-sqlite3.js`** (used by `vi.mock('better-sqlite3')` in `sqliteStore.test.ts`) and is also copied to `node_modules/better-sqlite3/index.js` for tests that don't call `vi.mock` (`sqliteStore.graph.test.ts`, `graph.sqlite.test.ts`).

After any `npm install`, re-run:
```bash
cp src/__mocks__/better-sqlite3.js node_modules/better-sqlite3/index.js
echo '{"name":"better-sqlite3","version":"9.0.0","main":"index.js"}' > node_modules/better-sqlite3/package.json
```

### 32. `MediaCacheBackend` interface and `SqliteStore` return types

`blossom.ts` exports `MediaCacheBackend` with `getAllMediaCache(): MediaCacheEntry[]`.  
`SqliteStore.getMediaCache(url)` returns `MediaCacheRow | undefined` (raw row — tests assert on `row?.hash`, `row?.fetch_status`, etc.).  
`SqliteStore.getAllMediaCache()` returns `MediaCacheEntry[]` (mapped via `rowToMediaCacheEntry`) for hydrating the in-memory cache on startup.  
These two methods intentionally have different return types. Do not change `getMediaCache` to return `MediaCacheEntry` or the graph tests will fail.

### 33. `MediaCache.setBackend()` hydrates from SQLite on injection

When `mediaCache.setBackend(sqliteStore)` is called in `electron/main.js`, the in-memory cache is pre-populated by calling `sqliteStore.getAllMediaCache()`. The `subjectNpub` and `mimeType` fields are not stored in the DB row and are returned as empty strings in the hydrated entries — they are recoverable from the originating kind 30095 event if needed.

### 30. Stage 7 — `better-sqlite3` mock handles OR+AND WHERE and split SET/WHERE params

The mock's `_evalWhere` now uses a recursive expression evaluator that handles parenthesised `(A OR B) AND C` patterns. The UPDATE handler counts `?` in the SET clause to split params between SET and WHERE — they do not share the same param array.

---

## File Inventory

### Configuration

| File | Purpose |
|---|---|
| `vite.config.ts` | Imports from `vitest/config`. Sets `test.globals: true`, `test.environment: 'node'`. No `oxc` key (removed in Stage 7 fix). |
| `tsconfig.json` | **Stage 7:** Replaced composite reference file with real `compilerOptions` for OXC compatibility. |
| `tsconfig.app.json` | `types: ["vite/client", "node"]`. Excludes `*.test.ts` files. |
| `package.json` | Version `0.7.0`. `main: "electron/main.js"`. Scripts: `dev`, `dev:electron`, `build`, `build:electron`, `test`. `secrets.js-34r7h@^2.0.2`. |

### Types

| File | Purpose |
|---|---|
| `src/types/chronicle.ts` | All core TypeScript types — `EventKind` constants (30078–30095), `FactField`, `FactClaim`, `Endorsement`, `Person`, `KeyMaterial`, `ChronicleEvent`, `ConflictState`, `FieldResolution`, privacy tiers, relationship types, proximity levels, `SCHEMA_VERSION = '1'`. Stage 5: `ShamirShare`, `ShamirSplit`, `FamilyKeyAdmission`, `BlossomRef`, `KeySupersession`, `KeyRevocation`. |

### Library modules

| File | Tests | Purpose |
|---|---|---|
| `src/lib/keys.ts` | `keys.test.ts` (28) | BIP39, HD derivation, ancestor keypair, bech32, signing/verification. |
| `src/lib/confidence.ts` | `confidence.test.ts` (23) | Confidence scoring and conflict resolution. |
| `src/lib/storage.ts` | `storage.test.ts` (23) | NaCl encryption. `MemoryStore`. |
| `src/lib/export.ts` | `export.test.ts` (17) | GEDCOM, Chronicle archive, download. |
| `src/lib/eventBuilder.ts` | `eventBuilder.test.ts` (22) | Signed event factory for all Chronicle kinds. |
| `src/lib/relay.ts` | `relay.test.ts` (18) | `RelayClient` + `RelayPool`. |
| `src/lib/queue.ts` | `queue.test.ts` (15) | Offline broadcast queue. |
| `src/lib/gedcomImport.ts` | `gedcomImport.test.ts` (25) | GEDCOM 5.5.1 parser. |
| `src/lib/relaySync.ts` | `relaySync.test.ts` (18) | `startSync()`, `fetchOnConnect()`, `ingestEvent()`. **Stage 7:** `schemaVersionChecker.ingestEvent()` now called on every ingested event. |
| `src/lib/graph.ts` | `graph.test.ts` (25), `graph.sqlite.test.ts` (9) | **Stage 7:** Refactored with `GraphBackend` interface, `MemoryGraphStore` class, `setGraphBackend()`/`getGraphBackend()` injection. All public API preserved. |
| `src/lib/treeLinking.ts` | `treeLinking.test.ts` (40) | Match scoring and tree linking. |
| `src/lib/invite.ts` | `invite.test.ts` (10) | Invite code generation/parsing. |
| `src/lib/contactList.ts` | `contactList.test.ts` (15) | Encrypted kind 30090 contact list. |
| `src/lib/discovery.ts` | `discovery.test.ts` (20) | Kind 30085 publish/search. |
| `src/lib/joinRequest.ts` | `joinRequest.test.ts` (19) | Kind 30091/30092 handshake. |
| `src/lib/syncMerge.ts` | `syncMerge.test.ts` (24) | Peer-online merge queue. |
| `src/lib/trustRevocation.ts` | `trustRevocation.test.ts` (19) | Kind 30088 trust revocation. |
| `src/lib/relayGossip.ts` | `relayGossip.test.ts` (19) | Kind 30093 relay gossip. |
| `src/lib/privacyTier.ts` | `privacyTier.test.ts` (20) | Three-tier encryption. |
| `src/lib/shamir.ts` | `shamir.test.ts` (22) | Shamir SSS for ancestor key custody. |
| `src/lib/blossom.ts` | `blossom.test.ts` (36) | Blossom media references and cache. **Stage 7:** `MediaCacheBackend` interface; `MediaCache.setBackend()` injects SqliteStore for persistent media tracking. |
| `src/lib/keyRecovery.ts` | `keyRecovery.test.ts` (34) | Key supersession and revocation. |
| `src/lib/sqliteStore.ts` | `sqliteStore.test.ts` (32), `sqliteStore.graph.test.ts` (23) | **Stage 7:** Extended with `relationships`, `acknowledgements`, `same_person_links`, `media_cache` tables and all CRUD methods. Drop-in for MemoryStore + graph backend. |
| `src/lib/contentDispute.ts` | `contentDispute.test.ts` (18) | Kind 30087 dispute store. **Stage 7:** npub guard on `ingestDisputeEvent`. |
| `src/lib/conflictResolution.ts` | `conflictResolution.test.ts` (22) | Conflict resolution UI logic. |
| `src/lib/schemaVersion.ts` | `schemaVersion.test.ts` (16) | Schema version checker. |

### Embedded relay (Stage 2)

| File | Purpose |
|---|---|
| `relay/package.json` | Standalone relay package. |
| `relay/server.js` | NIP-01 relay, SQLite, allowlist, HTTP management API. |

### Electron (Stage 3 / updated Stage 6)

| File | Purpose |
|---|---|
| `electron/main.js` | Main process, relay child process, auto-update. **Stage 7:** `initSqliteStore()` constructs `SqliteStore`, calls `setGraphBackend(sqliteStore)` and `mediaCache.setBackend(sqliteStore)` on app ready. |
| `electron/preload.js` | Context-isolated preload: `window.chronicleElectron`. |

### i18n

| File | Purpose |
|---|---|
| `src/i18n/index.ts` | react-i18next config, English + French. |
| `src/i18n/locales/en.json` | All user-facing strings. |
| `src/i18n/locales/fr.json` | Complete French translation. |

### Components

| File | Purpose |
|---|---|
| `src/components/Onboarding.tsx` | Identity creation flow. |
| `src/components/UnlockScreen.tsx` | Password prompt. |
| `src/components/ProfileCard.tsx` | Person display. |
| `src/components/AddPersonModal.tsx` | Add self or ancestor. |
| `src/components/TreeView.tsx` | People list + search. |
| `src/components/FamilyTreeView.tsx` | D3 force-directed family tree. |
| `src/components/SettingsView.tsx` | Relay, broadcast, recovery, import/export, family key. |
| `src/components/InviteModal.tsx` | Invite code generation/parsing. |
| `src/components/ContactListView.tsx` | Contact list. |
| `src/components/SyncMergePrompt.tsx` | Peer sync banner. |
| `src/components/JoinRequestView.tsx` | Inbound join requests. |
| `src/components/TrustRevocationModal.tsx` | Bad actor report. |
| `src/components/KeyRecoveryModal.tsx` | Key supersession + revocation. |
| `src/components/PrivacyTierBadge.tsx` | Privacy tier badge + selector. |
| `src/components/FamilyKeyPanel.tsx` | Family key management. |
| `src/components/ContentDisputeModal.tsx` | Raise kind 30087 dispute. |
| `src/components/ConflictHistoryView.tsx` | Full conflict resolution panel. |
| `src/components/AboutView.tsx` | About section. |
| `src/components/NewVersionBanner.tsx` | Schema version prompt. |

### Documentation

| File | Purpose |
|---|---|
| `docs/USER_GUIDE.md` | Complete user guide. |
| `docs/SELF_HOSTING.md` | VPS + nginx + TLS deployment guide. |
| `docs/KEY_CUSTODY.md` | Key custody guide. |
| `docs/CONTENT_DISPUTE_POLICY.md` | Dispute policy + GDPR. |

### Entry points

| File | Purpose |
|---|---|
| `src/App.tsx` | About tab, NewVersionBanner, schema version polling. |
| `src/main.tsx` | Imports i18n before App. |
| `src/chronicle.css` | Design system — navy/gold. |

---

## Dependencies

```
# Runtime
nostr-tools, @noble/secp256k1, @noble/curves, @scure/bip32, @scure/bip39
react-i18next, i18next, i18next-browser-languagedetector
bootstrap, react-bootstrap
tweetnacl, tweetnacl-util
ws
d3, @types/d3
secrets.js-34r7h@^2.0.2

# Relay (cd relay && npm install separately)
better-sqlite3, ws

# Root (install on dev machine after npm install)
better-sqlite3, @types/better-sqlite3

# Dev
vitest, @vitest/ui, @types/node, @types/ws
concurrently, cross-env, electron-builder
electron  ← install manually: npm install --save-dev electron
electron-updater  ← install manually: npm install electron-updater
```

---

## Architecture Decisions Made

- **Kind 0 is off-limits.** Chronicle never reads or writes Nostr kind 0.
- **User key vs ancestor key derivation.** User: BIP39 mnemonic at `m/44'/1237'/0'/0/0`. Ancestor: random independent keypair, stored encrypted.
- **No hardcoded user-facing strings.** All strings through `useTranslation()` and `en.json`.
- **Confidence scores computed, not stored.** Populated at read time, never persisted.
- **Retracted claims stay in the database.** Flagged, excluded from scoring, visible in history.
- **Local relay port:** `ws://127.0.0.1:4869`.
- **Graph store uses pluggable backend (Stage 7).** `setGraphBackend(sqliteStore)` wires up persistence in Electron. `_resetGraphStore()` reverts to in-memory for tests.
- **`schemaVersionChecker.ingestEvent()` wired into `relaySync.ingestEvent()`** — every ingested event is now checked for newer schema versions.
- **SqliteStore extended with graph + media tables (Stage 7).** Schema: `relationships`, `acknowledgements`, `same_person_links`, `media_cache`. Row mappers are module-private functions at end of file.
- **D3 uses force-directed layout.**
- **EOSE now wired.** `fetchOnConnect` resolves promptly via `onEose`; 10s timeout is fallback.
- **Electron spawns relay as child process.** `DB_PATH`/`ALLOWLIST_PATH` set to `userData`.
- **SqliteStore is a drop-in for MemoryStore.** Identical public API plus graph methods.
- **`MediaCache` uses pluggable backend.** `mediaCache.setBackend(sqliteStore)` in Electron main; `getAllMediaCache()` returns `MediaCacheEntry[]` for hydration; `getMediaCache(url)` returns raw `MediaCacheRow` for test compatibility.
- **Electron `initSqliteStore()`** constructs SqliteStore at `userData/chronicle.db`, injects into graph and media cache. Fails gracefully if compiled output not present (dev without pre-build).
- **Contact list encrypted with user's own NaCl secretbox key** derived from nsec hex (first 32 bytes).
- **Trust revocations require at least 1 endorsement** before `isRevoked()` returns true.
- **Family shared key is a 32-byte NaCl secretbox key.**
- **Shamir SSS is for ancestor key custody only** — 3-of-5 default.
- **Key supersession requires 3 recovery contact attestations.**
- **DisputeStore is module-level.** Tests use `new DisputeStore()` directly.
- **Schema version checker polls every 5s in App.tsx.**
- **Electron auto-updater** uses `electron-updater` with `autoDownload: true`.
- **French translation complete.**

---

## Stage 7 — Status

### Complete ✅
1. ✅ `electron/main.js` — `initSqliteStore()`: constructs SqliteStore, injects graph backend + media cache backend on app ready (Stage 7)
2. ✅ `blossom.ts` — `MediaCacheBackend` interface + `MediaCache.setBackend()` with hydration; all mark* methods persist to backend (Stage 7)
3. ✅ `src/__mocks__/better-sqlite3.js` + `node_modules/better-sqlite3/` — full Stage 7 mock with all tables including relationships, acknowledgements, same_person_links, media_cache (Stage 7)
4. ✅ `sqliteStore.ts` — schema extended with `relationships`, `acknowledgements`, `same_person_links`, `media_cache` tables; all CRUD methods added (Stage 7)
2. ✅ `graph.ts` — `GraphBackend` interface, `MemoryGraphStore`, `setGraphBackend()`/`getGraphBackend()` injection API (Stage 7)
3. ✅ `relaySync.ts` — `schemaVersionChecker.ingestEvent()` wired into ingest path (Stage 7)
4. ✅ `sqliteStore.graph.test.ts` — 23 tests for relationships, acknowledgements, same-person links, media cache
5. ✅ `graph.sqlite.test.ts` — 9 tests for SQLite backend delegation, traversal, serialisation
6. ✅ Vite 8 / OXC tsconfig fix — `tsconfig.json` replaced, `oxc.tsconfigFilename` removed
7. ✅ `contentDispute.ts` — npub guard, unused imports removed
8. ✅ `better-sqlite3` mock — full rewrite: upsert, OR IGNORE, ON CONFLICT DO NOTHING, OR+AND WHERE, split SET/WHERE params, FTS JOIN

### Deferred / Remaining ⏳
- WebRTC peer-to-peer relay sync (carried from Stage 4/5)
- Additional community language files beyond English + French

---

## GitHub Actions Workflows

Two workflow files added to `.github/workflows/`:

### `ci.yml` — Continuous Integration
Runs on every push to `main` and every pull request. Performs:
1. `npm ci` — clean install
2. Restore `better-sqlite3` mock (wiped by `npm ci`)
3. TypeScript check (`tsc --noEmit`)
4. Full test suite (`npm test`)
5. Vite build (catches compile errors)

Fast — Linux only, no Electron build.

### `release.yml` — Release Build
Triggered by pushing a version tag (e.g. `git tag v1.0.0 && git push origin v1.0.0`).

Runs three parallel jobs on GitHub's own machines:
- `build-mac` — macOS runner → produces `.dmg` + `.zip`
- `build-windows` — Windows runner → produces `.exe` (NSIS installer + portable)
- `build-linux` — Ubuntu runner → produces `.AppImage` + `.deb`

Each job: installs deps, restores mock, runs tests, builds Vite app, builds Electron installer.

Final `release` job: downloads all artifacts and creates a GitHub Release with all installers attached. Tags containing `-` (e.g. `v1.0.0-beta.1`) are automatically marked as pre-release.

**No secrets required** for unsigned builds. Code signing secrets documented in comments at the bottom of `release.yml`.

### Releasing — the complete process
```bash
# 1. Make sure everything is committed and pushed
git add -A && git commit -m "Release v1.0.0"
git push origin main

# 2. Tag the release
git tag v1.0.0
git push origin v1.0.0

# 3. Wait ~10 minutes — GitHub builds Mac + Windows + Linux in parallel
# 4. Find the release at: https://github.com/YOUR_USERNAME/chronicle/releases
```

### Gotcha: `npm ci` wipes `node_modules/better-sqlite3/`
Both workflows include a "Restore better-sqlite3 mock" step immediately after `npm ci`. This must stay in place — see gotcha #31.

---

## Stage 8 — Mobile (Capacitor)

**Goal:** Chronicle available as a native iOS and Android app, sharing all cryptographic and genealogy logic with the desktop version.

### Approach: Capacitor

Capacitor wraps the existing React app in a native iOS/Android shell. All of `src/lib/` (keys, claims, confidence scoring, graph, privacy tiers, etc.) is reused unchanged. The UI components are reused with minor adaptations. Only the platform-specific layers are replaced.

### What changes on mobile vs desktop

| Concern | Desktop (Electron) | Mobile (Capacitor) |
|---|---|---|
| SQLite | `better-sqlite3` (native Node addon) | `@capacitor-community/sqlite` plugin |
| Embedded relay | Spawned as Node child process | **Not used** — connect to family relay or VPS instead |
| File system | Node `fs` module | Capacitor Filesystem plugin |
| Key storage | Encrypted file via `storage.ts` | Capacitor SecureStorage plugin (uses iOS Keychain / Android Keystore) |
| App updates | `electron-updater` | App Store / Google Play update mechanism |
| Sync | WebRTC + embedded relay | WebRTC (still works) + family relay |

### Architecture decision: no embedded relay on mobile

Running a WebSocket relay server as a background process is not appropriate on mobile (battery drain, OS restrictions on background processes). Mobile Chronicle connects to:
1. A relay run by another family member on their desktop Chronicle instance (already supported)
2. A self-hosted VPS relay (documented in `docs/SELF_HOSTING.md`)
3. A future hosted Chronicle relay service (optional, out of scope for Stage 8)

This is actually cleaner than the desktop model — mobile users are naturally consumers/contributors rather than relay hosts.

### What needs building

**New files:**
- `capacitor.config.ts` — Capacitor configuration (app ID, server URL, plugins)
- `src/platform/index.ts` — platform abstraction layer: detects Electron / Capacitor / browser and exports the right implementations of storage, SQLite, file access
- `src/platform/capacitor/sqlite.ts` — wraps `@capacitor-community/sqlite` to match `SqliteStore`'s API
- `src/platform/capacitor/secureStorage.ts` — wraps Capacitor SecureStorage for key material
- `src/platform/capacitor/filesystem.ts` — wraps Capacitor Filesystem for media cache paths
- `src/components/mobile/` — mobile-specific UI overrides where Bootstrap components need native feel (bottom sheet nav, pull-to-refresh, etc.)
- `.github/workflows/mobile.yml` — GitHub Actions workflow: builds `.ipa` (iOS) and `.apk`/`.aab` (Android) on tag push

**Modified files:**
- `src/App.tsx` — detect platform, render mobile nav shell if Capacitor
- `electron/main.js` — no changes needed (desktop-only, untouched)
- `package.json` — add Capacitor dependencies, add `build:ios` and `build:android` scripts

**Not changed:**
- All of `src/lib/` — zero changes required
- All existing React components — used as-is on mobile, with mobile overrides layered on top where needed
- i18n — works identically
- All tests — run identically (Capacitor plugins are mocked in Vitest the same way better-sqlite3 is)

### Platform abstraction layer

The key design principle is that `src/lib/` modules never import from Electron or Capacitor directly. Instead they import from `src/platform/index.ts`, which exports the right implementation at runtime:

```ts
// src/platform/index.ts
import { isElectron, isCapacitor } from './detect'

export const storage = isElectron()
  ? await import('./electron/storage')
  : isCapacitor()
    ? await import('./capacitor/secureStorage')
    : await import('./web/storage')
```

This pattern means the same `src/lib/storage.ts` works on all three platforms without modification.

### App Store / Google Play distribution

- **iOS:** Requires Apple Developer account ($99/year). App submitted via Xcode or `xcrun altool`. Review takes 1–3 days. Chronicle's content (family genealogy, no social features, no payments) is low-risk for approval.
- **Android:** Requires Google Play developer account ($20 one-time). App submitted via Google Play Console. Review takes a few hours to 1 day.
- Both can be automated via GitHub Actions using `fastlane` (a free open-source tool for app store automation). The `mobile.yml` workflow would handle signing, building, and submitting to TestFlight (iOS beta) and Play Internal Testing track.

### GitHub Actions — mobile workflow outline

```
on: push tags v*.*.*

jobs:
  build-ios:
    runs-on: macos-latest
    steps: checkout → node setup → npm ci → cap sync ios → xcode build → upload .ipa

  build-android:
    runs-on: ubuntu-latest
    steps: checkout → node setup → npm ci → java setup → cap sync android → gradle build → upload .aab
```

Requires additional GitHub Secrets:
- iOS: Apple Developer certificate + provisioning profile
- Android: Keystore file + passwords

### Dependencies to add

```
@capacitor/core
@capacitor/cli
@capacitor/app
@capacitor/filesystem
@capacitor/preferences        ← replaces localStorage for small key-value data
@capacitor/status-bar
@capacitor/splash-screen
@capacitor-community/sqlite   ← SQLite on mobile (matches better-sqlite3 API)
@capacitor/secure-storage     ← iOS Keychain / Android Keystore for key material
```

### Estimated scope

Comparable to Stage 4 in complexity. The platform abstraction layer is the most important design decision — getting that right means desktop and mobile stay in sync with zero duplication of business logic. UI adaptation is mechanical once the platform layer is solid.

### Pre-requisites before starting Stage 8

- Xcode installed (macOS only, required for iOS build)
- Android Studio installed (any platform, required for Android build)
- Apple Developer account enrolled (for iOS device testing and App Store)
- Google Play developer account created (for Android distribution)
- Stage 7 complete ✅

### Fix 5: Persistence not surviving app shutdown + relationship editing in edit mode

**Root cause (persistence):** `localStorage` is unreliable in Electron when the app is built and loaded as a `file://` URL — writes can fail silently due to the null origin + sandbox combination. Also `localStorage` is scoped per session in some configurations, so app shutdown loses it.

**Fix — proper Electron file storage:**
- `electron/main.cjs` — added `store-get` / `store-set` IPC handlers that read/write JSON files directly to `app.getPath('userData')` (survives restarts unconditionally)
- `electron/preload.cjs` — exposed `storeGet` / `storeSet` via context bridge
- `src/lib/appStorage.ts` (new) — thin async abstraction: uses Electron IPC when `window.chronicleElectron` is present, falls back to `localStorage` in browser/dev mode
- `src/context/AppContext.tsx` — all `localStorage` calls replaced with `storageGet` / `storageSet`; restore-on-mount is now async
- `src/components/AddPersonModal.tsx` — `persistNow` uses `storageSet`

**Fix — relationship editing:**
- Edit modal now shows existing relationships for the person
- Both add and edit modes show the "add a relationship" UI
- Relationship save logic no longer gated to add-only; works in edit mode too

### Fix 6: Family tree visualisation — generational layout

**Problem:** Force-directed layout placed nodes randomly — not recognisable as a family tree.

**Replacement:** Generational hierarchical layout:
- BFS from root assigns each person a generation number (parent edges = gen-1, child edges = gen+1, spouse/sibling = same gen)
- Nodes laid out in horizontal rows per generation, evenly spaced, centred on root
- Parent→child edges drawn as elbow connectors (vertical with rounded corners) rather than straight lines
- Spouse/sibling edges drawn as short horizontal dashed lines between same-row nodes
- Auto-zoom-to-fit on load so the whole tree is visible without manual scrolling
- Larger nodes (180×64px vs 160×56px), slightly larger text
- Faint generation labels on left edge for orientation
- Drop shadows on cards for depth
- Legend updated with spouse line style

### Fix 7: Tree layout inversion + duplicate relationships in edit modal

**Bug 1 — Tree layout inverted:** `assignGenerations` was not direction-aware. A `parent` edge from Matt→Stephen was being interpreted as "Matt is parent of Stephen → Stephen is gen+1" when traversed from Matt's side, but also as "parent" when traversed from Stephen's side — producing wrong results. Fixed by tracking whether we're traversing as the subject or object of each edge, then applying the correct delta in each case.

**Bug 2 — Duplicate relationships in edit modal:** `getRelationshipsFor()` returns all edges touching a person (both A→B and B→A). The edit modal was showing both, producing "Child of Layla" and "Parent of Layla" for the same relationship. Fixed by filtering to only `subjectPubkey === editPerson.pubkey`.

**Bug 3 — Relationship direction stored incorrectly:** The UI dropdown described what the *other* person is to the subject (e.g. "Stephen is Parent of Matt"), but the code was storing that relationship type directly on the subject (making Matt a "parent" of Stephen). Added `subjectRelationship()` which inverts before storing on the subject, so the semantics are consistent throughout.

**UX improvement — relationship selector:** Added a contextual hint label under the person selector showing "[Other] is … of [subject]" so the direction is unambiguous.

**Edit modal relationship display:** Now shows "Stephen is Parent of Matt" (reading correctly) rather than "child of Stephen" (confusing).

### Fix 8: Delete person, remove relationships, fixed relationship direction default (v1.0.28)

**Bug — mother recorded as child:** The `relationshipType` state defaulted to `'child'`, meaning if a user selected a person from the dropdown without changing the selector, the selected person was recorded as a child of the new person. Changed default to `'parent'` (most common case when adding ancestors). Also replaced the dropdown selector with pill buttons so the choice is explicit and visible.

**New — delete person:** `MemoryStore.deletePerson()` removes the person, all their claims, and their endorsements. `AppContext.deletePerson()` additionally retracts all their graph relationships. A "Delete this person…" button appears at the bottom of the edit modal with a confirmation step before committing.

**New — remove individual relationships:** The edit modal now shows each existing relationship with a ✕ button. Clicking it retracts both the forward and inverse edges from the graph store and persists immediately.

**UX — relationship selector redesigned:** Replaced the ambiguous dropdown with pill buttons labelled by what the *other* person is to the subject ("Parent / Child / Spouse / Sibling / Grandparent / Grandchild"). A hint line reads "[Other] is the … of [subject]" and a confirmation line shows exactly what will be stored before saving.

### Manual update checker in Settings (v1.0.30)

**Changes:**
- `electron/main.cjs` — removed automatic update check on startup and the 4-hour polling interval; added `get-version` and `check-for-update` IPC handlers; auto-updater now emits a single `update-status` event (type: `checking` | `available` | `up-to-date` | `downloading` | `ready` | `error`) with `currentVersion`, `newVersion`, `percent`, and `message` fields
- `electron/preload.cjs` — exposed `getVersion()`, `checkForUpdate()`, `installUpdate()`, and `onUpdateStatus(callback)` (returns unsubscribe fn) via context bridge
- `src/lib/appStorage.ts` — added `UpdateStatus` interface
- `src/components/SettingsView.tsx` — new "App Updates" section at bottom of settings (only shown inside Electron); shows current version, "Check for updates" button, progress bar during download, and "Restart and install vX.Y.Z" button with clear from/to version display once ready

### Tree visualisation redesign (v1.0.31)

- Background changed from dark (#080f1e) to cream (var(--cream)) matching the rest of the app
- Node cards: white background with navy text and gold accents for root node; border-soft for others
- Edges: gold connectors instead of blue/grey; spouse/sibling edges dashed gold
- Removed dark overlay toolbar; replaced with a slim light toolbar matching app nav style
- Tree fills the full viewport below the nav bar (app-shell max-width removed for graph tab; app-content overflow:hidden + flex layout)
- Clicking a node opens a slide-in action panel on the right showing: name, dates, birthplace; action buttons for Edit information, View full profile, Photos & media (coming soon), Stories (coming soon), Documents (coming soon), Timeline (coming soon); "Make this person the tree root" at the bottom
- onEditPerson prop added to FamilyTreeView; wired from App.tsx

### Fix: auto-updater 404 (v1.0.32)

**Root cause:** electron-builder defaults to outputting installers into `dist/`, the same directory Vite uses for the web app bundle. This caused the artifact upload globs (`dist/*.exe`, `dist/*.yml`) to either pick up wrong files or miss the `latest.yml` that electron-updater requires.

**Fix:**
- `package.json` build config: added `directories.output = "release"` — electron-builder now writes installers and `latest.yml` to `release/` rather than `dist/`
- `.github/workflows/release.yml`: updated all artifact upload paths from `dist/*` to `release/*`; split Vite build and electron-builder into separate named steps; added a `List release output` step per platform to make future debugging easy; updated yml filenames to `latest.yml` (Windows), `latest-mac.yml` (Mac), `latest-linux.yml` (Linux)
- The `release` job already correctly uses `softprops/action-gh-release` to attach all artifacts — no change needed there

### Simplified relationships, metadata, improved cards (v1.0.33)

**Relationship types simplified:**
- Removed `grandparent` and `grandchild` from `RelationshipType` — these are redundant since grandparent relationships emerge naturally from two parent hops in the graph
- Only `parent | child | spouse | sibling` remain
- Updated `relaySync.ts` validation list to match

**Relationship metadata (`RelationshipMeta` in `chronicle.ts`):**
- `startDate` / `endDate` — free text date for relationship start/end
- `status` — `married | unmarried | separated | divorced | widowed`
- `childrenFromYear` / `childrenToYear` — date range in which children from this couple were born
- `adopted` — boolean flag on parent/child edges
- Stored as optional `meta` field on `RelationshipClaim` in `graph.ts`
- UI shows spouse metadata form (status pills, date fields, children range) and parent/child adopted checkbox in `AddPersonModal`

**ProfileCard improvements:**
- New `RelationshipsSection` below the fact fields: shows all relationships grouped (spouse first, then parents, children, siblings), with metadata displayed inline
- Relies on `getRelationshipsFor` filtered to subject-only edges

**PersonListItem improvements:**
- Now shows birthplace alongside dates (`b. 1979 · Portsmouth`)
- Uses highest-confidence claim for each field

**Notes for next session:**
- Ancestor keypairs deliberately dropped — to be revisited with social recovery model
- Existing stored relationships have no `meta` — will display without metadata, which is fine

### Fix: auto-updater 404 (attempt 2) (v1.0.34)

**Root cause analysis:** electron-builder doesn't always write the installer directly to `release/` — NSIS builds go to `release/` but in some configurations electron-builder nests output in subdirectories. The artifact upload glob `release/*.exe` was too shallow.

**Fixes:**
- `package.json`: added explicit `artifactName: "${productName}-Setup-${version}.${ext}"` so the filename is 100% predictable; removed `portable` from Windows targets (portable builds don't support auto-update and were creating a second exe that could confuse the updater)
- `.github/workflows/release.yml`: changed all artifact upload globs to recursive (`release/**/*.exe` etc.); added `if-no-files-found: warn` so build failures are visible; added a "Flatten artifacts" step in the release job that copies all installer files and `.yml` files into a single flat directory before uploading to GitHub Releases — this ensures `latest.yml` and the exe land at the root of the release, which is what electron-updater expects when constructing download URLs

**Windows Defender SmartScreen warning:** expected for unsigned builds — not related to the updater failure. Requires an EV code signing certificate to suppress; deferred.

### Fix: auto-updater — clean release assets (v1.0.35)

**Diagnosis:** v1.0.34 release assets confirmed correct — `Chronicle-Setup-1.0.34.exe`, `Chronicle-Setup-1.0.34.exe.blockmap`, and `latest.yml` all present. The 404 in v1.0.33 was because that installed version had a malformed `app-update.yml` baked in from the earlier broken builds.

**Resolution:** Install v1.0.34 manually (one last time), then test the in-app updater for v1.0.35. The `app-update.yml` baked into v1.0.34 is correct and should allow the updater to work going forward.

**Also fixed:** The flatten step in `release.yml` was too greedy — it was picking up `Chronicle.exe` and `elevate.exe` from `win-unpacked/` and uploading them to the release. Fixed the find pattern to only match `*-Setup-*` installer files and `latest*.yml`, excluding unpacked directory contents.

### Family tree rewrite — children below parents, multiple relationships per save (v1.0.47)

**Problem:** Despite several attempts, the family tree was not reliably showing children below parents, parent→child connector lines were sometimes missing, and adding multiple children to a parent required several separate modal sessions because the modal supported only one relationship per save. The relationship picker UI was also worded so that adding "Stephen is the parent of Matt" required the user to mentally invert the wording.

**Root cause:**
1. **AddPersonModal supported a single relationship per save.** Adding a parent with three existing children required four modal openings.
2. **The relationship label was ambiguous.** UI read "[Other] is the … of [Subject]" with Subject = new person. Default state was `'parent'`, which combined with the inverted wording made mis-stores easy.
3. **Layout maths lived inline in the React component** with no unit tests. Any regression in edge handling or generation BFS was invisible until the user noticed broken visuals.

**Fix:**

1. **`src/components/AddPersonModal.tsx` — full rewrite of the relationship section.**
   - Multiple relationship rows are now added in a single save. Each row has its own person picker, relationship type, and metadata.
   - Wording is now subject-first: "**[new person]** is the … of [existing person]" with a "Will save:" preview before commit.
   - Storage invariant documented in plain English at the top of the file (subject IS rel OF related, stored as TWO mirrored claims).
   - Default relationship type for new rows is `'child'` (the most common case when adding ancestors: the new person is a child of someone already in the tree).
   - In edit mode, existing relationships are listed with a remove (✕) button, and new rows can still be added in the same save.

2. **`src/components/FamilyTreeView.tsx` — full rewrite of layout and rendering.**
   - Edges are normalised first: every parent/child claim pair becomes a single directed `parent → child` edge; every spouse claim pair becomes one undirected spouse edge.
   - Generations are assigned by strict BFS from root using only parent-child deltas (parents at gen-1, children at gen+1) and spouse equality. Y position is `gen × (NODE_H + V_GAP)` — children are therefore mathematically guaranteed to be below parents.
   - One elbow connector is drawn per normalised parent-child edge — no longer relying on bidirectional traversal output to be deduplicated by the renderer.

3. **`src/components/FamilyTreeView.layout.ts` — new pure module.**
   - Exports `normaliseEdges`, `assignGenerations`, `computeLayout` plus `NODE_W`/`NODE_H` and friends.
   - Re-exports the same functions prefixed with `__test_` for the test suite.
   - Pure functions only, no React, no D3.

4. **`src/lib/familyTreeLayout.test.ts` — new test file, 15 tests.**
   - Generation tests: root alone, one parent, two parents, one child, multiple children, three-generation chain, spouse-shares-generation.
   - Position tests: parent above child, multiple children share a row, two parents share a row, spouses on same row but distinct x.
   - Edge normalisation: forward+inverse pair collapses to one parent-child edge; multiple distinct pairs preserved; spouse pair collapses to one edge.
   - End-to-end: Matt with two parents and two children produces three distinct y rows and exactly four parent-child edges.

**Tests:** 631/631 passing (was 616/616 + 15 new).
**TypeScript:** clean.
**Build:** clean (Vite reports the same pre-existing harmless warnings about `node:crypto` and `tweetnacl-util` per gotcha #25).

### Gotcha #34 — Layout maths must stay in `FamilyTreeView.layout.ts`

The pure functions `normaliseEdges`, `assignGenerations`, `computeLayout` live in `src/components/FamilyTreeView.layout.ts` and are unit-tested in `src/lib/familyTreeLayout.test.ts`. If a future change needs to alter how the tree positions nodes or which edges count for layout, **change the layout module and add a failing test first**, then make it pass. Do not move this logic back inline into the React component — there will be no way to verify regressions otherwise.

### Gotcha #35 — Two relationship claims per user-facing relationship

Every relationship the user sees in the UI is stored as TWO Nostr claims — one in each direction. `AddPersonModal.handleSave` writes both. `traverseGraph` returns both. The tree view's `normaliseEdges` step is responsible for collapsing them back into one canonical edge per unordered pair. **Do not rely on traversal output being deduplicated** — collapse them yourself.

### Family tree — children grouped under their actual parents (v1.0.48)

**Problem reported on v1.0.47:** Stephen and Eddie are both children of Ralph + Diane, while Maria is a child of Bill + Patricia. The tree placed Stephen between Bill and Diane, making it look as though Stephen was a child of Bill+Patricia and that Stephen + Maria were siblings who had married each other.

**Root cause:** The v1.0.47 layout did the right thing per-slot (each slot was sorted by its parent x), but then placed slots at uniform `H_GAP` intervals. When Stephen and Eddie shared parents at one side and Maria's parents were on the other side, Eddie got pushed to the centre of the row because there was no notion of "siblings stay together as a group".

**Fix in `src/components/FamilyTreeView.layout.ts` — `computeLayout` rewritten as a group-based placement:**

1. **Top-down BFS placement** (was bottom-up): place generations from oldest to youngest, so by the time we lay out a row, every parent is already positioned.
2. **Sibling grouping by parent-set**: every slot in a generation is grouped by its parent-set key (the sorted union of its members' parents). Slots that share parents become one group, laid out adjacently.
3. **Per-group target x**: each group's preferred centre is the average x of its parents. Groups are sorted left-to-right by that target.
4. **Overlap resolution**: groups are placed left-to-right; if a later group's target would overlap its predecessor, it's pushed right. A pull-back pass then tries to slide earlier groups rightward (toward but not past their own targets) so the row is centred more naturally.
5. **Larger inter-group gap** (`INTER_GROUP_GAP = H_GAP + 24`) makes it visually obvious where one sibling cluster ends and another begins.
6. **Root anchor**: after all generations are placed, the whole tree is shifted horizontally so the root sits at x = 0. The viewport auto-fit then centres it.

**Two regression tests added in `src/lib/familyTreeLayout.test.ts`:**
- "Stephen and Eddie sit on the same side as Ralph + Diane; Maria sits under Bill + Patricia" — asserts that Stephen and Eddie are closer to Ralph+Diane's midpoint than to Bill+Patricia's midpoint, and that Maria is closer to Bill+Patricia's midpoint than Ralph+Diane's. This is the exact regression scenario from the screenshot.
- "grandparents row: couples sit adjacent, not interleaved" — asserts that the within-couple distance is smaller than every cross-couple distance.

**Tests:** 633/633 passing (was 631 + 2 new).
**TypeScript:** clean.
**Build:** clean.

### Gotcha #36 — Sibling groups, not equal spacing

When laying out a row, **siblings (slots with the same parents) must be placed adjacently and centred over those parents, NOT spaced evenly with everyone else in the row**. Equal H_GAP spacing means a sibling whose siblings are clustered tightly will drift away from them if the row contains other slots with different parents. If you ever change the layout algorithm, the regression test "Stephen and Eddie sit on the same side as Ralph + Diane" is your guard.

### Family tree — parents now centre over their children (v1.0.49)

**Problem reported on v1.0.48:** Sibling grouping was correct (Eddie+Phil+Stephen all clustered together as Diane+Ralph's children), but the parent couples in the row above were still placed by input order, not centred over their children. Stephen+Maria's couple-midpoint (the point the connector arm rises from) sat to the right of Patricia's drop line, so the arms crossed visibly.

**Root cause:** `computeLayout` only did a top-down pass. When laying out the grandparent row, no children were placed yet, so the row was assembled in raw input order. Children were then placed correctly below — but the parents never moved.

**Fix in `src/components/FamilyTreeView.layout.ts` — two-pass layout:**

1. **Pass 1 (top-down)** — unchanged from v1.0.48. Places generations oldest → youngest, grouping siblings by parent-set and ordering groups by parent x.
2. **Pass 2 (bottom-up re-centring)** — new. For each generation youngest → oldest, every sibling group is slid so its centre matches the centroid of its children's x positions. Movement is constrained by the group's neighbours in the same row — a group can only slide as far as the gap to its neighbours allows. Three sweeps are run so alignment can propagate up multiple generations.
3. **Root anchor** at the end is unchanged.

**Verified on the screenshot 140 fixture:**
- Diane+Ralph midpoint = -252, children Eddie+Phil+Stephen avg x = -252 (gap: 0)
- Patricia+Bill(sr) midpoint = 444, children Maria+Bill(jr)+Sonya avg x = 444 (gap: 0)

**Two regression tests added** to `src/lib/familyTreeLayout.test.ts`:
- "each grandparent couple sits directly above the midpoint of their own children" — the screenshot 140 scenario.
- "a single parent couple with multiple children sits centred above them" — the simpler base case.

**Tests:** 635/635 passing (was 633 + 2 new).
**TypeScript:** clean.
**Build:** clean.

### Gotcha #37 — Layout requires a bottom-up re-centring pass

Top-down placement alone is not enough. Without the bottom-up sweep, parents end up in input order regardless of where their children land, and the connector arms cross between generations. **If a future change to the layout removes the bottom-up loop, the screenshot 140 regression test will fail.** Three sweeps is usually enough for trees up to ~7 generations; very tall trees may need more iterations, but 3 is a safe default.

### Family tree — cousins land under their own parents; cleaner connector beams (v1.0.50)

**Problem reported on v1.0.49:** Adding Hannah as a child of Hellen+Neil (who sit on one side of the parents row) placed Hannah on the OPPOSITE side of Matt's generation rather than under her actual parents. Additionally, the great-grandparents row appeared as one continuous horizontal bar because each couple's T-junction beam sat at the same midY and fused visually.

**Root causes:**
1. **Root group was force-pinned at the front of its generation.** The grouping code created a singleton group for any slot containing the root, then sorted with `hasRoot ? -1 : 1`. This meant the root's group always sat at the left of its row regardless of where its parents actually were, and the root's siblings (e.g. Laura) ended up in a separate group that wasn't visually adjacent.
2. **All parent→child connector beams drew at midY** (halfway between rows). When many unrelated couples in one row drop down to children in the next, all their horizontal beams sit at one shared Y and fuse into a continuous bar.

**Fix in `src/components/FamilyTreeView.layout.ts`:**
- Removed the singleton-group special case for the root. The root joins its sibling group by parent-set like any other member. Pass 2 (bottom-up re-centring) still skips the root's group from sliding, so the root's x remains the tree anchor.
- Removed the `hasRoot` priority from group sorting. Groups sort purely by parent x.
- The end-of-layout root-shift (anchor root to x=0) still runs, so the visual centre still matches the user's identity.

**Fix in `src/components/FamilyTreeView.tsx`:**
- Connector beam Y position changed from `midY = (y1 + y2) / 2` to `armY = y2 - 28` (28px above the child). Each T-junction now hugs its own children's row instead of spanning the full vertical gap. The vertical legs from parents are longer, the horizontal beams are shorter and visually distinct between unrelated couples.

**Two regression tests added** to `src/lib/familyTreeLayout.test.ts`:
- "cousin whose parents are far left of root sits at the far left of root's row" — Hannah lands at her parents' midpoint, not stranded among Matt's siblings.
- "Matt's siblings group with Matt rather than being a separate sibling group" — verifies that Laura (Matt's sister) is now within H_GAP of Matt, not pushed into a separate sibling group.

**Tests:** 637/637 passing (was 635 + 2 new).
**TypeScript:** clean.
**Build:** clean.

### Gotcha #38 — Root is not special during slot grouping

The root must group with its siblings by shared parent-set like any other member of the generation. **Do not** force the root's slot into a singleton group: doing so will visually exile the root's siblings to a separate cluster and prevent the root's cousins from sitting beneath their own parents. The only special treatment the root still gets is being skipped during Pass 2 re-centring (so the whole tree doesn't drift when the root's children are off-centre) and the final tree-wide shift that anchors root to x=0.

### Gotcha #39 — Parent→child beams sit close to the child, not at midY

If you move the elbow Y position back to midY, multiple unrelated parent groups in the same generation will all draw their horizontal beams at the same Y, fusing visually into a single bar. Keep `armY = y2 - 28` (or similar, tied to the child top) so each T-junction stays close to its child.

### Family tree — connectors drawn per sibling cluster, not per edge (v1.0.51)

**Problem reported on v1.0.50:** Adding Reece and Rayleigh as Jeff's children, alongside Hellen+Neil's children (Hannah, Emma, Jake) and Stephen+Maria's children (Matt+Caroline, Laura), made the horizontal connector bars between the parents' row and the children's row fuse into one continuous line across the entire width of the tree.

**Root cause:** Each parent→child edge was being drawn as its own elbow with a horizontal "arm" at `y2 - 28` (28px above the child). When multiple unrelated couples in one row dropped to children in the next row, every couple's elbow sat at the **same Y**, and the gaps between them disappeared into a single long bar.

**Fix in `src/components/FamilyTreeView.tsx` — per-cluster trunk rendering:**

Parent→child connectors are no longer drawn one-per-edge. They're now drawn one-per-**sibling cluster**, where a sibling cluster is the set of children sharing the same parent-set. For each cluster:

1. From each parent, a leg drops to `parentArmY = y1 + 28` (just below the parents' row) and runs horizontally to the cluster's **trunk x** (the midpoint of the children's positions).
2. A single vertical **trunk** runs from `parentArmY` down to `childArmY = y2 - 28` at the trunk x.
3. The horizontal **children's beam** at `childArmY` spans only from the leftmost child to the rightmost child in **this cluster** — not across the entire row.
4. Each child drops a short vertical from the beam (or directly from the trunk if the cluster has only one child) into its card.

Adjacent unrelated sibling clusters now have visible vertical-air gaps between their beams, because each beam tightly spans only its own cluster's children. The trunk-and-beam shape also gives each family group a clear visual identity.

**Edge cases handled:**
- Single parent, single child, same x: the parent's leg, trunk, and child drop all align — drawn as one continuous vertical line.
- Single parent, single child, different x: parent draws an L-shape to the trunk, no beam is drawn (only one child), child drops straight down.
- Sensitive flag: if any edge in the cluster is sensitive, the whole cluster is drawn dashed (`stroke-dasharray: 4,4`).

**Tests:** 637/637 passing (no new tests — the change is purely rendering, and the existing layout tests remain valid).
**TypeScript:** clean.
**Build:** clean.

### Gotcha #40 — Draw connectors per sibling cluster, not per edge

If you ever revert to drawing one elbow per parent→child edge, multiple unrelated clusters in the same row will fuse into a single horizontal bar at the shared `armY`. The trunk-and-beam pattern in `FamilyTreeView.tsx` (group edges by `parents.sort().join('|') + '→' + childY` and draw one trunk per cluster) is the fix. Removed: the constant `CORNER_R` (was only used by the per-edge drawer; the cluster drawer uses a local `cornerR = 8`).

### Family tree — parent-side beams strictly bounded by their own parents (v1.0.52)

**Problem reported on v1.0.51:** Patricia and Bill (grandparents) are married, so they sit adjacent in the tree. Each is the only child of their own parents (PatriciaMum+PatriciaDad, and BillMum+BillDad). The two parent-beams at `parentArmY` overlapped, looking like one continuous horizontal line — the same fusion issue, just one row higher up the tree.

**Root cause:** v1.0.51 drew each cluster's trunk as an **L-shape from each parent to childMidX**, where childMidX = the cluster's child's x position. If a child is offset from its parents (because the child is part of a couple with a spouse from a different family), the L-shape's horizontal segment extends BEYOND the parents' bounding box. For Patricia (child of PatriciaMum+Dad, but offset right toward Bill), the L-shape's horizontal segment ran from PatriciaMum.x all the way over to Patricia.x — into Bill's parents' territory. Bill's symmetric L did the same in reverse, and the two overlapped.

**Fix in `src/components/FamilyTreeView.tsx` — three-band cluster rendering:**

Each cluster's connector is now three horizontal Y bands instead of two:
1. **`parentArmY`** (just below parents' row): the parents' beam is strictly bounded by `[parentMinX, parentMaxX]`. Each parent drops a pure vertical leg to this Y; the beam connects parents to each other only. No horizontal segment extends past either parent.
2. **`junctionY`** (midway between rows): a short horizontal "dogleg" runs from `parentMidX` over to `childMidX`. This is where offset alignment happens.
3. **`childArmY`** (just above children's row): the children's beam is strictly bounded by `[childMinX, childMaxX]`. Each child drops a pure vertical leg from this Y to its card.

The two trunk verticals sit at `parentMidX` (above the dogleg) and `childMidX` (below the dogleg), so the connector path makes a clean dogleg only where it needs to.

**Visual result:** at `parentArmY` and `childArmY`, every cluster's beam is locked inside its own row's bounding box. Adjacent unrelated couples' beams cannot overlap regardless of how their children are positioned. The dogleg at `junctionY` is free to slope sideways but is bounded by `[parentMidX, childMidX]` per cluster, so even doglegs have a clear gap when clusters are well-separated.

**Tests:** 637/637 passing (no new tests — pure rendering change, layout maths unchanged).
**TypeScript:** clean.
**Build:** clean.

### Gotcha #41 — Per-row beams must not extend past their row's bounding box

The connector beams at `parentArmY` and `childArmY` MUST be bounded by `[parentMinX, parentMaxX]` and `[childMinX, childMaxX]` respectively. If a future change makes either beam extend past its row's actual people (e.g. to reach an offset child by drawing an L from each parent), adjacent clusters whose own children are offset toward each other will overlap their beams. The fix is the three-band layout in `FamilyTreeView.tsx`: any horizontal slope between parentMidX and childMidX must live at the **junctionY between the two rows**, never at parentArmY or childArmY.

### Family tree — staggered dogleg Y values + single trunk for spouse-couples (v1.0.53)

**Problems reported on v1.0.52:**
1. **Adjacent clusters' doglegs fuse at the same Y.** When a couple bridges two grandparent families (e.g. Stephen+Maria, where Stephen's parents are Diane+Ralph and Maria's are Bill+Patricia), the layout forces them to sit between the two grandparent kids-groups. Their children (Matt, Laura) are anchored under the root at x=0, so the dogleg between Stephen+Maria's couple midpoint and the children's midpoint has to traverse a huge horizontal distance — and it does so at the same junctionY as the neighbouring cluster Hellen+Neil's dogleg. The two doglegs visually fused.
2. **"Extra bar" below married-couple parents.** Patricia and Bill (a married couple) each had their own vertical leg dropping from their card to parentArmY, plus the parents' beam between them, plus the trunk from parentMidX. Three close-together vertical lines below the couple looked like multiple parallel bars instead of one clean trunk.

**Fix in `src/components/FamilyTreeView.tsx`:**

1. **Per-cluster staggered `junctionY`.** Clusters are sorted left-to-right by children's midpoint x and indexed 0, 1, 2, ... within each generation. Each cluster's `junctionY` lands at one of 5 fractional bands (1/6, 2/6, 3/6, 4/6, 5/6) between `parentArmY` and `childArmY`. This guarantees that adjacent clusters' horizontal dogleg segments live at different Y values, never on a shared line. The vertical trunks above/below each dogleg are short or long accordingly.
2. **Single trunk for spouse-couple parents.** If a cluster's two parents are a married couple sitting adjacent (detected via `isSpousePair` against the `spouses` list), the cluster skips the per-parent vertical legs and the `parentArmY` beam entirely — the spouse line at the card's mid-Y already shows the pairing. Instead, a single trunk drops from the couple's midpoint at the card's bottom edge straight down to `junctionY`. Cleaner visual, no triplet of close vertical lines.

**Layout fundamentals unchanged** (no test changes). The structural issue that Stephen+Maria's couple sits 800px to the left of their children Matt+Laura is a real layout constraint — the couple is wedged between Diane+Ralph's other kids and Bill+Patricia's other kids and can't slide past either by Pass 2's neighbour-constraint. The dogleg correctly bridges that distance. With the staggered junctionY, the dogleg's horizontal segment sits at a unique Y and no longer fuses with adjacent clusters' doglegs.

**Tests:** 637/637 passing. (No new tests — pure rendering change.)
**TypeScript:** clean.
**Build:** clean.

### Gotcha #42 — Adjacent clusters need staggered junctionY

When two adjacent unrelated clusters both need long doglegs in opposite directions (e.g. one couple's children are far right of the couple, neighbouring couple's children are far left), their horizontal dogleg segments will visually fuse if they share a Y line. The fix is per-cluster staggered `junctionY` using `((cIdx % STAGGER_BANDS) + 1) / (STAGGER_BANDS + 1)` of the available vertical space. Currently `STAGGER_BANDS = 5`.

### Future work — cross-family couples drift far from their children

The remaining structural issue: a couple where each spouse is from a different family (like Stephen+Maria, whose Matt is the tree root) gets positioned at the **average of all four grandparents' x positions**, which can sit far from where their own children actually land. Pass 2 cannot slide the couple over because they're constrained by their siblings' groups on either side.

Solutions to consider for a future pass:
- Allow Pass 2 to push entire neighbour chains rightward when an upper-generation cluster needs to slide.
- Treat root-ancestor clusters as having higher priority during overlap resolution — they can displace non-ancestor neighbours.
- Special-case cross-family couples: use the couple's children-midpoint as their primary target, not the grandparents-midpoint.

The current staggered-junctionY rendering masks the issue visually but doesn't fix the geometry.

### Tree view UX overhaul — inline editing, no pubkeys (v1.0.54)

**Changes made:**

**1. "Edit information" now opens inline — no tab switch.**
Previously clicking "Edit information" in the tree's action panel navigated to the People tab. Now it opens a `PersonProfileModal` directly over the tree, showing the full edit form. After saving, the modal closes and the tree redraws in place.

**2. "View full profile" now opens a profile card modal — no tree root change.**
Previously clicking "View full profile" changed the tree root to that person, breaking the layout. Now it opens `PersonProfileModal` in view mode, showing the full `ProfileCard` with all fact fields, relationships, and conflict history. The tree stays put.

**3. "View tree from [name]'s perspective" replaces "Make this person the tree root" — contacts only.**
The "make root" button is now only shown for connected contacts (people whose pubkey appears in the user's contact list). For ancestors and other local entries it's hidden — the People list is the right place to change perspective. The label is changed to "View tree from [name]'s perspective" to make the intent clear.

**4. Pubkeys removed from all visible UI.**
- Node display-name fallback: was `pubkey.slice(0, 12) + '…'`, now `'Unknown'`
- Claims panel claimant: was raw pubkey truncated, now resolves to person's display name or `'Family member'`
- Relationships section fallback: was truncated pubkey, now `'Unknown'`

**5. Name editing in edit mode.**
The name field is now shown in edit mode. For ancestors and local entries it's freely editable and saves to the `Person` record in the store. For connected contacts the field is disabled with a "Set by them" label — the contact's chosen name is authoritative.

**New file:** `src/components/PersonProfileModal.tsx` — modal wrapper around `ProfileCard` and `AddPersonModal`. Handles view/edit mode toggle, save callbacks, and delete. Used from `FamilyTreeView`'s `ActionPanel`.

**Files changed:** `FamilyTreeView.tsx`, `ProfileCard.tsx`, `AddPersonModal.tsx`, `App.tsx`

**Tests:** 637/637 passing. TypeScript clean. Build clean.

### Multi-instance support — run two Chronicle instances side-by-side (v1.0.56)

**Purpose:** Test the full connection and sync flow on a single machine before involving real family members. Both instances use the same WebSocket relay mechanism as remote connections, so behaviour is identical.

**How it works:**

Each instance launched with `--instance=N` gets:
- Its own `userData` directory (`Chronicle` for instance 1, `Chronicle-2` for instance 2, etc.) — separate identity, key material, and SQLite database
- Its own relay port (4869 for instance 1, 4870 for instance 2, 4871 for instance 3, ...)
- Its own single-instance lock key — both windows coexist simultaneously
- Its own session partition — separate browser storage
- Window title shows `Chronicle (Instance 2)` for secondary instances so you can tell them apart

**Launch commands (after installing the built app):**

Windows (from the install directory or via a shortcut):
```
"Chronicle.exe" --instance=2
```

macOS:
```
open -n /Applications/Chronicle.app --args --instance=2
```

Linux:
```
./Chronicle --instance=2
```

**To test a connection:**
1. Launch instance 1 normally (double-click). Create an identity (Alice).
2. Launch instance 2 with `--instance=2`. Create a second identity (Bob).
3. In Alice's instance, go to Connect → generate an invite code.
4. In Bob's instance, go to Connect → paste the invite code.
5. Alice's relay is at `ws://127.0.0.1:4869`, Bob's at `ws://127.0.0.1:4870` — both accessible over localhost.

**Files changed:**
- `electron/main.cjs`: parses `--instance=N`, sets userData path, relay port, lock key, window title, and session partition per instance
- `electron/preload.cjs`: exposes `instanceNum` and `relayPort` to the renderer via context bridge
- `src/context/AppContext.tsx`: `LOCAL_RELAY_URL` now reads `relayPort` from the preload (falls back to 4869 in browser dev mode); allowlist HTTP call also uses the dynamic port

**Tests:** 637/637 passing. TypeScript clean. Build clean.

### Deduplication overhaul — auto-detect + deterministic merge (v1.0.80)

**Problem reported:** When instance 1 has "Matt O'Brien, b.1980" and instance 2 syncs in "Matt O'Brien" (no DoB), the two entries were never surfaced as duplicates. The existing `PossibleMatchesPanel` used a mine/theirs split (local vs remote claimant) that broke once both records landed in the same local store — which always happens in the two-instance scenario.

**Root causes:**
1. `PossibleMatchesPanel` split persons into "mine" vs "theirs" by claimant pubkey, then only compared across the boundary. After sync, both records exist locally and may share the same claimant (session) pubkey — the split produced zero candidates.
2. `TreeView` hid duplicates by checking `aIsLocal`/`bIsLocal` — also claimant-based, also broken in the same scenario.
3. No auto-detection: duplicates were only surfaced if the user navigated to the Connect tab after sync was complete.

**Fix — three-layer change:**

**1. `src/lib/relaySync.ts`**
- Added `setPendingMatchHandler(fn)` export and `AUTO_DEDUP_THRESHOLD = 0.35` constant.
- Added `maybeDetectDuplicate(subjectPubkey)` — called after every `ingestFactClaim` when the `name` or `born` field arrives. Scans all existing persons, computes `scoreMatch`, and fires the registered callback if any unlinked pair meets the threshold.
- This means duplicates are surfaced immediately on ingest, not only after a manual UI action.
- Added `getAllSamePersonLinks` and `scoreMatch`/`alreadyLinked` imports.

**2. `src/components/PossibleMatchesPanel.tsx`** — rewritten
- New prop: `pendingMatchVersion: number` (bumped by App.tsx whenever relaySync fires the handler).
- `computeCandidates()` now compares **all persons against all persons** (same pubkey array passed as both setA and setB to `findMatchCandidates`). The mine/theirs split is removed.
- Removed the `contacts.length > 0` guard in `App.tsx` — panel now shows even before any contacts are added (covers same-session local deduplication).
- "Yes, same person" button label changed to "Merging…" to reflect that confirming immediately collapses both entries.

**3. `src/components/TreeView.tsx`**
- Replaced the `aIsLocal`/`bIsLocal` claimant-based hiding logic with `resolveCanonicalPubkey` (already in `graph.ts`). Any person whose pubkey != `resolveCanonicalPubkey(pubkey)` is non-canonical and hidden.
- This is deterministic regardless of which instance created which record — canonical is always the lexicographically smaller pubkey.

**4. `src/App.tsx`**
- Registers `setPendingMatchHandler` in a `useEffect` in `ConnectTab`, bumping `pendingMatchVersion` state.
- Passes `pendingMatchVersion` to `PossibleMatchesPanel`.

**5. `src/lib/autoDedup.test.ts`** — 18 new tests
- `scoreMatch`: name-only (0.35), similar-name (0.15), zero for different names.
- `scoreMatch`: name+DoB (0.60), DoB outside tolerance stays at 0.35.
- **The bug scenario**: instance 1 has name+DoB, instance 2 has name only → still ≥ 0.35 → surfaced.
- `findMatchCandidates`: same-set comparison finds candidates; excludes linked pairs; no self-match; higher-confidence ranked first.
- `resolveCanonicalPubkey`: no-link case; lexicographic canonical; people-list dedup with correct hidden set; chained links without infinite loop.
- `alreadyLinked`: forward, reverse, retracted, no-match.

**Tests: 655/655. TypeScript clean. Build clean.**

### Gotcha #47 — PossibleMatchesPanel must compare ALL persons, not mine-vs-theirs

The mine/theirs split by claimant pubkey only works when there is a clean boundary between local and remote data — which breaks the moment sync completes and both records land in the same store. Always pass the same full pubkey list as both setA and setB to `findMatchCandidates`, then filter out self-matches (already done inside the function) and already-linked pairs.

### Gotcha #48 — TreeView dedup must use resolveCanonicalPubkey, not claimant heuristics

Hiding non-canonical duplicates by checking which claimant is "local" is fragile. `resolveCanonicalPubkey` follows the link chain and returns a stable, deterministic result (lexicographically smallest pubkey in the link cluster). Any person whose pubkey differs from their canonical form is a secondary entry and should be hidden.

### Retroactive dedup + manual linking + relationship repair (v1.0.81)

**Three issues addressed:**

**Issue 1 — Dedup not retroactive**
The v1.0.80 auto-detect only fired on new `ingestFactClaim` events. If both records already existed in the store from a previous session (restored from `chronicle:store`), nothing triggered a scan. Fixed by:
- `PossibleMatchesPanel`: shows a "🔍 Scan for duplicate people" button when the candidate list is empty, allowing on-demand rescanning at any time.
- `AppContext`: `triggerDupesScan()` exported (bumps `syncVersion`) for programmatic triggering.
- The panel always runs `computeCandidates(dismissed)` on mount via the `useEffect` dependency on `syncVersion` and `pendingMatchVersion`.

**Issue 2 — No manual "same person" linking**
Added a "This is the same person as someone else in the list…" button to the selected-person panel in `TreeView`. Clicking it opens an inline picker showing all other canonical persons (non-hidden). Selecting one immediately publishes a kind-30083 same-person link event, adds it to the local graph, hides the duplicate, and clears the selection. Works regardless of whether a contact is connected.

**Issue 3 — Family tree not showing remote relationships**
Root cause confirmed: relationship events stored before v1.0.79 lack the `related` tag. `ingestRelationshipClaim` requires that tag and silently drops events without it — correct behaviour for new events, but it means all pre-fix stored events are dead on arrival at the remote instance.

Fix: `repairRelationships()` added to `AppContext`. It iterates `getAllRelationships()` from the local graph (which has `relatedPubkey` intact regardless of the raw event), builds fresh signed kind-30079 events with the correct `related` tag for every relationship this session owns, stores them as raw events, and pushes them to all connected relays. A "↺ Repair missing tree connections" button in the Connect tab (visible when contacts are connected) calls this. The remote instance will ingest the repaired events and add them to its graph, causing the tree to render correctly on next sync.

**Files changed:**
- `src/context/AppContext.tsx`: added `repairRelationships`, `triggerDupesScan` to interface + implementation; added `getAllRelationships` and `buildRelationshipClaim` imports.
- `src/components/TreeView.tsx`: added `linkPickerFor` state, `buildSamePersonLink` + `addSamePersonLink` imports, manual same-person picker UI under selected person's profile card; consolidated double `useApp()` call.
- `src/components/PossibleMatchesPanel.tsx`: shows "Scan for duplicates" button when candidate list is empty.
- `src/App.tsx`: added `repairRelationships` to ConnectTab destructuring; added "Repair missing tree connections" button below PossibleMatchesPanel.

**Tests: 655/655. TypeScript clean. Build clean.**

### Root cause fixes — relationship ingestion stubs + tree root isolation (v1.0.82)

**Root cause 1 — `ingestRelationshipClaim` never created person stubs**
`ingestFactClaim` created a stub for the subject if one didn't exist, and `ingestIdentityAnchor` created a stub for the event pubkey. But `ingestRelationshipClaim` called `addRelationship(rel)` without ensuring either `subject` or `related` existed as a person in the store. `traverseGraph` found the edge but `store.getPerson(pubkey)` returned null for both ends — the nodes didn't render.

Fix: `ingestRelationshipClaim` now calls `ensurePersonStub()` for both `subject` and `related` before adding the relationship. Also added warn-level logging when expected tags are missing.

**Root cause 2 — graphRoot was always session.npub on instance 2**
`graphRoot` was set to `session.npub` on first graph tab click. Instance 2's session npub has no relationship edges — all relationships in the synced data are between instance 1's ancestor pubkeys. So `traverseGraph(instance2Npub)` always returned 0 nodes.

Fixes:
- Graph tab click: if `session.npub` has no relationships in the graph, walks `getAllRelationships()` and uses the first connected person as root instead.
- New `useEffect` on `syncVersion`: after every sync that delivers new relationships, if the current `graphRoot` has no edges, automatically switches to the first connected person. This means the tree updates reactively when "Repair missing tree connections" completes — no manual tab switch needed.

**Also fixed:** added `triggerDupesScan` / `repairRelationships` no-ops are already exported; `getAllRelationships` imported in `App.tsx`.

**Gotcha #49 — Relationship events don't create person stubs; fact claims do**
`ingestIdentityAnchor` and `ingestFactClaim` create person stubs. `ingestRelationshipClaim` previously did not. Since relationships can arrive before other events (especially during repair), the receiving instance must create stubs when ingesting them or the tree nodes simply won't appear.

**Gotcha #50 — graphRoot must not default to session.npub if that person has no relationships**
Instance 2's own npub is not in instance 1's relationship graph. Setting graphRoot = session.npub on a fresh instance that has only synced remote data will always produce an empty tree. Always check `getAllRelationships()` for the npub first; fall back to the first connected person if needed.

**Tests: 655/655. TypeScript clean. Build clean.**

### Remove authors filter from subscription — subscribe to all Chronicle kinds (v1.0.83)

**Root cause identified:** `startSync` and `fetchOnConnect` were building subscription filters with `authors: [hex1, hex2, ...]` collected once at connection time. This created two failure modes:

1. **Live updates not received:** If the filter was sent before a contact's ancestors were known locally, those ancestors' pubkeys were absent from the filter. Events published by them later (e.g. a new born year) were never delivered by the relay to the subscription — the relay only fans out events matching the active subscription filter.

2. **Repair events not received:** After "Repair missing tree connections", the repaired relationship events were published by instance 1 to instance 2's relay. Instance 2's relay accepted them (allowlist check passed). But instance 2's subscription filter had `authors` limited to known-at-connection-time pubkeys — if the ancestor pubkeys weren't in that list, the fan-out was silently dropped.

**Fix (`src/lib/relaySync.ts`):**
- `startSync`: replaced `{ kinds, authors, limit }` filter with `{ kinds, limit }` — no authors restriction.
- `fetchOnConnect`: same change; removed the early-return guard that skipped subscription when `knownPubkeys.length === 0`.
- Removed `collectKnownPubkeys`, `getContactPubkeys`/`setContactPubkeysProvider` (now dead), and the inline `npubToHex` helper (all unused).
- `setContactPubkeysProvider` kept as a no-op export for API compatibility (called from AppContext).

**Why this is safe:** The embedded relay is allowlist-gated — only pubkeys explicitly added via `allowlistAdd` can write events. Subscribing to all Chronicle kinds without an authors filter simply means "give me everything this relay has accepted from trusted sources", which is exactly what we want. There is no exposure of untrusted data.

**Also in this version (carried from v1.0.82):**
- `ingestRelationshipClaim` creates person stubs for both `subject` and `related` if they don't exist.
- `graphRoot` falls back to the first connected person when the session npub has no relationships.
- `useEffect` on `syncVersion` updates `graphRoot` reactively after sync.

**Tests updated:** `relaySync.test.ts` — 3 tests updated to reflect no-authors-filter behaviour.

**Tests: 655/655. TypeScript clean. Build clean.**

### Gotcha #51 — Never filter relay subscriptions by authors

The relay subscription filter must not include an `authors` list. The filter is static (sent once at REQ time); any pubkey not in the list at that moment is permanently invisible for that subscription session. Since the relay is allowlist-gated, all stored events are already trusted — subscribe to kinds only and let the allowlist do the access control.

### Fix person display names showing as npub stub (v1.0.84)

**Root cause:** When instance 2 received a relationship event (kind 30079) before it had a person stub for the subject/related pubkeys, `ingestRelationshipClaim` created stubs with `displayName: 'Unknown'` (v1.0.82 fix). The name fact claim for those persons was already in the raw event store from an earlier sync — the deduplication check (`store.getRawEvent(event.id)`) found it and returned early, so `ingestFactClaim` never ran a second time to update the display name.

Result: persons whose relationship events arrived before their name claims (or whose name claims were already stored and deduplicated) permanently showed their pubkey stub as their display name.

**Fix — `replayStoredFactClaims()` in `src/lib/relaySync.ts`:**
Scans all raw events in the store, finds any `kind=30081` (FACT_CLAIM) with `field=name`, and updates the person's `displayName` if it's still `'Unknown'` or ends with `'…'` (a pubkey stub). This is a one-time repair that's safe to run multiple times.

Called from `AppContext` at four points:
1. After session restore (loads stored raw events then immediately backfills display names).
2. After `fetchOnConnect` completes on the main relay (initial sync done).
3. After `fetchOnConnect` on `connectToRelay` (contact relay sync complete).
4. After `fetchOnConnect` on `addContact` (new contact's events fetched).

**Also fixed:** All stub `displayName` values changed from `pubkey.slice(0, 8) + '…'` to `'Unknown'` throughout `ingestIdentityAnchor` and `ingestFactClaim`. The `'…'` suffix is now the detection signal for the replay to update — combined with `'Unknown'` check covers all historical stub formats.

**Tests: 655/655. TypeScript clean. Build clean.**

### Gotcha #52 — Raw event deduplication prevents re-ingestion; use replay for backfill

`ingestEvent` returns early if `store.getRawEvent(event.id)` already has the event. This means if a fact claim arrived and was stored before the person stub existed, re-sending the same event won't update the display name. Always use `replayStoredFactClaims()` after session restore and after sync completes to guarantee display names are correct from stored events.

### Fix "Unknown" name + always-on dedup detection (v1.0.85)

**Issue 1 — "Unknown" instead of real name**
`replayStoredFactClaims` only updated persons whose `displayName === 'Unknown'` or ended with `'…'`. Persons who already had a real name set (e.g. created locally in instance 2) were skipped, so the incoming name claim from instance 1 never applied. Also, if someone's displayName was correctly set but then a stub was created by `ingestRelationshipClaim` with `'Unknown'`, the person might already have a real name from a different path.

Fix: `replayStoredFactClaims` now always applies the best (most recent by `created_at`) name claim to every person, regardless of their current display name. Uses `bestNameBySubject` map to find the highest-createdAt name claim per pubkey, then upserts if `person.displayName !== value`.

Also wired to run on every `scheduleSyncUpdate` batch (inside `setSyncUpdateHandler`), not just after `fetchOnConnect`. So every wave of incoming events triggers a name backfill.

**Issue 2 — Dedup handler only registered when Connect tab is open**
`setPendingMatchHandler` was registered inside `ConnectTab`'s `useEffect`. Since `ConnectTab` only mounts when the Connect tab is active, incoming duplicates arriving while on the People or Family Tree tab never triggered the handler — `onPendingMatchFound` was null and `maybeDetectDuplicate` silently returned.

Fix: `pendingMatchVersion` state and the `setPendingMatchHandler` registration moved up to the main `AppShell` component, which is always mounted. `ConnectTab` receives `pendingMatchVersion` as a prop. The handler now fires regardless of which tab is open.

**Tests: 655/655. TypeScript clean. Build clean.**

### Gotcha #53 — setPendingMatchHandler must be registered at app shell level

If `setPendingMatchHandler` is registered inside a tab component, it's only active when that tab is mounted. Dedup detection during sync on any other tab will silently drop. Register it in the always-mounted app shell and pass `pendingMatchVersion` down as a prop.

### Relay restart data loss — re-sync button + persistent dismissed matches (v1.0.86)

**Root cause of persistent "Unknown" names and missing data:**
The embedded relay uses an in-memory event store (Gotcha #44). When the app restarts, the relay loses all events. Instance 1 only pushes its events to connected relays when it first connects. If instance 2's relay restarts while instance 1 is already connected, the push doesn't repeat — instance 2's relay is empty, its subscription delivers nothing, and all persons appear as stubs.

This is why: born year showed (new event, published after relay restart) but name showed "Unknown" (old event, lost in relay restart before the subscription fix).

**Fix — `repushAllEvents()` in AppContext:**
Re-sends every raw event in the local store to all currently connected relays. Exposed via "↺ Re-sync all my data to connected instances" button in Connect tab (visible when contacts exist). Instance 1 clicks this — all its events flood instance 2's relay — instance 2 ingests them — names resolve, tree builds.

**Fix — `dismissedMatches` persistence via Electron IPC:**
`PossibleMatchesPanel` was using `localStorage` for dismissed pairs. In Electron, localStorage is unreliable (may clear on restart). Switched to `storageGet`/`storageSet` (Electron IPC-backed, writes to userData JSON files). Dismissed pairs now survive app restarts. `loadDismissed` is now async; `useState` initialises to empty set with a `useEffect` that loads from storage.

**Fix — repeated duplicate suggestion:**
Same-person links confirmed in the UI were being added to the in-memory graph but not persisted across restarts (graph is `MemoryGraphStore`). On next session, `getAllSamePersonLinks()` returns empty, so the pair re-appears. The dismissed-match persistence fix prevents re-suggestion for dismissed pairs. For confirmed links, the kind-30083 event is published to the relay — on next session it will be re-ingested and the link re-added to the graph automatically.

**Files changed:**
- `src/context/AppContext.tsx`: `repushAllEvents` implementation + interface + context value
- `src/components/PossibleMatchesPanel.tsx`: `storageGet`/`storageSet` for dismissed pairs; async load in `useEffect`
- `src/App.tsx`: "Re-sync all my data" button in Connect tab; `repushAllEvents` destructured

**Tests: 655/655. TypeScript clean. Build clean.**

**Instructions for testing:**
1. Both instances running, connected.
2. If instance 2 shows "Unknown" names — go to Connect tab in **instance 1**, click "↺ Re-sync all my data to connected instances".
3. Instance 2 should update within a few seconds.
4. If tree still empty in instance 2 — also click "↺ Repair missing tree connections" in instance 1.

---

## ⚠️ NEXT SESSION — STRUCTURAL REBUILD BRIEF

**Read this entire section before writing any code.**

---

### Decision: Remove per-person npubs — use UUID string IDs for ancestors

This decision was made at the end of the May 2026 session after approximately 12 versions of sync fixes that did not resolve the core problems. The root cause of all sync failures traced back to the per-person npub model for ancestors. This section documents exactly what to change, what to keep, and the known bugs that motivated the decision.

---

### Known bugs in v1.0.86 (motivating the rebuild)

**Bug 1 — Person display name shows as "Unknown" in instance 2**
- Root cause: `replayStoredFactClaims` (added in v1.0.84) overwrites `displayName` for all persons from stored name claims. But if the name claim raw event is not in the store (because the relay lost it on restart — Gotcha #44), the person stays as "Unknown".
- Additionally, `replayStoredFactClaims` now incorrectly overwrites the logged-in user's own display name if their name claim event isn't in the raw event store.
- This was not a problem before v1.0.84. The function should only update persons whose displayName is currently "Unknown" — not overwrite everyone unconditionally.

**Bug 2 — Family tree does not build in instance 2**
- Root cause: The embedded relay uses an in-memory event store (Gotcha #44). It loses all events on restart. Instance 1 pushes events to instance 2's relay only on first connect. If instance 2's relay restarts while connected, events are lost and never re-sent automatically.
- The "Re-sync all my data" button (v1.0.86) is a manual workaround, not a fix.
- The permanent fix is SQLite persistence in the relay (Option B from May 2026 session notes).

**Bug 3 — Duplicate suggestions keep reappearing**
- Confirmed same-person links are added to the in-memory graph but not persisted across restarts (MemoryGraphStore). On next session, `getAllSamePersonLinks()` returns empty, pair re-appears.
- The kind-30083 event is published to the relay, so on reconnect it should be re-ingested. But if the relay has lost it (Bug 2), the link is gone.

**Bug 4 — Dedup matching broken by npub format**
- `computeCandidates` in `PossibleMatchesPanel` uses `store.getAllPersons()` which returns persons keyed by their pubkey. In the two-instance scenario, the same real person exists under two different pubkeys. `scoreMatch` compares claim arrays by pubkey — if the pubkeys differ (they always do for the same ancestor added independently), the name claims are under different keys and matching is unreliable.

---

### What the rebuild changes

**Core principle: ancestors use UUID string IDs, not Nostr keypairs.**

Your session key (BIP39 mnemonic → npub/nsec) is unchanged. You still log in with a real Nostr keypair. All events are still signed by your session key. The cryptographic integrity of the claim model is fully preserved.

What changes is that ancestors are no longer assigned their own keypair. Instead each ancestor gets a `id: string` (UUID v4, e.g. `"550e8400-e29b-41d4-a716-446655440000"`). This ID is stable, portable, and collision-resistant without any cryptography.

**Type changes (`src/types/chronicle.ts`):**

```typescript
// OLD
interface Person {
  pubkey: string      // npub bech32
  displayName: string
  isLiving: boolean
  createdAt: number
}

// NEW
interface Person {
  id: string          // UUID v4 for ancestors; session npub for the logged-in user
  displayName: string
  isLiving: boolean
  createdAt: number
}
```

The logged-in user's own `Person` record uses their npub as the ID — this preserves Nostr identity for the living user. Only ancestor records change to UUID.

**Event tag changes:**
- `['subject', personId]` — was npub, now UUID for ancestors
- `['related', personId]` — same
- `event.pubkey` — still hex of the claimant's session key (unchanged)
- `['claimed_by', sessionNpub]` — identity anchor still records who added the ancestor

**Store changes (`src/lib/storage.ts`):**
- `MemoryStore` keys persons by `id` instead of `pubkey`
- `store.getPerson(id)` — same API, different key type
- `store.upsertPerson(person)` — same
- `store.searchPersons(query)` — same

**Graph changes (`src/lib/graph.ts`):**
- `RelationshipClaim.subjectPubkey` → `subjectId`
- `RelationshipClaim.relatedPubkey` → `relatedId`
- `traverseGraph(rootId, ...)` — same API
- `resolveCanonicalId` replaces `resolveCanonicalPubkey` — but since IDs are now stable UUIDs, same-person merging becomes a direct re-ID operation rather than a link chain

**eventBuilder changes (`src/lib/eventBuilder.ts`):**
- `buildFactClaim({ subjectId, ... })` instead of `subjectNpub`
- `buildRelationshipClaim({ subjectId, relatedId, ... })` instead of npub params
- `buildIdentityAnchor(personId, claimantNpub, claimantNsec)` — personId is UUID for ancestors
- No `npubToHex`/`hexToNpub` calls anywhere in the builder for ancestor IDs

**relaySync ingesters:**
- `ingestIdentityAnchor`: `event.pubkey` is still the claimant's hex key. The person ID is now in a `['person_id', uuid]` tag on the event. No more using `event.pubkey` as the person identifier.
- `ingestFactClaim`: `getTag(event, 'subject')` returns a UUID now, not an npub. No format conversion needed.
- `ingestRelationshipClaim`: same — `subject` and `related` tags are UUIDs.
- `replayStoredFactClaims`: same logic, simpler — no pubkey format concerns.

**AddPersonModal changes:**
- When creating an ancestor: `const personId = crypto.randomUUID()` instead of `generateAncestorKeyPair()`
- No `nsec` storage for ancestors — they have no private key
- The `AncestorKeyPair` type and all related code is deleted

**Deduplication changes:**
- Two persons are candidates if `scoreMatch` returns confidence ≥ 0.35
- Confirming a merge: the lower-created-at person's ID is re-mapped to the higher-created-at person's ID in the store. All claims referencing the old ID are updated. No kind-30083 event needed — the merge is a local store operation, and the canonical ID is shared as a fact claim tag so other instances learn it.
- `PossibleMatchesPanel` simplifies significantly — no `resolveCanonicalPubkey` chain, no link events, just a direct store merge.

**What is deleted entirely:**
- `generateAncestorKeyPair()` in `keys.ts`
- `AncestorKeyPair` type
- `ancestorKeys` map in `MemoryStore`
- `hexToNpub`/`npubToHex` calls in relaySync, graph, AddPersonModal (kept in `keys.ts` for the session key only)
- `kind 30083` (same-person link events) — replaced by direct merge
- `resolveCanonicalPubkey` in graph.ts — replaced by direct ID lookup
- `buildSamePersonLink` in eventBuilder.ts
- `addSamePersonLink`/`getAllSamePersonLinks` in graph.ts
- The `autoDedup.test.ts` same-person-link tests (replaced by merge tests)

**What is NOT deleted:**
- Session keypair (BIP39 mnemonic, npub, nsec) — unchanged
- All relay infrastructure
- All event signing via session key
- All UI components (minor prop name changes only)
- The relay subscription (already kind-only, no authors filter)
- The confidence scoring and conflict resolution model
- i18n, Bootstrap, D3 tree layout

---

### Permanent relay fix (do this in the same session)

Wire SQLite into the relay so events survive restarts. This is Option B from the May 2026 session notes:

The relay (`relay/server.js`) already has SQLite support — it falls back to in-memory only when `better-sqlite3` isn't available. In the packaged Electron build, the relay runs outside the asar archive and can't access `node_modules`. 

Fix: copy `better-sqlite3` native binary into `relay/node_modules/` as part of the electron-builder config, OR switch to the simpler approach: **remove the embedded relay's own SQLite and instead have it forward all events to the app's `SqliteStore` via Electron IPC**.

Simplest working fix for the session: in `relay/server.js`, make the in-memory fallback persist to a JSON file in `userData` on every write. This is not as efficient as SQLite but is portable, requires no native compilation, and means events survive relay restarts. Use `fs.writeFileSync` after each `insertEvent`. Load on startup.

```javascript
// relay/server.js — file-backed in-memory store
const EVENTS_FILE = path.join(process.env.DB_PATH || '.', 'relay-events.json')

function loadEvents() {
  try {
    const raw = fs.readFileSync(EVENTS_FILE, 'utf8')
    const arr = JSON.parse(raw)
    for (const e of arr) inMemoryEvents.set(e.id, e)
    console.log(`[relay] loaded ${arr.length} events from ${EVENTS_FILE}`)
  } catch { /* first run */ }
}

function persistEvents() {
  try {
    fs.writeFileSync(EVENTS_FILE, JSON.stringify([...inMemoryEvents.values()]))
  } catch (e) {
    console.error('[relay] failed to persist events:', e.message)
  }
}
```

Call `loadEvents()` at startup. Call `persistEvents()` after every `insertEvent`. This makes the relay's event store durable with no native dependencies.

---

### Session start checklist for next Claude

1. Extract tarball to `/tmp/chronicle-work/chronicle-export/`
2. Read Design Plan and this Implementation Log fully
3. Restore better-sqlite3 mock: `cp src/__mocks__/better-sqlite3.js node_modules/better-sqlite3/index.js`
4. Run baseline: `npx vitest run` — expect 655/655
5. Implement the rebuild in this order:
   a. `src/types/chronicle.ts` — Person.id, remove AncestorKeyPair
   b. `src/lib/storage.ts` — key by id not pubkey, remove ancestorKeys
   c. `src/lib/graph.ts` — subjectId/relatedId, remove same-person link machinery
   d. `src/lib/eventBuilder.ts` — UUID subject tags, remove buildSamePersonLink
   e. `src/lib/relaySync.ts` — update ingesters, fix replayStoredFactClaims
   f. `src/lib/keys.ts` — remove generateAncestorKeyPair
   g. `src/components/AddPersonModal.tsx` — crypto.randomUUID() for ancestors
   h. `relay/server.js` — file-backed event persistence
   i. Update all tests
   j. TypeScript check, build check, full test run
6. Deliver tarball + updated log

---

### Current version at end of May 2026 session: v1.0.86
### Tests at handoff: 655/655
### TypeScript: clean
### Build: clean


---

## v1.0.87 — UUID Person IDs + File-Backed Relay Persistence

### Core rebuild: ancestors now use UUID v4 IDs instead of Nostr keypairs

**Motivation:** The per-person npub model for ancestors caused all sync failures documented in v1.0.83–v1.0.86. Two instances independently creating the same ancestor each assigned different npubs; claims, relationships, and display names could never be reliably reconciled across instances.

**What changed:**

**`Person.pubkey` → `Person.id`**
- `id: string` — UUID v4 for ancestors (e.g. `"550e8400-e29b-41d4-a716-446655440000"`); session npub for the logged-in user
- Generated via `crypto.randomUUID()` in `AddPersonModal.tsx` and `gedcomImport.ts`
- `generateAncestorKeyPair()` and `AncestorKeyPair` deleted from `keys.ts`
- `StoredAncestorKey` deleted from `storage.ts`

**`MemoryStore` changes:**
- Persons keyed by `id` not `pubkey`
- `ancestorKeys` map removed
- New alias table: `Map<localId, PersonAlias[]>` — records remote IDs from other instances for the same person
- `addPersonAlias(alias)` / `getAliasesFor(id)` / `resolvePersonId(anyId)` / `getAllAliases()`
- `serialise()`/`deserialise()` updated to include aliases

**`FactClaim` changes:**
- `subjectPubkey` → `subjectId`

**`RelationshipClaim` changes:**
- `subjectPubkey` → `subjectId`, `relatedPubkey` → `relatedId`

**`GraphEdge` changes:**
- `fromPubkey` → `fromId`, `toPubkey` → `toId`

**`SamePersonLink` changes:**
- `pubkeyA` → `idA`, `pubkeyB` → `idB`
- Added optional `remoteIdA`, `remoteIdB`, `creatorNpubA`, `creatorNpubB` fields
- Now carries alias registration info so receiving instances can map remote IDs to local ones

**`eventBuilder.ts` changes:**
- `buildIdentityAnchor(personId, claimedByNpub, claimedByNsec)` — adds `['person_id', personId]` tag; signed by claimant, not ancestor
- `buildFactClaim` param: `subjectNpub` → `subjectId`
- `buildRelationshipClaim` params: `subjectNpub` → `subjectId`, `relatedNpub` → `relatedId`
- `buildSamePersonLink` updated to use person IDs and optional remote ID fields

**`relaySync.ts` changes:**
- `ingestIdentityAnchor` reads `person_id` tag (skips legacy events without it)
- `ingestFactClaim` resolves `subject` tag via `store.resolvePersonId()` before storing
- `ingestRelationshipClaim` same resolution for `subject` and `related` tags
- `ingestSamePersonLink` registers aliases in store via `store.addPersonAlias()`
- `replayStoredFactClaims` reverted to only update persons with displayName `'Unknown'` (fixes the v1.0.85 regression that overwrote session user's own name)
- `maybeDetectDuplicate` now uses `areAliases()` instead of `alreadyLinked()`

**`graph.ts` changes:**
- `resolveCanonicalPubkey` replaced by `resolveAliasIds(id): Set<string>` — returns all known IDs for the alias group, no winner
- New `areAliases(idA, idB): boolean` — true if both IDs are in the same alias group
- Traversal updated to use `subjectId`/`relatedId`

**`treeLinking.ts` changes:**
- `MatchCandidate`: `pubkeyA/B` → `idA/idB`
- `scoreMatch`, `findMatchCandidates`, `alreadyLinked`, `linkConnectsTrees`, `bestClaimValue` all updated

**`sqliteStore.ts` changes:**
- `persons` table: `pubkey` column → `person_id`
- `claims` table: `subject_pubkey` → `subject_id`
- `relationships` table: `subject_pubkey`/`related_pubkey` → `subject_id`/`related_id`
- `same_person_links` table: `pubkey_a`/`pubkey_b` → `id_a`/`id_b`
- `setAncestorKey`/`getAncestorKey` now no-op stubs (deprecated)

**`better-sqlite3` mock** updated to match new schema column names.

**`FamilyTreeView.tsx`:**
- `NodeData.pubkey` → `NodeData.id` (internal field rename)
- D3 rendering updated to use `d.id`

**`TreeView.tsx`:**
- Dedup hiding uses `areAliases()` instead of `resolveCanonicalPubkey()`

**`relay/server.js`:**
- In-memory fallback now file-backed: writes all events to `relay-events.json` in `userData` on every insert; loads on startup
- Events survive relay restarts even without native `better-sqlite3`

### Alias model

When two instances connect and confirm the same ancestor:
- Instance 1 has ancestor "Ralph" as `uuid-A` (created by Alice's npub)
- Instance 2 has ancestor "Ralph" as `uuid-B` (created by Bob's npub)
- After confirming same-person link: both instances record the other's UUID as an alias
- Claims tagged with `uuid-A` are resolved to the local record on instance 2 via `store.resolvePersonId()`
- `areAliases(uuid-A, uuid-B)` returns true on both instances
- No UUID is retired; both persist with their own IDs plus the alias table

### When a new identity anchor arrives

If instance 2 receives a `person_id: uuid-X` anchor from instance 1:
- If `uuid-X` is already known locally → no-op
- If `uuid-X` resolves via alias table to a local ID → register alias only
- Otherwise → create a new person stub with `id: uuid-X`

### Tests

- 657/657 passing
- 30/30 test files passing
- TypeScript: clean
- Build: clean

### Gotcha #54 — Identity anchor events require `person_id` tag

`ingestIdentityAnchor` skips any event without a `['person_id', uuid]` tag. Legacy events from pre-v1.0.87 builds cannot be ingested. Both instances must be on v1.0.87 or later for sync to work.

### Gotcha #55 — `resolveAliasIds` returns a `Set<string>`, not a string

Unlike the old `resolveCanonicalPubkey` which picked a winner, `resolveAliasIds` returns all known IDs in the alias group. Use `areAliases(idA, idB)` for boolean checks. Do NOT compare `resolveAliasIds(id) === someString` — it will always be false (Set vs string).

### Gotcha #56 — File-backed relay persistence requires `DB_PATH` env var

`relay/server.js` writes `relay-events.json` to `path.dirname(DB_PATH)`. In Electron, `DB_PATH` is set to `app.getPath('userData')/chronicle.db` by `electron/main.cjs`. In dev mode without Electron, it defaults to the relay directory. The file is read on startup and written after every insert.

### Version: v1.0.87
### Tests: 657/657
### TypeScript: clean
### Build: clean

---

## v1.0.88 — Migration layer for v1.0.86 → v1.0.87 upgrade

### Bug fixes (post-v1.0.87 deploy)

**Bug 1 — Duplicate person in People list after upgrade**
Root cause: `MemoryStore.deserialise()` loaded old persons without migrating `pubkey` → `id`. The singleton store already had some persons from `beginSession`, and after deserialise the same person could appear under two different keys (old npub key and newly created state).

Fix: `store.clearAll()` is now called at the start of the restore block in `AppContext.tsx` before any data is loaded from the persisted store. This prevents stale data from accumulating alongside freshly-migrated records.

**Bug 2 — Wrong death date appearing on a person**
Root cause: Old persisted `FactClaim` objects had `subjectPubkey` field; `getClaimsForPerson` filters on `subjectId`. Without migration, claims were stored in the map but never returned for their subject — and `replayStoredFactClaims` was applying name claims correctly (reading raw event tags), but old deserialized claim objects with the wrong field name could confuse resolution logic.

Fix: `MemoryStore.deserialise()` now migrates claim objects: if `subjectPubkey` exists and `subjectId` doesn't, copies the value across.

**Bug 3 — Tree view shows one "Unknown" box**
Root cause: Same migration gap — old `RelationshipClaim` objects had `subjectPubkey`/`relatedPubkey`; traversal uses `subjectId`/`relatedId`. Without migration, `traverseGraph` found zero edges, returning only the root node with no connections.

Fix: `deserialiseGraph()` now migrates `RelationshipClaim` objects (`subjectPubkey` → `subjectId`, `relatedPubkey` → `relatedId`) and `SamePersonLink` objects (`pubkeyA` → `idA`, `pubkeyB` → `idB`) before adding them to the graph store.

### New: `MemoryStore.clearAll()`

Added `clearAll()` method that wipes persons, claims, endorsements, rawEvents, aliases, and identity from the singleton store. Called before restore to guarantee a clean slate.

### Migration summary (applied on deserialise)

| Old field | New field | Object type |
|---|---|---|
| `person.pubkey` | `person.id` | `Person` |
| `claim.subjectPubkey` | `claim.subjectId` | `FactClaim` |
| `rel.subjectPubkey` | `rel.subjectId` | `RelationshipClaim` |
| `rel.relatedPubkey` | `rel.relatedId` | `RelationshipClaim` |
| `link.pubkeyA` | `link.idA` | `SamePersonLink` |
| `link.pubkeyB` | `link.idB` | `SamePersonLink` |

Migration is idempotent — safe to run on already-migrated data (new field takes precedence, old field is only copied if new field is absent).

### Tests: 657/657 | TypeScript: clean | Build: clean
### Version: v1.0.88

---

## v1.0.89 — Fix synced names not persisting across restart

### Root cause

`setSyncUpdateHandler` in `AppContext.tsx` called `replayStoredFactClaims()` and bumped `syncVersion` — but never called `persistStore()`. So when instance 2 synced Alice's name from instance 1:

1. Raw events arrived → stored in memory
2. `replayStoredFactClaims` applied Alice's name → person updated in memory to `displayName: 'Alice'`
3. App closed → `persistStore` was never called after sync → raw events and updated person records lost
4. App restarted → persons loaded from last persisted state (Alice still `'Unknown'`) → raw events empty → `replayStoredFactClaims` has no name claims to apply → Alice stays `'Unknown'`

### Fix

`persistStore()` now called inside `setSyncUpdateHandler` after every sync batch. Raw events and updated display names are written to disk after every wave of incoming events.

### Gotcha #57 — Sync data is lost on restart unless persisted after every batch

`persistStore()` must be called after sync updates, not just at session start. If `setSyncUpdateHandler` only bumps `syncVersion` without persisting, any data received during a sync session (raw events, updated names, relationships) is discarded when the app closes.

### Version: v1.0.89 | Tests: 657/657 | TypeScript: clean | Build: clean

---

## v1.0.90 — Publish session user's own name to relay; show contact npub in tree

### Bug fix — session user shows as "Unknown" on connected instances

**Root cause:** The session user's display name was stored only in the encrypted `StoredIdentity` object (the `chronicle` IPC file). It was never published as a Nostr fact claim event, so it was never in `store.getAllRawEvents()`. When instance 1 connected to instance 2's relay and pushed its events, Alice's name was not among them. Instance 2 created a stub `{ displayName: 'Unknown' }` and nothing ever updated it.

**Fix — `publishSelfEvents()` in `AppContext.tsx`:**
- New `useCallback` that checks whether the session user already has an identity anchor and name claim in the raw event store.
- If either is missing, it builds and stores the signed event.
- Calls `persistStore()` so the events survive restarts.
- Called from two places:
  1. `connectToRelay()` — runs before pushing own events to a newly connected relay, ensuring the name claim is always in the push set.
  2. `beginSession()` — runs 500ms after session start, so the events exist from the first session onwards.

**Effect:** When instance 1 connects to instance 2's relay, it now pushes a signed identity anchor and name claim for itself. Instance 2 ingests these, resolves the name from the raw event, and displays it correctly.

### Feature — contact npub shown in tree action panel

When clicking a connected family member node in the family tree, the action panel now displays their npub below the "Connected family member" badge. The npub is rendered in monospace, selectable on click, and truncation-free so it can be copied for verification.

### Version: v1.0.90 | Tests: 657/657 | TypeScript: clean | Build: clean

---

## v1.0.91 — Alias-aware traversal; deduplicated person picker; build node data via alias resolution

### Problems fixed

**1. Both Marias visible in relationship picker**
When two instances independently create the same ancestor (each with a different UUID), both records appear in AddPersonModal's person picker. The user can't tell which to pick, and picking the wrong one means the relationship gets stored against the UUID that has no connections in the other instance's graph.

Fix: `AddPersonModal` now deduplicates the person list using `areAliases()`. When two persons are confirmed aliases of each other (same-person link exists), only the one with more claims is shown in the picker. The underlying UUID used for storing the relationship is the best-data record.

**2. Laura didn't appear in tree after being added to the wrong Maria**
`traverseGraph` only queried `getRelationshipsFor(current)` — it didn't know that `uuid-A-Maria` and `uuid-B-Maria` are the same person. So Laura (linked to `uuid-B-Maria`) was never reached when traversing from Matt (whose parent is `uuid-A-Maria`).

Fix: `traverseGraph` now calls `resolveAliasIds(current)` for each visited node and queries relationships for ALL alias IDs of that node. Laura is found regardless of which Maria UUID her relationship was stored against. Edges are normalised to use the representative (first-visited) UUID so the tree renders correctly.

**3. Tree nodes showing wrong name for alias IDs**
`buildNodeData` called `store.getPerson(personId)` directly. If the visiting ID was a remote UUID (alias), `getPerson` returned undefined and the node showed "Unknown".

Fix: `buildNodeData` now calls `store.resolvePersonId(personId)` first and uses the resolved local ID for both person lookup and claim lookup.

### Version: v1.0.91 | Tests: 657/657 | TypeScript: clean | Build: clean

---

## v1.0.92 — Fix session user name never transmitted to connected instances

### Root cause (two bugs, same symptom)

**Bug 1 — `publishSelfEvents` stored events locally but never broadcast them.**
`store.addRawEvent(event)` stores an event in the raw event map but does NOT enqueue it to the broadcast queue or push it to any relay. `publishEvent(event)` does both. `publishSelfEvents` was using `store.addRawEvent` — so Matt's identity anchor and name claim were saved to disk but never transmitted to instance 2's relay.

**Bug 2 — stale closure in `connectToRelay`.**
`connectToRelay` is defined with `[]` deps (correct — it should never re-create). It called `publishSelfEvents()` directly, but `publishSelfEvents` was not yet defined when `connectToRelay` was created (React `useCallback` with `[]` captures the initial closure). The call was always to `undefined`.

### Fixes

1. `publishSelfEvents` now calls `publishEvent()` instead of `store.addRawEvent()`. This ensures the identity anchor and name claim are stored AND immediately broadcast to all connected relays.

2. `publishSelfEvents` is now declared **after** `publishEvent` so the dependency is valid.

3. A `publishSelfEventsRef` ref is kept in sync with the current `publishSelfEvents` callback. `connectToRelay` calls `publishSelfEventsRef.current?.()` instead of the function directly — this breaks the stale closure without adding `publishSelfEvents` to `connectToRelay`'s dep array (which would cause unnecessary reconnects).

### Gotcha #58 — Store-only methods don't transmit events

`store.addRawEvent(event)` persists an event locally. It does NOT broadcast. Always use `publishEvent(event)` when an event should be visible to connected instances. The distinction matters in any code that builds events outside of the normal `AddPersonModal` → `publishEvent` flow.

### Version: v1.0.92 | Tests: 657/657 | TypeScript: clean | Build: clean

---

## ⚠️ NEXT SESSION HANDOFF — READ THIS FIRST

### Last version pushed to GitHub: v1.0.92
### Last tarball delivered: chronicle-v1_0_92.tar.gz
### Tests: 657/657 | TypeScript: clean | Build: clean

The tarball delivered at the END of this session is named **chronicle-v1_0_92-handoff.tar.gz** — this is the definitive starting point for the next session. It contains all work through v1.0.92 including the fixes below.

---

### What was accomplished in this session (May 2026)

**Core rebuild: ancestor person IDs**
- `Person.pubkey` → `Person.id` (UUID v4 for ancestors, session npub for living user)
- `generateAncestorKeyPair()` deleted; ancestors created with `crypto.randomUUID()`
- All event tags, store keys, graph edges, SQL columns updated throughout
- Migration layer in `MemoryStore.deserialise()` and `deserialiseGraph()` handles old data

**Alias model**
- Each instance keeps its own UUID for an ancestor and records other known UUIDs as aliases
- `store.addPersonAlias()`, `store.resolvePersonId()`, `store.getAllAliases()`
- `areAliases(idA, idB)` in `graph.ts` — returns true if two IDs are in the same alias group
- `resolveAliasIds(id)` returns a `Set<string>` of all known IDs for a person (not a winner)
- `traverseGraph` now queries relationships for ALL alias IDs of each visited node

**Relay persistence**
- `relay/server.js` file-backed fallback: writes `relay-events.json` to `userData` on every insert

**Sync fixes**
- `persistStore()` called inside `setSyncUpdateHandler` — synced data survives restarts
- `store.clearAll()` called before restore — no stale data from previous partial loads
- `publishSelfEvents()` — publishes signed identity anchor + name fact claim for the session user on relay connect, so connected instances always see the current user's display name
- Fixed stale closure: `publishSelfEventsRef` ref used in `connectToRelay` (empty deps)
- Fixed: `publishSelfEvents` was calling `store.addRawEvent()` (local only) instead of `publishEvent()` (local + broadcast)

**Person picker deduplication**
- `AddPersonModal` deduplicates the relationship picker using `areAliases()` — only shows the best-data record when two persons are known aliases

**Tree improvements**
- `buildNodeData` resolves alias IDs before person/claim lookup
- Action panel shows contact npub for connected family members

---

### What to work on next

**Media Phase 1 — Profile pictures + stories**

Infrastructure is already built (Stage 7): `blossom.ts`, `MediaCache`, `media_cache` SQLite table, kind 30095 event type. The "Photos & media", "Stories", "Documents", "Timeline" buttons in `FamilyTreeView.tsx` ActionPanel are marked "coming soon".

Proposed implementation (agreed with Matt at end of May 2026 session):

**Profile pictures:**
- File picker in edit modal (PNG/JPG, resized to ≤512px client-side)
- Image stored as base64 in event `content` field (kind 30095, `['type', 'avatar']` tag) — no Blossom HTTP server required for this phase; image data travels in the event itself
- Cap at 200KB after resize
- Display: 40px circular avatar in People tab list items; 48px in tree action panel; 80px in ProfileCard
- Tree nodes: coloured ring indicator for people who have a photo (node too small for actual image)

**Stories:**
- Plain text events (kind 30096, needs reserving in `src/types/chronicle.ts`)
- Tags: `['person_id', id]`, `['title', '...']`; content is story text
- Simple write/read UI in the "Stories" panel

**Defer to later:**
- Videos and documents (need Blossom HTTP server, too large for event content)
- Timeline view (separate UI work)
- WebRTC peer-to-peer sync (still scaffolded only)
- Mobile (Capacitor) — Stage 8

---

### Current version numbering
- Last tag pushed: **v1.0.92**
- Next version to use: **v1.0.93**
- Pattern: `v1.0.x` patch increments, triggered by git tag push

### Deployment reminder
```bat
cd C:\Users\Matt\Desktop\Websites\Chronicle\chronicle-export
tar -xzf C:\Users\Matt\Desktop\Websites\Chronicle\<tarball>.tar.gz -C C:\Users\Matt\Desktop\Websites\Chronicle\
git add -A
git commit -m "vX.X.X — description"
git push
git tag vX.X.X
git push origin vX.X.X
```


---

## v1.0.93 — Media Phase 1: profile pictures + stories

### What was built

**New event kind: 30096 (STORY)**
- Reserved in `src/types/chronicle.ts` alongside existing kinds
- Plain-text story events: `['person_id', id]`, `['title', title]` tags; story text in content field

**New types (`src/types/chronicle.ts`):**
- `PersonAvatar` — holds `personId`, `dataUrl` (base64), `mimeType`, `size`, `createdAt`, `eventId`
- `PersonStory` — holds `eventId`, `personId`, `title`, `content`, `authorNpub`, `createdAt`

**New module: `src/lib/media.ts`**
- `processAvatarImage(file)` — client-side resize to ≤512px, JPEG at 0.85 quality (retry at 0.65), hard limit 200 KB, throws if still over limit
- `estimateBase64Size(dataUrl)` — estimates byte size of base64 payload portion
- Constants: `AVATAR_MAX_PX = 512`, `AVATAR_MAX_BYTES = 200 * 1024`

**New builders in `src/lib/eventBuilder.ts`:**
- `buildAvatarEvent(publisherNpub, publisherNsec, personId, dataUrl, mimeType, size)` — kind 30095 with `type=avatar` tag
- `parseAvatarEvent(event)` — extracts `PersonAvatar` from a kind 30095 event; returns null if not avatar type or malformed
- `buildStoryEvent(authorNpub, authorNsec, personId, title, content)` — kind 30096
- `parseStoryEvent(event)` — extracts `PersonStory` from kind 30096; returns null if malformed

**`src/lib/relaySync.ts` additions:**
- `ingestAvatarEvent` — ingests kind 30095 avatar events; keeps newest by `created_at` per person; resolves alias IDs
- `ingestStoryEvent` — ingests kind 30096 story events; indexes by `eventId`, resolves alias IDs
- Module-level `_avatarStore: Map<personId, PersonAvatar>` and `_storyStore: Map<eventId, PersonStory>`
- `getAvatar(personId)` — returns current avatar for a person
- `getStoriesForPerson(personId)` — returns all stories for a person, newest first
- `replayStoredMediaEvents()` — replays raw events on session restore to repopulate media caches
- `_resetMediaStore()` — for testing only
- Both BLOSSOM_REF and STORY cases added to `ingestEvent` switch
- `replayStoredMediaEvents()` wired into `setSyncUpdateHandler`, `fetchOnConnect` chains, and session restore

**`src/context/AppContext.tsx` additions:**
- Interface: `setAvatar`, `getAvatar`, `addStory`, `getStoriesForPerson`
- `setAvatar(personId, file)` — calls `processAvatarImage`, builds avatar event, publishes + ingests locally, persists
- `addStory(personId, title, content)` — builds story event, publishes + ingests locally, persists
- `getAvatar` / `getStoriesForPerson` delegate to `relaySync` module functions

**New component: `src/components/PhotosPanel.tsx`**
- Slide-in panel shown from FamilyTreeView ActionPanel → "Photos & media"
- Displays current avatar at 120px; upload button triggers file picker
- `AvatarDisplay` component exported for reuse — renders photo if available, falls back to initials circle; supports `ringOnly` prop for compact use

**New component: `src/components/StoriesPanel.tsx`**
- Slide-in panel shown from FamilyTreeView ActionPanel → "Stories"
- Lists all stories newest-first; `StoryCard` with expand/collapse for long stories
- `StoryComposer` — title + textarea; saves via `addStory`; shows error on failure

**UI updates:**
- `FamilyTreeView.tsx` ActionPanel: "Photos & media" and "Stories" buttons now navigate to their respective sub-panels (no longer marked "coming soon"); panel routing via `subPanel` state (`'main' | 'photos' | 'stories'`); avatar shown at 48px in panel header using `AvatarDisplay`; `hasAvatar` field on `NodeData` drives a gold circle + 📷 indicator on tree nodes with photos
- `TreeView.tsx` `PersonAvatar`: shows photo if available (40px circle with gold border), falls back to initials
- `ProfileCard.tsx`: avatar shown at 80px using `AvatarDisplay`; `useApp().getAvatar` called to retrieve

**i18n keys added** (`en.json` + `fr.json`):
- `media.photos.*` — title, addPhoto, noPhotos, uploadHint, uploading, uploadError, changePhoto, avatarAlt
- `media.stories.*` — title, addStory, noStories, titleLabel, titlePlaceholder, contentLabel, contentPlaceholder, save, cancel, saving, by

**New test file: `src/lib/media.test.ts` — 21 tests**
- `estimateBase64Size`: empty URL, known string, padding
- `buildAvatarEvent`/`parseAvatarEvent`: round-trip JPEG and PNG; null for missing type tag; null for wrong kind; null for empty content; all fields extracted correctly
- `buildStoryEvent`/`parseStoryEvent`: round-trip; all fields; null for wrong kind; null for empty content; empty title
- Ingest: avatar retrievable after ingest; newer replaces older; older does not replace newer; stories filtered by person; stories newest-first; `_resetMediaStore` clears all

### Architecture notes

- Avatar images travel inside Nostr events as base64 data URLs — no Blossom HTTP server required for phase 1
- 200 KB cap chosen to keep events manageable on the relay; typical phone photo resized to 512px JPEG lands around 40–80 KB
- The `processAvatarImage` function runs in the browser (Canvas API) — it is not available in Node test environment; tests bypass it and construct `buildAvatarEvent` directly
- `_avatarStore` keeps only the newest avatar per person (most recent `created_at` wins); this means a user can update their photo and connected instances will eventually receive the new event and upgrade their cache
- Stories accumulate; there is no delete mechanism in phase 1

### Gotcha #59 — processAvatarImage is browser-only

`processAvatarImage` uses `createImageBitmap` and `HTMLCanvasElement` — these are not available in Node/Vitest. Tests should call `buildAvatarEvent` directly with a pre-constructed data URL rather than going through `processAvatarImage`. The function is only called from `AppContext.setAvatar` which runs in the browser.

### Gotcha #60 — Avatar and story events deduplicate via raw event store

`ingestEvent` deduplicates all non-handshake events by `event.id` via `store.getRawEvent`. If the same avatar event is pushed twice (e.g. after "Re-sync all my data"), the second call returns false and `ingestAvatarEvent` is never called again for that event ID. This is correct. A new avatar is a new event with a new ID.

### Version: v1.0.93 | Tests: 678/678 | TypeScript: clean | Build: clean

---

## v1.0.94 — Media bug fixes: relay kinds, ingest ordering, reactivity, contact badge

### Bugs fixed

**Bug 1 — Tree node photo indicator showing camera emoji instead of dot**
Root cause: SVG `<text>` elements render emoji unreliably across platforms (Electron WebView, macOS, Windows all differ).
Fix: replaced the two SVG elements (gold circle + emoji text) with a single filled `<circle cx="9" cy="9" r="4.5" fill="var(--gold)" stroke="#fff" stroke-width="1.5">`. Clean dot in the top-left corner of any node that has a photo.

**Bug 2 + 3 — Avatar and story not appearing locally after upload, and not syncing to connected instances**
Root cause (primary): `relay/server.js` `CHRONICLE_KINDS` set only included kinds 30078–30090. Kinds 30091–30096 were missing. The relay was silently rejecting avatar (30095) and story (30096) events with "blocked: kind not accepted". Join requests (30091) had a special exemption but no other post-30090 kinds did.
Fix: added 30091–30096 to `CHRONICLE_KINDS` in `relay/server.js`.

Root cause (secondary): `setAvatar` and `addStory` called `publishEvent` first, then `ingestAvatarEvent`/`ingestStoryEvent`. `publishEvent` calls `store.addRawEvent(event)` which stores the event by ID. `ingestEvent` deduplicates on `store.getRawEvent(event.id)` — so calling `ingestEvent` after `publishEvent` would silently return false without populating `_avatarStore` or `_storyStore`. The avatar/story was stored in the raw event DB but never parsed into the media caches.
Fix: `ingestAvatarEvent` and `ingestStoryEvent` are now exported from `relaySync.ts`. `setAvatar` and `addStory` in AppContext call them **before** `publishEvent`, bypassing the dedup guard for the local ingest path.

**Bug 4 — ProfileCard not re-rendering when avatar is set while modal is open**
Root cause: `ProfileCard` called `useApp().getAvatar` but didn't subscribe to `syncVersion`. If the profile modal was already open when an avatar was uploaded, the card didn't know to re-read from the media store.
Fix: `ProfileCard` now also destructures `syncVersion` from `useApp()` (with `void syncVersion` to satisfy the linter). This subscribes the component to context updates so it re-renders whenever `setSyncVersion` fires.

**Bug 5 — Connected contacts not marked `isLiving: true` in the local store**
Root cause: `ingestIdentityAnchor` always set `isLiving: false` for all ingested persons. A living user's identity anchor has `person_id === claimed_by` (they claim themselves). Ancestors have `claimed_by = the person who added them`, which differs from the `person_id`.
Fix: `ingestIdentityAnchor` now checks `claimedByNpub === personId`. If true, `isLiving: true` is set. Connected contacts (who always self-publish their anchor) now appear as living in the receiving instance.

### Contact badge asymmetry — diagnosis and status

The asymmetry (instance 2 sees instance 1's contact badge; instance 1 doesn't see instance 2's) occurs because:
- Instance 2's person node in instance 1's tree only appears if instance 2 has synced relationship events that reach instance 1's tree traversal
- When those relationships arrive, instance 2's person ID in the edges is their npub (their self-published `person_id`)
- `isContact` check: `contacts.some(c => c.npub === personId)` — this works correctly if the node ID is the contact's npub
- The badge should now appear correctly once sync is working (relay kind fix) and instance 2's relationship events have been received

If the tree was built before sync fixed the missing kinds, a **"Re-sync all my data"** from instance 2's Connect tab will push their events fresh to instance 1's relay.

### Files changed
- `relay/server.js` — `CHRONICLE_KINDS` extended to include 30091–30096
- `src/lib/relaySync.ts` — `ingestAvatarEvent` and `ingestStoryEvent` exported; `ingestIdentityAnchor` sets `isLiving: true` for self-claimed anchors
- `src/context/AppContext.tsx` — `setAvatar`/`addStory` call direct ingest functions before `publishEvent`; removed redundant `ingestEvent` import
- `src/components/FamilyTreeView.tsx` — SVG photo indicator replaced with clean circle
- `src/components/ProfileCard.tsx` — subscribes to `syncVersion` for reactivity

### Gotcha #61 — Relay CHRONICLE_KINDS must be updated when new event kinds are added

`relay/server.js` has a static `CHRONICLE_KINDS` Set. Any new event kind added to `src/types/chronicle.ts` must also be added here or the relay will silently reject events of that kind with "blocked: kind X not accepted". Current range: 30078–30096.

### Gotcha #62 — Always ingest media events before publishEvent

`publishEvent` calls `store.addRawEvent` which marks the event as seen. Any subsequent call to `ingestEvent` will hit the dedup guard and return false. For media events (avatar, story) that need to land in the in-memory media caches, always call `ingestAvatarEvent` or `ingestStoryEvent` **before** calling `publishEvent`.

### Version: v1.0.94 | Tests: 678/678 | TypeScript: clean | Build: clean

---

## v1.0.95 — Tree perspective navigation: "My tree" button + own-node return

### Bugs fixed

**Bug 1 — No way to return to own tree after switching perspective**
Root cause: the "View tree from X's perspective" button was hidden when `isRoot` (you're already viewing from that person), but there was no persistent button to return to your own tree once you'd switched. The only way back was to find your own node in the tree and click it — but your node might not even be visible from the other person's perspective.

Fix: added a **"↩ My tree" button** to the tree toolbar. It appears whenever `rootPubkey !== session?.npub` (i.e. you're viewing from someone else's perspective) and fires `onSelectPerson(session.npub)` to snap back immediately. The button is styled as a small outlined button on the left of the toolbar legend area.

**Bug 2 — "View tree from X's perspective" not shown for your own node**
Root cause: the ActionPanel's perspective-switch button was gated on `isContact` — only contacts triggered it. If you navigated to someone else's tree and your own node was visible, clicking it showed the edit/profile actions but not a "return home" option.

Fix: the button condition is now `(isContact || personId === session?.npub) && !isRoot`. When you click your own node while on someone else's tree, the button reads **"↩ Return to my tree"** instead of "View tree from X's perspective". Both the toolbar button and this node button call the same `onMakeRoot(session.npub)` path.

### Files changed
- `src/components/FamilyTreeView.tsx` — toolbar "↩ My tree" button; ActionPanel session-aware perspective button

### Version: v1.0.95 | Tests: 678/678 | TypeScript: clean | Build: clean

---

## v1.0.96 — Stories grouped under wrong person; contact badge alias-aware; perspective button in panel

### Bugs fixed

**Bug 1 — Stories and avatars grouped under wrong person (e.g. all under Matt)**
Root cause: `getStoriesForPerson(id)` and `getAvatar(id)` did exact-ID lookups against the media stores. When two instances independently created the same person (different UUIDs or one UUID + one npub), stories written for person A's ID couldn't be found when queried by person B's ID — even though both IDs referred to the same real individual.
For the session user specifically: their person ID is their npub. If they also exist in the store as a UUID (created by another instance when adding them as a relative), stories filed under the npub are invisible when the tree traverses to the UUID node and queries stories with that UUID.

Fix: new helper `allIdsForPerson(personId)` in `relaySync.ts` — builds a `Set<string>` of all IDs for a person by checking `store.resolvePersonId` (remote alias → local canonical) and `store.getAliasesFor` (all remote IDs for a local canonical). `getAvatar` iterates all IDs and returns the first match. `getStoriesForPerson` filters stories that match any ID in the set.

**Bug 2 — "View tree from X's perspective" not shown for contacts whose node ID is a UUID alias**
Root cause: `isContact` checked `contacts.some(c => c.npub === personId)` — exact match. If the contact's node ID was a UUID (created before their identity anchor arrived), this never matched.

Fix: `ActionPanel` now builds `personAliasIds` (same set logic as the media fix) and checks `contacts.some(c => personAliasIds.has(c.npub))`.

**Bug 3 — Switching to contact's perspective using UUID root instead of npub**
Root cause: `onMakeRoot(personId)` was called with the node's ID, which might be a UUID. `traverseGraph` starting from a UUID finds no relationships if the contact's relationships are indexed under their npub.

Fix: perspective button now resolves to the contact's actual npub: `contacts.find(c => personAliasIds.has(c.npub))?.npub ?? personId`.

**Bug 4 — "↩ My tree" / "↩ Return to my tree" button was in the toolbar (wrong place)**
Moved into the ActionPanel as a persistent footer button — visible whenever `rootPubkey !== session?.npub`, regardless of which node is selected. Styled as `btn-ghost` to distinguish it from the contact perspective button (`btn-outline`). The toolbar is back to information-only.

Also cleaned up: the "View tree from X's perspective" button no longer shows `↩ Return to my tree` label for your own node — the dedicated footer handles that case.

### New tests (3)
`src/lib/media.test.ts` — `alias-aware media lookup`:
- `getStoriesForPerson` finds stories filed under a remote alias ID when queried via local UUID
- `getAvatar` finds avatar filed under a remote alias ID when queried via local UUID
- `getStoriesForPerson` via remote npub finds stories filed under local UUID

### Files changed
- `src/lib/relaySync.ts` — `allIdsForPerson` helper; alias-aware `getAvatar` and `getStoriesForPerson`
- `src/components/FamilyTreeView.tsx` — alias-aware `isContact`; npub-resolved `onMakeRoot`; "↩ Return to my tree" as panel footer; toolbar restored to display-only
- `src/lib/media.test.ts` — 3 new alias tests; `ingestAvatarEvent`/`ingestStoryEvent` added to imports

### Gotcha #63 — Media lookups must be alias-aware
`getAvatar` and `getStoriesForPerson` must check all alias IDs for a person, not just the exact ID passed. Two instances can have the same real person under different IDs. Use `allIdsForPerson(id)` before querying the media stores. Same principle applies to any future per-person media index.

### Version: v1.0.96 | Tests: 681/681 | TypeScript: clean | Build: clean

---

## v1.0.97 — Contact badge auto-alias; deterministic tree layout; correct npub display

### Bugs fixed

**Bug 1 — "Connected family member" badge not appearing for contacts whose node is a UUID**

Root cause traced through three layers:

1. `ingestIdentityAnchor` received Maria's self-published anchor (`person_id = maria.npub`). Instance 1 had created a UUID-based stub for Maria earlier. `store.getPerson(maria.npub)` returned null (wrong ID). `store.resolvePersonId(maria.npub)` returned null (no alias registered). A second person record was created (`id = maria.npub`) — a duplicate. No alias was ever registered between `uuid-maria` and `maria.npub`.

2. `personAliasIds` in ActionPanel only collected IDs reachable from the alias table. With no alias between the two records, the UUID node had `personAliasIds = { uuid }`. `contacts.some(c => personAliasIds.has(c.npub))` failed.

Fix in `ingestIdentityAnchor`: when a self-published anchor arrives (`claimedBy === personId`) for a known contact (npub is in `_getContactNpubs()`), and no direct or alias match exists, scan all existing persons for one whose name claims match the incoming contact's name. If found, register the alias and mark the existing stub as `isLiving: true` instead of creating a duplicate. Log line: `[ingestIdentityAnchor] auto-aliased contact X → Y via name "Maria"`.

Also fixed: when `existing` person is found by exact ID and `claimedBy === personId` but `isLiving` is false, update it to `isLiving: true` (handles re-ingest after restart).

`setContactPubkeysProvider` re-wired as a real provider (was a no-op since v1.0.83). AppContext already called it correctly at line 542.

**Bug 2 — npub display showing UUID instead of actual npub for aliased contacts**
Fix: resolved the actual npub via `contacts.find(c => personAliasIds.has(c.npub))?.npub ?? personId` before rendering.

**Bug 3 — Tree layout different between instances (skewed on instance 2)**
Root cause: `computeLayout` sorted groups by parent midpoint, but within each group, members were in BFS insertion order from `traverseGraph`. BFS visits nodes in the order relationships were stored — which differs between instances (instance 1 built its graph from scratch; instance 2 received instance 1's events via sync in relay storage order). The same family tree produced different visual arrangements.
Fix: each generation's node list is sorted by ID (`members.sort()`) before layout computation. IDs (UUIDs and npubs) are stable across instances for the same real person, so the layout is now deterministic regardless of which instance built the graph or in which order.

### Files changed
- `src/lib/relaySync.ts` — `setContactPubkeysProvider` restored as real provider; `_getContactNpubs` used in `ingestIdentityAnchor` for auto-alias; `existing` check updates `isLiving` flag
- `src/components/FamilyTreeView.tsx` — npub display resolves to contact's actual npub
- `src/components/FamilyTreeView.layout.ts` — `members.sort()` per generation for deterministic layout

### Gotcha #64 — ingestIdentityAnchor auto-alias requires contact provider wired

The auto-alias logic in `ingestIdentityAnchor` only fires if `_getContactNpubs` is non-null. This is set by `setContactPubkeysProvider` which is called from `AppContext.startRelay`. If the relay starts before the contact list is loaded from storage, the first anchor may arrive before the provider is set. The auto-alias will not fire in that case — but the anchor will still be ingested correctly as a separate person record. A subsequent "Re-sync all my data" will re-trigger the anchor and the auto-alias will succeed. A permanent fix would be to re-run auto-alias after the contact list is loaded; deferred.

### Gotcha #65 — Layout determinism requires stable node ordering

`byGen` node lists must be sorted by a stable key before `buildSlots`. Without this, any two instances with the same graph but different BFS traversal order will produce visually different layouts. The sort key is the person ID string — UUID and npub strings both sort stably.

### Version: v1.0.97 | Tests: 681/681 | TypeScript: clean | Build: clean

---

## v1.0.98 — Contact alias replay on session start; root-centred tree layout

### Bugs fixed

**Bug 1 — Contact badge still not appearing after v1.0.97**

Root cause traced to the replay gap: the auto-alias in `ingestIdentityAnchor` fired correctly for *new* incoming anchors, but existing sessions already had Maria's anchor stored in the raw event store. `ingestEvent` deduplicates on event ID — once an anchor is stored it's never re-processed. The auto-alias code therefore never ran on session restore, leaving the UUID stub and npub record as two disconnected persons.

Two-part fix:

1. **`tryAutoAliasContact(personId, claimedByNpub, createdAt)`** — extracted as a standalone function, called unconditionally from `ingestIdentityAnchor` for self-published anchors (`claimedBy === personId`), regardless of whether the person already exists. Idempotent: checks `resolvePersonId` before registering to avoid double-registration.

2. **`replayStoredIdentityAnchors()`** — new exported function. Iterates all stored IDENTITY_ANCHOR raw events and calls `ingestIdentityAnchor` on each, bypassing the event-level dedup guard. Called from `beginSession` immediately after the contact list is loaded from storage. This ensures that on every session start, after contacts are known, all stored anchors are re-evaluated for auto-aliasing.

After this fix: on next launch of instance 1, contacts load → `replayStoredIdentityAnchors` runs → Maria's anchor is re-processed → `tryAutoAliasContact` finds Maria's UUID stub by name match → alias registered → `isContact` returns true → badge appears.

**Bug 2 — Tree layout off-centre when returning to own tree**

Root cause: auto-fit was centring on the bounding-box midpoint `(minX+maxX)/2, (minY+maxY)/2`. For asymmetric trees (more relatives on one side), the bounding box midpoint differs from the root node position, so the root appears off to one side.

Fix: auto-fit now translates the D3 zoom to place the root node (always at layout coords 0, 0) at screen position `(width/2, height*0.6)`. The 60% vertical placement ensures ancestors (which sit above generation 0) have room to display. Layout geometry is identical; only the viewport transform changes.

### Files changed
- `src/lib/relaySync.ts` — `tryAutoAliasContact` extracted; `ingestIdentityAnchor` always calls it for living users; `replayStoredIdentityAnchors` exported; unused `Person` import removed
- `src/context/AppContext.tsx` — `replayStoredIdentityAnchors` imported and called after contacts load; `replayStoredIdentityAnchors` added to relaySync import
- `src/components/FamilyTreeView.tsx` — auto-fit centres on root node (0,0) at `(width/2, height*0.6)` instead of bounding-box centre
- `src/components/FamilyTreeView.layout.ts` — `members.sort()` per generation (from v1.0.97, retained)

### What to do after deploying

On the existing two-instance setup, the alias won't register until `replayStoredIdentityAnchors` runs — which happens automatically on the next app launch. No manual action needed. The contact badge should appear after restarting both instances.

If it still doesn't appear: go to instance 2's Connect tab → "↺ Re-sync all my data". This pushes Maria's identity anchor fresh to instance 1's relay, triggering `ingestIdentityAnchor` live (not from the dedup-guarded raw store), which will call `tryAutoAliasContact` and register the alias immediately.

### Gotcha #66 — Auto-alias requires replay after contacts load

`tryAutoAliasContact` only works when `_getContactNpubs()` returns the correct contact list. On session restore, contacts are loaded asynchronously after the relay starts. Any identity anchor that arrived during a previous session (and is now in the raw store) must be re-processed after contacts load — that's what `replayStoredIdentityAnchors` does. Without this replay, the auto-alias only fires for anchors received *live* (after contacts are in memory), not for anchors already stored.

### Version: v1.0.98 | Tests: 681/681 | TypeScript: clean | Build: clean

---

## v1.0.99 — Tree not clipping; avatar shows immediately on session start

### Bugs fixed

**Bug 1 — Tree cut off at bottom after v1.0.98**
Root cause: the auto-fit change placed the root at a fixed `height * 0.6` vertical position regardless of the actual tree height below the root. For trees with many descendants, the bottom nodes were placed below the viewport.

Fix: hybrid approach — horizontal translation centres on the root node (layout x=0 → screen x=width/2), vertical translation centres the full bounding box in the viewport (`height/2 - scale * cy` where `cy` is the bounding box midpoint y). This guarantees nothing is clipped while keeping the root horizontally centred.

**Bug 2 — Avatar not showing on own tree (instance 2) or after perspective switch**
Root cause: `_avatarStore` is populated by `replayStoredMediaEvents()`, which is called in the `fetchOnConnect` completion chain. However, `setSyncVersion` was NOT called after this chain on the local relay's `fetchOnConnect`. Components that read `getAvatar` (ActionPanel, ProfileCard, TreeView PersonAvatar) only re-render when `syncVersion` changes. Without the bump, they rendered stale (empty avatar) and never re-rendered to show the avatar.

The window: session starts → `setScreen('main')` → tree renders immediately → ActionPanel opens → `getAvatar` returns undefined (store empty). `fetchOnConnect` completes ~1 second later → `replayStoredMediaEvents` populates `_avatarStore` → but no `setSyncVersion` bump → components don't re-render → avatar stays invisible until an unrelated sync event arrives.

Fix: added `setSyncVersion(v => v + 1)` to all three `fetchOnConnect` completion chains (local relay, `connectToRelay`, `addContact` relay loop).

### Files changed
- `src/components/FamilyTreeView.tsx` — auto-fit: horizontal root-centred, vertical bounding-box-centred
- `src/context/AppContext.tsx` — all three `fetchOnConnect` chains now call `setSyncVersion(v => v + 1)` after `replayStoredMediaEvents`

### Version: v1.0.99 | Tests: 681/681 | TypeScript: clean | Build: clean
