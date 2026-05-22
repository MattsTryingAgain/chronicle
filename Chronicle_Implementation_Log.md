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
