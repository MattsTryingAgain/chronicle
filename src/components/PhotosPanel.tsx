/**
 * PhotosPanel — Media Phase 1
 *
 * Shown from the family tree ActionPanel when a user clicks "Photos & media".
 * Displays the current avatar for a person and allows uploading a new one.
 *
 * Images are resized client-side (≤512px, ≤200KB) then stored as base64
 * in a kind 30095 event — no Blossom HTTP server required for phase 1.
 */

import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import type { Person } from '../types/chronicle'

interface PhotosPanelProps {
  person: Person
  onBack: () => void
}

export default function PhotosPanel({ person, onBack }: PhotosPanelProps) {
  const { t } = useTranslation()
  const { setAvatar, getAvatar } = useApp()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const avatar = getAvatar(person.id)

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setUploading(true)
    try {
      await setAvatar(person.id, file)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('media.photos.uploadError'))
    } finally {
      setUploading(false)
      // Reset so the same file can be re-selected after an error
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--border-soft)' }}>
        <button
          onClick={onBack}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-muted)', padding: '2px 4px', fontSize: 18, lineHeight: 1 }}
          aria-label="Back"
        >
          ←
        </button>
        <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--navy)', fontFamily: 'var(--font-display)' }}>
          {t('media.photos.title')}
        </span>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>
        {/* Avatar display */}
        <div style={{ position: 'relative' }}>
          <AvatarDisplay
            dataUrl={avatar?.dataUrl ?? null}
            name={person.displayName}
            size={120}
          />
        </div>

        {/* Upload hint */}
        <p style={{ fontSize: 12, color: 'var(--ink-muted)', textAlign: 'center', margin: 0, maxWidth: 220 }}>
          {t('media.photos.uploadHint')}
        </p>

        {/* Error */}
        {error && (
          <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '10px 12px', fontSize: 13, color: '#dc2626', width: '100%', boxSizing: 'border-box' }}>
            {error}
          </div>
        )}

        {/* Upload button */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
        <button
          className="btn btn-primary"
          style={{ width: '100%' }}
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading
            ? t('media.photos.uploading')
            : avatar
              ? t('media.photos.changePhoto')
              : t('media.photos.addPhoto')}
        </button>
      </div>
    </div>
  )
}

// ─── Avatar display component — reused across tree, list, profile ─────────────

interface AvatarDisplayProps {
  dataUrl: string | null
  name: string
  size: number
  /** If true, shows a gold ring (used on tree nodes to indicate photo exists) */
  ringOnly?: boolean
}

export function AvatarDisplay({ dataUrl, name, size, ringOnly }: AvatarDisplayProps) {
  const initials = name.split(' ').map(w => w[0]).filter(Boolean).join('').slice(0, 2).toUpperCase()

  if (ringOnly) {
    // Compact indicator for tree nodes — coloured ring around the initials circle
    return (
      <div style={{
        width: size, height: size, borderRadius: '50%',
        border: dataUrl ? '2px solid var(--gold)' : '2px solid transparent',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{
          width: size - 4, height: size - 4, borderRadius: '50%',
          background: 'var(--navy)', color: 'var(--gold)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--font-display)', fontSize: size * 0.3, fontWeight: 700,
        }}>
          {initials}
        </div>
      </div>
    )
  }

  if (dataUrl) {
    return (
      <img
        src={dataUrl}
        alt={name}
        style={{
          width: size, height: size, borderRadius: '50%',
          objectFit: 'cover',
          border: '2px solid var(--gold)',
          display: 'block',
        }}
      />
    )
  }

  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: 'var(--navy)', color: 'var(--gold)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--font-display)', fontSize: size * 0.32, fontWeight: 700,
      border: '2px solid transparent',
      flexShrink: 0,
    }}>
      {initials}
    </div>
  )
}
