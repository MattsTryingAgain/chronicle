/**
 * FamilyTreeView — powered by family-chart (donatso/family-chart)
 *
 * family-chart handles all layout logic: couples as units, correct
 * parent→child positioning, multi-parent support, zoom/pan.
 *
 * This component is responsible only for:
 *  1. Converting Chronicle graph data → family-chart Datum format
 *  2. Rendering the chart in a container div
 *  3. Providing the action panel on node click
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import * as f3 from 'family-chart'
import 'family-chart/styles/family-chart.css'
import { store } from '../lib/storage'
import { traverseGraph } from '../lib/graph'
import { resolveAllFields } from '../lib/confidence'
import type { Person } from '../types/chronicle'

// ─── Types ────────────────────────────────────────────────────────────────────

interface FamilyTreeViewProps {
  rootPubkey: string
  onSelectPerson?: (pubkey: string) => void
  onEditPerson?: (pubkey: string) => void
}

// ─── Data conversion ──────────────────────────────────────────────────────────

function buildF3Data(rootPubkey: string) {
  const { nodes, edges } = traverseGraph(rootPubkey, { maxDepth: 6, maxNodes: 150 })

  // Build relationship maps from edges
  const spouses   = new Map<string, Set<string>>()
  const children  = new Map<string, Set<string>>()
  const parents   = new Map<string, Set<string>>()

  for (const n of nodes) {
    spouses.set(n, new Set())
    children.set(n, new Set())
    parents.set(n, new Set())
  }

  for (const edge of edges) {
    if (edge.relationship === 'spouse') {
      spouses.get(edge.fromPubkey)?.add(edge.toPubkey)
      spouses.get(edge.toPubkey)?.add(edge.fromPubkey)
    } else if (edge.relationship === 'parent') {
      // fromPubkey is parent of toPubkey
      children.get(edge.fromPubkey)?.add(edge.toPubkey)
      parents.get(edge.toPubkey)?.add(edge.fromPubkey)
    } else if (edge.relationship === 'child') {
      // fromPubkey is child of toPubkey
      children.get(edge.toPubkey)?.add(edge.fromPubkey)
      parents.get(edge.fromPubkey)?.add(edge.toPubkey)
    }
    // siblings not represented directly — they share parents
  }

  // Build Datum array
  const data: f3.Datum[] = nodes.map(pk => {
    const person: Person | undefined = store.getPerson(pk)
    const claims = store.getClaimsForPerson(pk)
    const endorsements = store.getAllEndorsements()
    const resolutions = resolveAllFields(claims, endorsements)

    const born = resolutions.find(r => r.field === 'born')?.winningClaim?.value ?? ''
    const died = resolutions.find(r => r.field === 'died')?.winningClaim?.value ?? ''
    const birthplace = resolutions.find(r => r.field === 'birthplace')?.winningClaim?.value ?? ''

    return {
      id: pk,
      data: {
        'first name': person?.displayName ?? '',
        'birthday': born,
        'death': died,
        'birthplace': birthplace,
        // family-chart uses gender for layout in some card types; default M
        gender: 'M' as const,
        // pass living flag for our styling
        isLiving: person?.isLiving ?? false,
        isRoot: pk === rootPubkey,
      },
      rels: {
        spouses: Array.from(spouses.get(pk) ?? []),
        children: Array.from(children.get(pk) ?? []),
        parents: Array.from(parents.get(pk) ?? []),
      },
    }
  })

  return data
}

// ─── Action Panel ─────────────────────────────────────────────────────────────

interface ActionPanelProps {
  pubkey: string
  onClose: () => void
  onEdit: (pubkey: string) => void
  onViewInList: (pubkey: string) => void
}

function ActionPanel({ pubkey, onClose, onEdit, onViewInList }: ActionPanelProps) {
  const person = store.getPerson(pubkey)
  if (!person) return null

  const initials = person.displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
  const claims = store.getClaimsForPerson(pubkey)
  const endorsements = store.getAllEndorsements()
  const resolutions = resolveAllFields(claims, endorsements)
  const born = resolutions.find(r => r.field === 'born')?.winningClaim?.value
  const died = resolutions.find(r => r.field === 'died')?.winningClaim?.value
  const place = resolutions.find(r => r.field === 'birthplace')?.winningClaim?.value

  return (
    <div style={{
      position: 'absolute', top: 0, right: 0,
      width: 280, height: '100%',
      background: '#fff',
      borderLeft: '1px solid var(--border-soft)',
      boxShadow: '-4px 0 24px rgba(15,30,53,0.08)',
      display: 'flex', flexDirection: 'column',
      zIndex: 10,
    }}>
      <div style={{
        padding: '20px 20px 16px',
        borderBottom: '1px solid var(--border-soft)',
        background: 'var(--cream)',
        position: 'relative',
      }}>
        <button onClick={onClose} style={{
          position: 'absolute', top: 12, right: 12,
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--ink-muted)', fontSize: 18, lineHeight: 1, padding: 4,
        }}>✕</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{
            width: 48, height: 48, borderRadius: '50%',
            background: 'var(--navy)', color: 'var(--gold)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700,
            flexShrink: 0,
          }}>{initials}</div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 16, color: 'var(--navy)', fontFamily: 'var(--font-display)' }}>
              {person.displayName}
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 2 }}>
              {person.isLiving ? 'Living' : 'Ancestor'}
              {born && ` · b. ${born}`}
              {died && ` · d. ${died}`}
            </div>
            {place && <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{place}</div>}
          </div>
        </div>
      </div>

      <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1, overflowY: 'auto' }}>
        <ActionButton icon="✏️" label="Edit information" description="Update facts, dates and relationships" onClick={() => onEdit(pubkey)} />
        <ActionButton icon="📋" label="View full profile" description="See all claims and conflict history" onClick={() => onViewInList(pubkey)} />
        <div style={{ borderTop: '1px solid var(--border-soft)', margin: '4px 0' }} />
        <ActionButton icon="🖼" label="Photos & media" description="View and add photos for this person" onClick={() => {}} comingSoon />
        <ActionButton icon="📖" label="Stories" description="Personal stories and memories" onClick={() => {}} comingSoon />
        <ActionButton icon="📄" label="Documents" description="Birth certificates, records and sources" onClick={() => {}} comingSoon />
        <ActionButton icon="🌍" label="Timeline" description="Life events on a timeline" onClick={() => {}} comingSoon />
      </div>

      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-soft)' }}>
        <button className="btn btn-outline btn-sm" style={{ width: '100%', justifyContent: 'center' }}
          onClick={() => { onViewInList(pubkey); onClose() }}>
          Make this person the tree root
        </button>
      </div>
    </div>
  )
}

interface ActionButtonProps {
  icon: string; label: string; description: string
  onClick: () => void; comingSoon?: boolean
}

function ActionButton({ icon, label, description, onClick, comingSoon }: ActionButtonProps) {
  return (
    <button onClick={comingSoon ? undefined : onClick} style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 12px',
      background: comingSoon ? 'transparent' : 'var(--cream)',
      border: '1px solid var(--border-soft)',
      borderRadius: 8, cursor: comingSoon ? 'default' : 'pointer',
      textAlign: 'left', width: '100%',
      opacity: comingSoon ? 0.5 : 1,
    }}
      onMouseEnter={e => { if (!comingSoon) (e.currentTarget as HTMLElement).style.background = 'var(--cream-mid)' }}
      onMouseLeave={e => { if (!comingSoon) (e.currentTarget as HTMLElement).style.background = 'var(--cream)' }}
    >
      <span style={{ fontSize: 20, width: 28, textAlign: 'center', flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--navy)' }}>
          {label}
          {comingSoon && <span style={{ fontSize: 10, color: 'var(--ink-muted)', marginLeft: 6, fontWeight: 400 }}>coming soon</span>}
        </div>
        <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 1 }}>{description}</div>
      </div>
      {!comingSoon && <span style={{ color: 'var(--ink-muted)', fontSize: 12 }}>›</span>}
    </button>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function FamilyTreeView({ rootPubkey, onSelectPerson, onEditPerson }: FamilyTreeViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<ReturnType<typeof f3.createChart> | null>(null)
  const [selectedPubkey, setSelectedPubkey] = useState<string | null>(null)
  const [nodeCount, setNodeCount] = useState(0)

  const handleClosePanel = useCallback(() => setSelectedPubkey(null), [])

  useEffect(() => {
    if (!containerRef.current) return

    // Clear any previous chart
    containerRef.current.innerHTML = '<div id="FamilyChart" style="width:100%;height:100%"></div>'

    const data = buildF3Data(rootPubkey)
    setNodeCount(data.length)

    if (data.length === 0) return

    try {
      const chart = f3.createChart('#FamilyChart', data)

      // setCardHtml returns the card instance — wire click handler on it
      chart.setCardHtml()
        .setCardDisplay([
          ['first name'],
          ['birthday', 'death'],
        ])
        .setCardDim({ w: 180, h: 60, text_x: 10, text_y: 14, img_w: 0, img_h: 0, img_x: 0, img_y: 0 })
        .setMiniTree(true)
        .setOnCardClick((_e: MouseEvent, d: f3.TreeDatum) => {
          const pk = d.data.id
          setSelectedPubkey((prev: string | null) => prev === pk ? null : pk)
        })

      chart.updateTree({ initial: true })

      chartRef.current = chart
    } catch (err) {
      console.error('family-chart error:', err)
    }

    return () => {
      if (containerRef.current) containerRef.current.innerHTML = ''
      chartRef.current = null
    }
  }, [rootPubkey])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16,
        padding: '8px 16px',
        borderBottom: '1px solid var(--border-soft)',
        background: '#fff', fontSize: 13, color: 'var(--ink-muted)',
        flexShrink: 0,
      }}>
        <span>{nodeCount} {nodeCount === 1 ? 'person' : 'people'}</span>
        <span style={{ color: 'var(--border)', marginLeft: 'auto', fontSize: 11 }}>
          Scroll to zoom · Drag to pan · Click to select
        </span>
      </div>

      {/* Chart + panel */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: 'var(--cream)' }}>
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

        {selectedPubkey && (
          <ActionPanel
            pubkey={selectedPubkey}
            onClose={handleClosePanel}
            onEdit={(pk) => { onEditPerson?.(pk); handleClosePanel() }}
            onViewInList={(pk) => { onSelectPerson?.(pk) }}
          />
        )}
      </div>
    </div>
  )
}
