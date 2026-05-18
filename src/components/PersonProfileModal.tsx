/**
 * PersonProfileModal
 *
 * A full-screen modal that shows a person's ProfileCard and lets the user
 * switch directly into edit mode — all without leaving the Family Tree tab.
 *
 * Used from the tree's ActionPanel for both "View full profile" and
 * "Edit information" actions.
 */

import { useState, useCallback } from 'react'
import { store } from '../lib/storage'
import { ProfileCard } from './ProfileCard'
import { AddPersonModal } from './AddPersonModal'
import { useApp } from '../context/AppContext'
import type { Person } from '../types/chronicle'

interface PersonProfileModalProps {
  pubkey: string
  /** If true, drop straight into edit mode instead of view mode */
  startInEditMode?: boolean
  onClose: () => void
  /** Called when a save was made so the tree can redraw */
  onSaved?: () => void
  /** Called when the person was deleted */
  onDeleted?: (pubkey: string) => void
}

export function PersonProfileModal({
  pubkey,
  startInEditMode = false,
  onClose,
  onSaved,
  onDeleted,
}: PersonProfileModalProps) {
  const { session, deletePerson } = useApp()
  const [editing, setEditing] = useState(startInEditMode)
  const [, forceUpdate] = useState(0)
  const refresh = useCallback(() => forceUpdate(n => n + 1), [])

  const person = store.getPerson(pubkey)
  if (!person) return null

  const claims = store.getClaimsForPerson(pubkey)
  const endorsements = claims.flatMap(c => store.getEndorsementsForClaim(c.eventId))

  const handleSaved = (saved: Person) => {
    refresh()
    setEditing(false)
    onSaved?.()
    // If the modal had started in edit mode (launched via "Edit information"),
    // close entirely after saving so the user returns to the tree.
    if (startInEditMode) onClose()
    else void saved // keep modal open in view mode
  }

  const handleDeleted = (pk: string) => {
    deletePerson(pk)
    onDeleted?.(pk)
    onClose()
  }

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      style={{ zIndex: 1100 }}
    >
      <div
        className="modal-panel"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: 520, width: '95%', maxHeight: '90vh', overflowY: 'auto' }}
      >
        {editing ? (
          // Edit mode — renders AddPersonModal inline inside the overlay
          <AddPersonModal
            mode="edit"
            editPerson={person}
            onSave={handleSaved}
            onDelete={handleDeleted}
            onCancel={() => {
              if (startInEditMode) onClose()
              else setEditing(false)
            }}
          />
        ) : (
          // View mode — full ProfileCard
          <>
            <div className="modal-header">
              <h2 className="modal-title">{person.displayName}</h2>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => setEditing(true)}
                >
                  Edit
                </button>
                <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
              </div>
            </div>
            <div className="modal-body" style={{ padding: 0 }}>
              <ProfileCard
                person={person}
                claims={claims}
                endorsements={endorsements}
                isOwn={pubkey === session?.npub}
                onAddInfo={() => setEditing(true)}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
