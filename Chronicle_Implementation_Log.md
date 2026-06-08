
---

## Chronicle Shared Bootstrap Relay — v1.1.6

### What was built

Wired `wss://chronicle.plume.website` (Strfry instance on Matt's VPS) as Chronicle's
shared bootstrap relay. All instances connect to it automatically on startup alongside
their local relay, enabling remote sync without UPnP or port forwarding.

### Files changed
- `src/context/AppContext.tsx`
  - Added `CHRONICLE_RELAY_URL = 'wss://chronicle.plume.website'` (exported constant)
  - `startRelay` connects a second `bootstrapClient` to the shared relay; fetches + syncs on connect
  - `sendJoinRequest` and `acceptJoinRequest` advertise `externalRelayUrl ?? CHRONICLE_RELAY_URL`
- `src/App.tsx` — invite codes use `externalRelayUrl ?? CHRONICLE_RELAY_URL` as the relay address
- `src/components/SettingsView.tsx` — "Chronicle shared relay" status card showing connected/connecting/disconnected with the relay URL

### Behaviour
- On startup, Chronicle connects to both the local relay and `chronicle.plume.website`
- Events flow through whichever relay both parties are connected to
- WebRTC direct sync still used for live P2P once peers are introduced
- Invite codes advertise the shared relay URL — remote instances connect immediately
- Settings page shows live connection status for both local and shared relay

### Version: v1.1.6 | Tests: 711/711 | TypeScript: clean | Build: clean

---

## ⚠️ NEXT SESSION HANDOVER

### Last version: v1.1.6 | Tarball: chronicle-v1_1_6.tar.gz
### Tests: 711/711 | TypeScript: clean | Build: clean

### Deferred bugs (still pending)
- **Bug A** — Stories privacy tier filtering
- **Bug B** — Duplicate person nodes after alias reconciliation
- **Bug C** — persistStore not called after reconcilePersonAliases on restore path

### Next session
1. Test remote third instance via chronicle.plume.website
2. Fix deferred bugs A/B/C
3. FamilySearch API integration

### Deployment
```
cd C:\Users\Matt\Desktop\Websites\Chronicle\chronicle-export
git status
git add -A
git commit -m "v1.1.6 — Chronicle shared bootstrap relay"
git push
git tag v1.1.6
git push origin v1.1.6
```
