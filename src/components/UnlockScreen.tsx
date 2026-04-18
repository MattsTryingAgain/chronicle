/**
 * UnlockScreen
 * Shown when the app starts and finds a stored (encrypted) identity.
 * The user enters their password to decrypt the nsec into memory.
 */

import { useState, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { store } from '../lib/storage'

export function UnlockScreen() {
  const { unlockIdentity, setScreen } = useApp()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const identity = store.getIdentity()

  const handleUnlock = useCallback(async () => {
    if (!password) return
    setError('')
    setLoading(true)
    try {
      const ok = await unlockIdentity(password)
      if (!ok) setError('Incorrect password. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [password, unlockIdentity])

  return (
    <div className="onboarding-wrap">
      <div className="onboarding-panel">
        <div className="onboarding-header">
          <div className="onboarding-logo">Chronicle</div>
          <h1 className="onboarding-title">Welcome back</h1>
          <p className="onboarding-subtitle">
            {identity
              ? `Enter your password to unlock ${identity.displayName}'s account.`
              : 'Enter your password to continue.'}
          </p>
        </div>
        <div className="onboarding-body">
          {identity && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-md)',
              padding: 'var(--space-md)',
              background: 'var(--gold-pale)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid rgba(201,169,110,0.35)',
            }}>
              <div style={{
                width: 40, height: 40,
                borderRadius: '50%',
                background: 'var(--navy)',
                color: 'var(--gold-light)',
                fontFamily: 'var(--font-display)',
                fontWeight: 700,
                fontSize: 16,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                {identity.displayName.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, color: 'var(--navy)' }}>
                  {identity.displayName}
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-muted)', fontFamily: 'monospace', marginTop: 2 }}>
                  {identity.npub.slice(0, 20)}…
                </div>
              </div>
            </div>
          )}

          <div className="field">
            <label htmlFor="unlock-pw">Password</label>
            <input
              id="unlock-pw"
              type="password"
              placeholder="Your Chronicle password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleUnlock()}
              autoFocus
              autoComplete="current-password"
            />
          </div>

          {error && <div className="alert alert-danger">{error}</div>}

          <button
            className="btn btn-gold btn-lg btn-full"
            onClick={handleUnlock}
            disabled={loading || !password}
          >
            {loading ? 'Unlocking…' : 'Unlock'}
          </button>

          <div style={{ textAlign: 'center' }}>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setScreen('onboarding-create')}
              style={{ fontSize: 13, color: 'var(--ink-muted)' }}
            >
              Use a different account
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
