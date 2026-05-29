/**
 * TreeView — the main screen after onboarding.
 * Shows person list with search, opens ProfileCard on selection,
 * lets user add ancestors.
 */

import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { store } from '../lib/storage'
import { getAllSamePersonLinks, addSamePersonLink, areAliases } from '../lib/graph'
import { ProfileCard } from './ProfileCard'
import { AddPersonModal } from './AddPersonModal'
import { useApp } from '../context/AppContext'
import { buildSamePersonLink } from '../lib/eventBuilder'
import type { Person } from '../types/chronicle'

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="search-bar-icon">
      <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
      <line x1="10" y1="10" x2="14" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

function PersonAvatar({ name }: { name: string }) {
  const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
  return <div className="person-avatar">{initials}</div>
}

function PersonListItem({ person, onClick }: { person: Person; onClick: () => void }) {
  const claims = store.getClaimsForPerson(person.id)
  const bornClaim   = claims.filter(c => c.field === 'born'       && !c.retracted).sort((a,b) => b.confidenceScore - a.confidenceScore)[0]
  const diedClaim   = claims.filter(c => c.field === 'died'       && !c.retracted).sort((a,b) => b.confidenceScore - a.confidenceScore)[0]
  const placeClaim  = claims.filter(c => c.field === 'birthplace' && !c.retracted).sort((a,b) => b.confidenceScore - a.confidenceScore)[0]

  let dates = ''
  if (bornClaim?.value) dates += `b. ${bornClaim.value}`
  if (diedClaim?.value) dates += dates ? ` – d. ${diedClaim.value}` : `d. ${diedClaim.value}`

  return (
    <button className="person-list-item animate-in" onClick={onClick}>
      <PersonAvatar name={person.displayName} />
      <div style={{ flex: 1, textAlign: 'left' }}>
        <div className="person-name">{person.displayName}</div>
        {(dates || placeClaim?.value) && (
          <div className="person-dates">
            {dates}{dates && placeClaim?.value ? ' · ' : ''}{placeClaim?.value}
          </div>
        )}
      </div>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ color: 'var(--ink-muted)', flexShrink: 0 }}>
        <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </button>
  )
}

