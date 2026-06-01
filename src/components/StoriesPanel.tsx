/**
 * StoriesPanel — Media Phase 1
 *
 * Shown from the family tree ActionPanel when a user clicks "Stories".
 * Lists all stories for a person and allows adding new ones.
 *
 * Stories are plain text events (kind 30096) published to the relay.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { store } from '../lib/storage'
import type { Person, PersonStory } from '../types/chronicle'

interface StoriesPanelProps {
  person: Person
  onBack: () => void
}

export default function StoriesPanel({ person, onBack }: StoriesPanelProps) {
  const { t } = useTranslation()
  const { getStoriesForPerson, syncVersion } = useApp()
  const [composing, setComposing] = useState(false)

  // syncVersion in dep array so list refreshes after addStory bumps it
  const stories = getStoriesForPerson(person.id)
  void syncVersion // consumed to trigger re-render

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
        <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--navy)', fontFamily: 'var(--font-display)', flex: 1 }}>
          {t('media.stories.title')}
        </span>
        {!composing && (
          <button
            onClick={() => setComposing(true)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gold)', fontWeight: 600, fontSize: 13, padding: '2px 4px' }}
          >
            + {t('media.stories.addStory')}
          </button>
        )}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
        {composing && (
          <StoryComposer
            person={person}
            onDone={() => setComposing(false)}
            onCancel={() => setComposing(false)}
          />
        )}

        {stories.length === 0 && !composing && (
          <div style={{ textAlign: 'center', color: 'var(--ink-muted)', fontSize: 13, marginTop: 24 }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>📖</div>
            {t('media.stories.noStories')}
          </div>
        )}

        {stories.map(story => (
          <StoryCard key={story.eventId} story={story} />
        ))}
      </div>
    </div>
  )
}

// ─── Story composer ───────────────────────────────────────────────────────────

function StoryComposer({ person, onDone, onCancel }: { person: Person; onDone: () => void; onCancel: () => void }) {
  const { t } = useTranslation()
  const { addStory } = useApp()
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    if (!title.trim() || !content.trim()) return
    setSaving(true)
    setError(null)
    try {
      await addStory(person.id, title.trim(), content.trim())
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save story')
      setSaving(false)
    }
  }

  return (
    <div style={{ background: 'var(--cream)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 14, marginBottom: 16 }}>
      <div style={{ marginBottom: 10 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-muted)', display: 'block', marginBottom: 4 }}>
          {t('media.stories.titleLabel')}
        </label>
        <input
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder={t('media.stories.titlePlaceholder')}
          style={{ width: '100%', boxSizing: 'border-box', padding: '6px 10px', border: '1px solid var(--border-soft)', borderRadius: 6, fontSize: 13, background: '#fff' }}
          autoFocus
        />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-muted)', display: 'block', marginBottom: 4 }}>
          {t('media.stories.contentLabel')}
        </label>
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          placeholder={t('media.stories.contentPlaceholder')}
          rows={5}
          style={{ width: '100%', boxSizing: 'border-box', padding: '6px 10px', border: '1px solid var(--border-soft)', borderRadius: 6, fontSize: 13, resize: 'vertical', background: '#fff', fontFamily: 'inherit' }}
        />
      </div>
      {error && (
        <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 8 }}>{error}</div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="btn btn-primary btn-sm"
          onClick={handleSave}
          disabled={saving || !title.trim() || !content.trim()}
          style={{ flex: 1 }}
        >
          {saving ? t('media.stories.saving') : t('media.stories.save')}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={onCancel}
          disabled={saving}
        >
          {t('media.stories.cancel')}
        </button>
      </div>
    </div>
  )
}

// ─── Story card ───────────────────────────────────────────────────────────────

function StoryCard({ story }: { story: PersonStory }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const author = store.getPerson(story.authorNpub)
  const authorName = author?.displayName ?? t('profile.card.claimantFallback', 'Family member')
  const date = new Date(story.createdAt * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

  const isLong = story.content.length > 200
  const displayContent = isLong && !expanded
    ? story.content.slice(0, 200) + '…'
    : story.content

  return (
    <div style={{ borderBottom: '1px solid var(--border-soft)', paddingBottom: 14, marginBottom: 14 }}>
      <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--navy)', marginBottom: 4, fontFamily: 'var(--font-display)' }}>
        {story.title}
      </div>
      <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 8 }}>
        {t('media.stories.by', { name: authorName })} · {date}
      </div>
      <div style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {displayContent}
      </div>
      {isLong && (
        <button
          onClick={() => setExpanded(e => !e)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gold)', fontSize: 12, fontWeight: 600, padding: '4px 0', marginTop: 4 }}
        >
          {expanded ? 'Show less' : 'Read more'}
        </button>
      )}
    </div>
  )
}
