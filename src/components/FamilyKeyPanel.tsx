/**
 * FamilyKeyPanel — Stage 5
 *
 * Settings panel section for managing the family shared key:
 *   - Generate a new family key (first-time setup)
 *   - Show key status (held / not held)
 *   - Admit a new member by pasting their npub and Curve25519 pubkey
 *
 * Rendered inside SettingsView under a "Privacy" section.
 */

import { useState, useCallback } from 'react'
import { Card, Button, Form, Alert, Badge, Spinner } from 'react-bootstrap'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { curve25519PubkeyFromNsec } from '../lib/privacyTier'
import { decodeBase64 } from 'tweetnacl-util'

export function FamilyKeyPanel() {
  const { t } = useTranslation()
  const { hasFamilyKey, initFamilyKey, admitFamilyMember, session } = useApp()

  const [admitNpub, setAdmitNpub] = useState('')
  const [admitCurve, setAdmitCurve] = useState('')   // base64 Curve25519 pubkey from recipient
  const [admitStatus, setAdmitStatus] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [admitError, setAdmitError] = useState('')

  const handleAdmit = useCallback(async () => {
    if (!admitNpub.trim() || !admitCurve.trim()) return
    setAdmitStatus('busy')
    setAdmitError('')
    try {
      const pubKey = decodeBase64(admitCurve.trim())
      if (pubKey.length !== 32) throw new Error('Curve25519 pubkey must be 32 bytes')
      await admitFamilyMember(admitNpub.trim(), pubKey)
      setAdmitStatus('done')
      setAdmitNpub('')
      setAdmitCurve('')
    } catch (e) {
      setAdmitError((e as Error).message)
      setAdmitStatus('error')
    }
  }, [admitNpub, admitCurve, admitFamilyMember])

  // Allow a user to copy their own Curve25519 pubkey to share with an admitting member
  const [myCurve, setMyCurve] = useState<string | null>(null)
  const handleShowMyCurve = useCallback(async () => {
    if (!session) return
    const { encodeBase64 } = await import('tweetnacl-util')
    const pub = await curve25519PubkeyFromNsec(session.nsec)
    setMyCurve(encodeBase64(pub))
  }, [session])

  return (
    <Card className="mb-3 border-0 shadow-sm">
      <Card.Header className="fw-semibold">
        {t('privacy.title')}{' '}
        {hasFamilyKey
          ? <Badge bg="success" className="ms-2">{t('privacy.familyKey.held')}</Badge>
          : <Badge bg="secondary" className="ms-2">{t('privacy.familyKey.notHeld')}</Badge>}
      </Card.Header>
      <Card.Body>
        {/* Generate key */}
        {!hasFamilyKey && (
          <div className="mb-3">
            <p className="text-muted small">{t('privacy.tierDescriptions.family')}</p>
            <Button size="sm" variant="outline-primary" onClick={initFamilyKey}>
              {t('privacy.familyKey.title')} — Generate
            </Button>
          </div>
        )}

        {/* My Curve25519 pubkey (for receiving admission) */}
        {session && (
          <div className="mb-3">
            <p className="text-muted small mb-1">Share your admission key with an existing member:</p>
            {myCurve ? (
              <Form.Control readOnly size="sm" value={myCurve} className="font-monospace" />
            ) : (
              <Button size="sm" variant="outline-secondary" onClick={handleShowMyCurve}>
                Show my admission key
              </Button>
            )}
          </div>
        )}

        {/* Admit a member */}
        {hasFamilyKey && (
          <div>
            <p className="fw-semibold small mb-2">{t('privacy.familyKey.admit')}</p>
            <Form.Group className="mb-2">
              <Form.Control
                size="sm"
                placeholder="Recipient npub1..."
                value={admitNpub}
                onChange={(e) => setAdmitNpub(e.target.value)}
                className="font-monospace mb-2"
              />
              <Form.Control
                size="sm"
                placeholder="Recipient Curve25519 pubkey (base64)"
                value={admitCurve}
                onChange={(e) => setAdmitCurve(e.target.value)}
              />
            </Form.Group>

            {admitStatus === 'done' && (
              <Alert variant="success" className="py-1 px-2 small">
                {t('privacy.familyKey.admitSuccess', { name: admitNpub.slice(0, 12) + '…' })}
              </Alert>
            )}
            {admitStatus === 'error' && (
              <Alert variant="danger" className="py-1 px-2 small">
                {t('privacy.familyKey.admitError')}: {admitError}
              </Alert>
            )}

            <Button
              size="sm"
              variant="primary"
              onClick={handleAdmit}
              disabled={!admitNpub || !admitCurve || admitStatus === 'busy'}
            >
              {admitStatus === 'busy'
                ? <><Spinner size="sm" className="me-1" />{t('privacy.familyKey.admitting')}</>
                : t('privacy.familyKey.admit')}
            </Button>
          </div>
        )}
      </Card.Body>
    </Card>
  )
}
