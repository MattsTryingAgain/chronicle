/**
 * Onboarding screens
 * Screen 1: Create identity (name + password)
 * Screen 2: Save recovery phrase
 * Screen 3: Start your tree
 * Alt screen: Import existing key
 */

import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'

// ─── Step indicator ───────────────────────────────────────────────────────────

function StepDots({ current, total }: { current: number; total: number }) {
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          style={{
            width: i === current ? 20 : 6,
            height: 6,
            borderRadius: 3,
            background: i === current ? 'var(--gold)' : 'rgba(201,169,110,0.3)',
            transition: 'all 0.3s var(--ease)',
          }}
        />
      ))}
    </div>
  )
}

// ─── Screen 1: Create Identity ────────────────────────────────────────────────

function CreateIdentityScreen({ onImport }: { onImport: () => void }) {
  const { t } = useTranslation()
  const { createIdentity, setScreen, isGeneratingKey } = useApp()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = useCallback(async () => {
    setError('')
    if (!name.trim()) { setError(t('errors.generic')); return }
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return }
    if (password !== confirm) { setError('Passwords do not match.'); return }
    try {
      await createIdentity(name.trim(), password)
      setScreen('onboarding-phrase')
    } catch {
      setError(t('errors.keyGenFailed'))
    }
  }, [name, password, confirm, createIdentity, setScreen, t])

  return (
    <div className="onboarding-wrap">
      <div className="onboarding-panel">
        <div className="onboarding-header">
          <div className="onboarding-logo">Chronicle</div>
          <StepDots current={0} total={3} />
          <h1 className="onboarding-title">{t('onboarding.createIdentity.title')}</h1>
          <p className="onboarding-subtitle">
            Your family history, preserved and verified forever.
          </p>
        </div>
        <div className="onboarding-body">
          <div className="field">
            <label htmlFor="ob-name">{t('onboarding.createIdentity.nameLabel')}</label>
            <input
              id="ob-name"
              type="text"
              placeholder={t('onboarding.createIdentity.namePlaceholder')}
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
              autoComplete="name"
            />
          </div>
          <div className="field">
            <label htmlFor="ob-pw">Password</label>
            <input
              id="ob-pw"
              type="password"
              placeholder="At least 8 characters"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="new-password"
            />
            <span className="field-hint">Used to protect your identity on this device.</span>
          </div>
          <div className="field">
            <label htmlFor="ob-pw2">Confirm password</label>
            <input
              id="ob-pw2"
              type="password"
              placeholder="Repeat your password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              autoComplete="new-password"
              onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            />
          </div>
          {error && <div className="alert alert-danger">{error}</div>}
          <button
            className="btn btn-gold btn-lg btn-full"
            onClick={handleSubmit}
            disabled={isGeneratingKey || !name.trim() || !password || !confirm}
          >
            {isGeneratingKey ? 'Generating…' : t('onboarding.createIdentity.continueButton')}
          </button>
          <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--ink-muted)' }}>
            Already have an account?{' '}
            <button className="btn btn-ghost btn-sm" onClick={onImport}>
              {t('onboarding.importKey.title')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Screen 2: Recovery Phrase ────────────────────────────────────────────────

function RecoveryPhraseScreen() {
  const { t } = useTranslation()
  const { setScreen, generatedMnemonic } = useApp()
  const [copied, setCopied] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  const words = generatedMnemonic?.split(' ') ?? []

  const handleCopy = useCallback(async () => {
    if (!generatedMnemonic) return
    await navigator.clipboard.writeText(generatedMnemonic)
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }, [generatedMnemonic])

  return (
    <div className="onboarding-wrap">
      <div className="onboarding-panel">
        <div className="onboarding-header">
          <div className="onboarding-logo">Chronicle</div>
          <StepDots current={1} total={3} />
          <h1 className="onboarding-title">{t('onboarding.recoveryPhrase.title')}</h1>
          <p className="onboarding-subtitle">{t('onboarding.recoveryPhrase.instruction')}</p>
        </div>
        <div className="onboarding-body">
          <div className="alert alert-warn" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <span>⚠️</span>
            <div>
              <strong>{t('onboarding.recoveryPhrase.warningTitle')}: </strong>
              {t('onboarding.recoveryPhrase.warning')}
            </div>
          </div>

          <div className="mnemonic-grid">
            {words.map((word, i) => (
              <div key={i} className="mnemonic-word">
                <span className="mnemonic-word-num">{i + 1}</span>
                <span className="mnemonic-word-text">{word}</span>
              </div>
            ))}
          </div>

          <button
            className="btn btn-outline btn-full"
            onClick={handleCopy}
          >
            {copied ? t('onboarding.recoveryPhrase.copiedConfirm') : t('onboarding.recoveryPhrase.copyButton')}
          </button>

          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, cursor: 'pointer', color: 'var(--ink-soft)' }}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={e => setConfirmed(e.target.checked)}
              style={{ width: 16, height: 16, accentColor: 'var(--navy)' }}
            />
            I've written down my recovery phrase and stored it somewhere safe.
          </label>

          <button
            className="btn btn-primary btn-lg btn-full"
            onClick={() => setScreen('onboarding-start')}
            disabled={!confirmed}
          >
            {t('onboarding.recoveryPhrase.confirmButton')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Screen 3: Start Tree ─────────────────────────────────────────────────────

function StartTreeScreen() {
  const { t } = useTranslation()
  const { setScreen } = useApp()

  return (
    <div className="onboarding-wrap">
      <div className="onboarding-panel">
        <div className="onboarding-header">
          <div className="onboarding-logo">Chronicle</div>
          <StepDots current={2} total={3} />
          <h1 className="onboarding-title">{t('onboarding.startTree.title')}</h1>
          <p className="onboarding-subtitle">{t('onboarding.startTree.instruction')}</p>
        </div>
        <div className="onboarding-body">
          <div style={{ textAlign: 'center', padding: '8px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>🌳</div>
            <p style={{ color: 'var(--ink-soft)', fontSize: 15, lineHeight: 1.6 }}>
              You're ready to begin. Start by adding yourself, then invite family members
              and add ancestors over time.
            </p>
          </div>
          <button
            className="btn btn-gold btn-lg btn-full"
            onClick={() => setScreen('main')}
          >
            {t('onboarding.startTree.addSelfButton')}
          </button>
          <button
            className="btn btn-ghost btn-full"
            onClick={() => setScreen('main')}
          >
            {t('onboarding.startTree.skipButton')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Import Screen ────────────────────────────────────────────────────────────

function ImportScreen({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation()
  const { importIdentity, setScreen } = useApp()
  const [input, setInput] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleImport = useCallback(async () => {
    setError('')
    setLoading(true)
    try {
      await importIdentity(input.trim(), name.trim(), password)
      setScreen('main')
    } catch {
      setError(t('onboarding.importKey.errorInvalid'))
    } finally {
      setLoading(false)
    }
  }, [input, name, password, importIdentity, setScreen, t])

  return (
    <div className="onboarding-wrap">
      <div className="onboarding-panel">
        <div className="onboarding-header">
          <div className="onboarding-logo">Chronicle</div>
          <h1 className="onboarding-title">{t('onboarding.importKey.title')}</h1>
          <p className="onboarding-subtitle">{t('onboarding.importKey.instruction')}</p>
        </div>
        <div className="onboarding-body">
          <div className="field">
            <label htmlFor="import-key">{t('onboarding.importKey.inputLabel')}</label>
            <textarea
              id="import-key"
              rows={3}
              placeholder={t('onboarding.importKey.inputPlaceholder')}
              value={input}
              onChange={e => setInput(e.target.value)}
              style={{ resize: 'vertical' }}
            />
          </div>
          <div className="field">
            <label htmlFor="import-name">{t('profile.addPerson.nameLabel')}</label>
            <input
              id="import-name"
              type="text"
              placeholder={t('profile.addPerson.namePlaceholder')}
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="import-pw">New password</label>
            <input
              id="import-pw"
              type="password"
              placeholder="Protect this identity on this device"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </div>
          {error && <div className="alert alert-danger">{error}</div>}
          <button
            className="btn btn-primary btn-lg btn-full"
            onClick={handleImport}
            disabled={loading || !input.trim() || !name.trim() || !password}
          >
            {loading ? 'Importing…' : t('onboarding.importKey.importButton')}
          </button>
          <button className="btn btn-ghost btn-full" onClick={onBack}>
            ← Back
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Onboarding root ──────────────────────────────────────────────────────────

export function Onboarding() {
  const { screen, setScreen } = useApp()

  if (screen === 'onboarding-import') {
    return <ImportScreen onBack={() => setScreen('onboarding-create')} />
  }
  if (screen === 'onboarding-phrase') {
    return <RecoveryPhraseScreen />
  }
  if (screen === 'onboarding-start') {
    return <StartTreeScreen />
  }
  return <CreateIdentityScreen onImport={() => setScreen('onboarding-import')} />
}
