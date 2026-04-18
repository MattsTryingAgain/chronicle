/**
 * AboutView — Stage 6
 *
 * Explains Chronicle's underlying protocol and cross-ecosystem identity
 * in plain language. No Nostr jargon in the main flow — this section is
 * for curious users who want to understand the technology.
 */

import { useTranslation } from 'react-i18next'

export function AboutView() {
  const { t } = useTranslation()

  return (
    <div className="p-3" style={{ maxWidth: 600, margin: '0 auto' }}>
      {/* Logo mark */}
      <div className="text-center mb-4 mt-2">
        <div style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 64, height: 64, borderRadius: 12,
          background: 'var(--navy-mid)', border: '1px solid rgba(201,169,110,0.3)',
        }}>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 28, color: 'var(--gold)' }}>Cr</span>
        </div>
        <h2 className="mt-3 mb-0" style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)' }}>
          {t('app.name')}
        </h2>
        <p className="text-muted small mt-1">{t('app.tagline')}</p>
      </div>

      {/* What is Chronicle */}
      <section className="mb-4">
        <h5 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold-light)', marginBottom: 8 }}>
          {t('about.whatTitle')}
        </h5>
        <p style={{ color: 'var(--ink-soft)', lineHeight: 1.7, fontSize: '0.9rem' }}>
          {t('about.whatBody')}
        </p>
      </section>

      {/* How it works */}
      <section className="mb-4">
        <h5 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold-light)', marginBottom: 8 }}>
          {t('about.howTitle')}
        </h5>
        <p style={{ color: 'var(--ink-soft)', lineHeight: 1.7, fontSize: '0.9rem' }}>
          {t('about.howBody')}
        </p>

        <div className="mt-3 p-3 rounded" style={{ background: 'rgba(201,169,110,0.06)', border: '1px solid rgba(201,169,110,0.15)' }}>
          <div className="d-flex gap-3 mb-2">
            <span style={{ color: 'var(--gold)', fontSize: '1.2rem' }}>🔑</span>
            <div>
              <div style={{ fontWeight: 600, color: 'var(--gold-light)', fontSize: '0.85rem' }}>{t('about.identityTitle')}</div>
              <div style={{ color: 'var(--ink-muted)', fontSize: '0.8rem' }}>{t('about.identityBody')}</div>
            </div>
          </div>
          <div className="d-flex gap-3 mb-2">
            <span style={{ color: 'var(--gold)', fontSize: '1.2rem' }}>✍️</span>
            <div>
              <div style={{ fontWeight: 600, color: 'var(--gold-light)', fontSize: '0.85rem' }}>{t('about.claimsTitle')}</div>
              <div style={{ color: 'var(--ink-muted)', fontSize: '0.8rem' }}>{t('about.claimsBody')}</div>
            </div>
          </div>
          <div className="d-flex gap-3">
            <span style={{ color: 'var(--gold)', fontSize: '1.2rem' }}>🌐</span>
            <div>
              <div style={{ fontWeight: 600, color: 'var(--gold-light)', fontSize: '0.85rem' }}>{t('about.decentralTitle')}</div>
              <div style={{ color: 'var(--ink-muted)', fontSize: '0.8rem' }}>{t('about.decentralBody')}</div>
            </div>
          </div>
        </div>
      </section>

      {/* Nostr protocol */}
      <section className="mb-4">
        <h5 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold-light)', marginBottom: 8 }}>
          {t('about.protocolTitle')}
        </h5>
        <p style={{ color: 'var(--ink-soft)', lineHeight: 1.7, fontSize: '0.9rem' }}>
          {t('about.protocolBody')}
        </p>
        <a
          href="https://nostr.com"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--gold)', fontSize: '0.85rem' }}
          onClick={e => {
            if (typeof window !== 'undefined' && (window as any).chronicleElectron) {
              e.preventDefault()
              ;(window as any).chronicleElectron.openExternal('https://nostr.com')
            }
          }}
        >
          {t('about.learnNostr')} →
        </a>
      </section>

      {/* Cross-ecosystem identity */}
      <section className="mb-4">
        <h5 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold-light)', marginBottom: 8 }}>
          {t('about.ecosystemTitle')}
        </h5>
        <p style={{ color: 'var(--ink-soft)', lineHeight: 1.7, fontSize: '0.9rem' }}>
          {t('about.ecosystemBody')}
        </p>
      </section>

      {/* Open source */}
      <section className="mb-4">
        <h5 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold-light)', marginBottom: 8 }}>
          {t('about.openSourceTitle')}
        </h5>
        <p style={{ color: 'var(--ink-soft)', lineHeight: 1.7, fontSize: '0.9rem' }}>
          {t('about.openSourceBody')}
        </p>
      </section>

      {/* Version */}
      <div className="text-center mt-4 pt-3" style={{ borderTop: '1px solid rgba(201,169,110,0.15)' }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--ink-muted)' }}>
          Chronicle · {t('about.licence')} · {t('about.schemaVersion')}: 1
        </span>
      </div>
    </div>
  )
}