export function TreeView({ onSelectPerson }: { onSelectPerson?: (pubkey: string) => void } = {}) {
  const { t } = useTranslation()
  const { session, deletePerson, syncVersion, publishEvent } = useApp()
  const [query, setQuery] = useState('')
  const [selectedPubkey, setSelectedPubkey] = useState<string | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [editingPubkey, setEditingPubkey] = useState<string | null>(null)
  const [, forceUpdate] = useState(0)
  const [linkPickerFor, setLinkPickerFor] = useState<string | null>(null)

  // Re-render whenever remote sync delivers new data
  useEffect(() => { forceUpdate(n => n + 1) }, [syncVersion])

  const refresh = useCallback(() => forceUpdate(n => n + 1), [])

  // Filter out persons that are the non-canonical entry in a same_person_link.
  // resolveAliasIds follows the link chain and returns the canonical end;
  // any person whose pubkey != canonical(pubkey) is a secondary duplicate.
  // This is deterministic regardless of which instance created which record.
  const allLinks = getAllSamePersonLinks()
  const hiddenByLink = new Set<string>()
  if (allLinks.length > 0) {
    const allPersons = store.getAllPersons()
    for (const p of allPersons) {
      // Hide if any other person has this ID as an alias (i.e. this is the secondary record)
      for (const other of allPersons) {
        if (other.id === p.id) continue
        if (areAliases(other.id, p.id) && other.id < p.id) {
          // other is "primary" (lexicographically smaller ID) — hide p
          hiddenByLink.add(p.id)
          break
        }
      }
    }
  }

  const persons = store.searchPersons(query).filter(p => !hiddenByLink.has(p.id))
  const selectedPerson = selectedPubkey ? store.getPerson(selectedPubkey) : null
  const selectedClaims = selectedPubkey ? store.getClaimsForPerson(selectedPubkey) : []
  const selectedEndorsements = selectedClaims.flatMap(c =>
    store.getEndorsementsForClaim(c.eventId)
  )

  const handlePersonDeleted = useCallback((pubkey: string) => {
    deletePerson(pubkey)
    setEditingPubkey(null)
    setSelectedPubkey(null)
    refresh()
  }, [deletePerson, refresh])

  const handlePersonSaved = useCallback((person: Person) => {
    setShowAddModal(false)
    setEditingPubkey(null)
    setSelectedPubkey(person.id)
    refresh()
  }, [refresh])

  return (
    <div>
      {/* Selected person — profile card */}
      {selectedPerson ? (
        <div style={{ marginBottom: 'var(--space-xl)' }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setSelectedPubkey(null)}
            style={{ marginBottom: 'var(--space-md)' }}
          >
            ← {t('nav.tree')}
          </button>
          <ProfileCard
            person={selectedPerson}
            claims={selectedClaims}
            endorsements={selectedEndorsements}
            isOwn={selectedPubkey === session?.npub}
            onAddInfo={() => setEditingPubkey(selectedPubkey)}
          />
          {onSelectPerson && (
            <div className="mt-3">
              <button
                className="btn btn-outline-secondary btn-sm"
                onClick={() => onSelectPerson(selectedPubkey!)}
              >
                {t('tree.viewInGraph', { defaultValue: 'View in Family Tree' })}
              </button>
            </div>
          )}

          {/* Manual same-person linking */}
          <div className="mt-3">
            {linkPickerFor === selectedPubkey ? (
              <div>
                <p style={{ fontSize: 13, color: 'var(--ink-muted)', marginBottom: 8 }}>
                  Select the duplicate entry to merge with <strong>{selectedPerson?.displayName}</strong>:
                </p>
                <div className="person-list" style={{ maxHeight: 240, overflowY: 'auto' }}>
                  {store.getAllPersons()
                    .filter(p => p.id !== selectedPubkey && !areAliases(p.id, selectedPubkey ?? ''))
                    .map(p => (
                      <div
                        key={p.id}
                        className="person-list-item"
                        style={{ cursor: 'pointer', padding: '8px 12px' }}
                        onClick={() => {
                          if (!session) return
                          const event = buildSamePersonLink(
                            session.npub, session.nsec,
                            selectedPubkey!, p.id,
                          )
                          publishEvent(event)
                          addSamePersonLink({
                            eventId: event.id,
                            idA: selectedPubkey!,
                            idB: p.id,
                            claimantPubkey: session.npub,
                            createdAt: event.created_at,
                            retracted: false,
                          })
                          setLinkPickerFor(null)
                          setSelectedPubkey(null)
                          refresh()
                        }}
                      >
                        <strong>{p.displayName}</strong>
                        <span style={{ fontSize: 12, color: 'var(--ink-muted)', marginLeft: 8 }}>
                          {store.getClaimsForPerson(p.id).find(c => c.field === 'born')?.value ?? ''}
                        </span>
                      </div>
                    ))
                  }
                </div>
                <button
                  className="btn btn-ghost btn-sm mt-2"
                  onClick={() => setLinkPickerFor(null)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                className="btn btn-ghost btn-sm"
                style={{ color: 'var(--ink-muted)', fontSize: 12 }}
                onClick={() => setLinkPickerFor(selectedPubkey)}
              >
                This is the same person as someone else in the list…
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="page-header">
            <h1 className="page-title">{t('nav.tree')}</h1>
            <button
              className="btn btn-primary"
              onClick={() => setShowAddModal(true)}
            >
              + Add family member
            </button>
          </div>

          <div className="search-bar" style={{ marginBottom: 'var(--space-lg)' }}>
            <SearchIcon />
            <input
              type="search"
              placeholder={t('search.placeholder')}
              value={query}
              onChange={e => setQuery(e.target.value)}
              aria-label={t('search.placeholder')}
            />
          </div>

          {persons.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">👨‍👩‍👧‍👦</div>
              <p>
                {query
                  ? t('search.noResults')
                  : 'Your family tree is empty. Add yourself or a family member to get started.'}
              </p>
              <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
                Add a person
              </button>
            </div>
          ) : (
            <div>
              {query && (
                <p style={{ fontSize: 13, color: 'var(--ink-muted)', marginBottom: 'var(--space-md)' }}>
                  {t('search.resultsCount_other', { count: persons.length })}
                </p>
              )}
              <div className="person-list">
                {persons.map(p => (
                  <PersonListItem
                    key={p.id}
                    person={p}
                    onClick={() => setSelectedPubkey(p.id)}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {showAddModal && (
        <AddPersonModal
          mode="ancestor"
          selfPubkey={session?.npub}
          onSave={handlePersonSaved}
          onCancel={() => setShowAddModal(false)}
        />
      )}

      {editingPubkey && (() => {
        const ep = store.getPerson(editingPubkey)
        return ep ? (
          <AddPersonModal
            mode="edit"
            editPerson={ep}
            onSave={handlePersonSaved}
            onDelete={handlePersonDeleted}
            onCancel={() => setEditingPubkey(null)}
          />
        ) : null
      })()}
    </div>
  )
}
