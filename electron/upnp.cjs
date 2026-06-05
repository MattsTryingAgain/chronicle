/**
 * UPnP port mapping for Chronicle's embedded relay.
 *
 * Attempts to:
 *   1. Map an external TCP port → local relay port via the router's UPnP gateway
 *   2. Discover the machine's external (WAN) IP address
 *
 * Returns the external WebSocket URL on success, or null on failure.
 * All errors are non-fatal — local-only sync continues working if UPnP is
 * unavailable (corporate networks, routers with UPnP disabled, etc).
 *
 * Called once from electron/main.cjs after the relay process starts.
 */

'use strict'

const natUpnp = require('nat-upnp')

// How long to wait for UPnP gateway discovery (ms)
const UPNP_TIMEOUT_MS = 8000

// Port mapping lease duration (seconds) — 30 minutes; renewed on next launch
const LEASE_TTL = 60 * 30

// Description shown in router's port mapping table
const MAPPING_DESC = 'Chronicle family sync'

/**
 * Attempt UPnP port mapping for the given relay port.
 * @param {number} internalPort  - Local relay port (e.g. 4869)
 * @param {number} externalPort  - Requested external port (same by default)
 * @param {function} log         - Logging function (msg: string) => void
 * @returns {Promise<string|null>} External ws:// URL or null if UPnP failed
 */
function attemptUPnP(internalPort, externalPort, log) {
  return new Promise((resolve) => {
    const client = natUpnp.createClient()
    client.timeout = UPNP_TIMEOUT_MS

    // Step 1: request port mapping
    client.portMapping({
      public:   { port: externalPort },
      private:  { port: internalPort },
      protocol: 'TCP',
      description: MAPPING_DESC,
      ttl: LEASE_TTL,
    }, (mapErr) => {
      if (mapErr) {
        log(`[UPnP] Port mapping failed: ${mapErr.message || mapErr}`)
        client.close?.()
        resolve(null)
        return
      }

      log(`[UPnP] Port mapping succeeded: external ${externalPort} → local ${internalPort}`)

      // Step 2: get external IP
      client.externalIp((ipErr, ip) => {
        client.close?.()

        if (ipErr || !ip) {
          log(`[UPnP] External IP lookup failed: ${ipErr?.message || 'no IP returned'}`)
          resolve(null)
          return
        }

        const url = `ws://${ip}:${externalPort}`
        log(`[UPnP] External relay address: ${url}`)
        resolve(url)
      })
    })
  })
}

/**
 * Remove a previously registered port mapping.
 * Called on app quit so the router cleans up.
 * @param {number} externalPort
 * @param {function} log
 */
function removeUPnPMapping(externalPort, log) {
  return new Promise((resolve) => {
    const client = natUpnp.createClient()
    client.timeout = 4000

    client.portUnmapping({
      public:   { port: externalPort },
      protocol: 'TCP',
    }, (err) => {
      client.close?.()
      if (err) {
        log(`[UPnP] Port unmap failed (non-fatal): ${err.message || err}`)
      } else {
        log(`[UPnP] Port mapping removed for external port ${externalPort}`)
      }
      resolve()
    })
  })
}

module.exports = { attemptUPnP, removeUPnPMapping }
