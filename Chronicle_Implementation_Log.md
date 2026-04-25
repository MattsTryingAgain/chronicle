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

### Fix 4: Relationship graph not persisted across sessions

**Root cause:** `serialiseGraph()` and `deserialiseGraph()` already existed in `graph.ts` but were never wired into `AppContext`. The graph store is a separate module-level singleton from `MemoryStore`, so it was never included in the `chronicle:store` localStorage key.

**Fix:**
- `AppContext` imports `serialiseGraph` / `deserialiseGraph` from `graph.ts`
- `persistStore` now writes `chronicle:graph` to localStorage alongside `chronicle:store`
- The restore-on-mount effect reads `chronicle:graph` and calls `deserialiseGraph()` after restoring the main store
- `AddPersonModal`'s `persistNow()` also writes `chronicle:graph` (covers the relationship claims added in the same save operation)
