/**
 * FamilyTreeView — generational family tree.
 *
 * GUARANTEES (what this view must always do):
 *   1. Children sit BELOW their parents. Always. Y position is determined by
 *      generation, which is computed strictly from parent/child relationships.
 *   2. Every parent→child relationship has a visible connector line.
 *   3. Spouses sit at the same level, connected by a horizontal line.
 *   4. Multiple children of the same parent all sit at the same generation
 *      below that parent, each with their own connector.
 *
 * ALGORITHM:
 *   1. Normalise edges: convert every parent/child claim into a single
 *      directed (parent → child) edge. Dedupe by pair. Spouses become a
 *      single undirected spouse edge per pair. Siblings are ignored for
 *      layout (sibling relationship is implicit when two nodes share a
 *      parent; we still draw a sibling line if no shared parent exists).
 *   2. Generations: BFS from root. From the root, every ancestor path
 *      (root has a parent X) puts X at gen-1. Every descendant path puts
 *      that node at gen+1. Spouses share the same generation.
 *   3. Layout per generation: pack couples adjacent, then order rows by
 *      the average X of any already-placed children.
 *   4. Render: parent→child connectors are elbow paths from the bottom of
 *      the parent card to the top of the child card. Spouse connectors are
 *      short horizontal lines. Sibling-only edges (no shared parent) are
 *      dashed horizontal lines.
 *
 * NOTE: `traverseGraph` returns BOTH directions of every stored
 * relationship (forward + inverse). This view treats each unordered pair
 * exactly once.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import * as d3 from 'd3'
import { store } from '../lib/storage'
import { traverseGraph } from '../lib/graph'
import { resolveAllFields } from '../lib/confidence'
import { useApp } from '../context/AppContext'
import type { Person } from '../types/chronicle'
import { PersonProfileModal } from './PersonProfileModal'
import PhotosPanel, { AvatarDisplay } from './PhotosPanel'
import StoriesPanel from './StoriesPanel'
import {
  NODE_W, NODE_H,
  normaliseEdges,
  assignGenerations,
  computeLayout,
} from './FamilyTreeView.layout'

// ─── Types ────────────────────────────────────────────────────────────────────

interface NodeData {
  id: string  // person ID (UUID for ancestors, npub for living user)
  displayName: string
  birthYear: string | null
  deathYear: string | null
  hasConflict: boolean
  hasAvatar: boolean
  isLiving: boolean
  x: number
  y: number
}

interface FamilyTreeViewProps {
  rootPubkey: string
  onSelectPerson?: (personId: string) => void
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractYear(val: string | null): string | null {
  if (!val) return null
  const m = val.match(/\b(\d{4})\b/)
  return m ? m[1] : null
}

function buildNodeData(personId: string, getAvatarFn: (id: string) => { dataUrl: string } | undefined): NodeData {
  // Resolve alias: if personId is a remote UUID, map to local person record
  const localId = store.resolvePersonId(personId) ?? personId
  const person: Person | undefined = store.getPerson(localId)
  const claims = store.getClaimsForPerson(localId)
  const endorsements = store.getAllEndorsements()
  const resolutions = resolveAllFields(claims, endorsements)
  const hasConflict = resolutions.some(r => r.conflictState === 'hard' || r.conflictState === 'soft')
  const born = resolutions.find(r => r.field === 'born')?.winningClaim?.value ?? null
  const died = resolutions.find(r => r.field === 'died')?.winningClaim?.value ?? null
  const hasAvatar = !!getAvatarFn(localId)?.dataUrl
  return {
    id: personId,
    displayName: person?.displayName ?? 'Unknown',
    birthYear: extractYear(born),
    deathYear: extractYear(died),
    hasConflict,
    isLiving: person?.isLiving ?? false,
    hasAvatar,
    x: 0,
    y: 0,
  }
}


// ─── Action Panel ─────────────────────────────────────────────────────────────

interface ActionPanelProps {
  personId: string
  rootPubkey: string
  onClose: () => void
  onMakeRoot: (personId: string) => void
  onTreeRefresh: () => void
  onPersonDeleted: (personId: string) => void
}

type ActionPanelView = 'main' | 'photos' | 'stories'

function ActionPanel({ personId, rootPubkey, onClose, onMakeRoot, onTreeRefresh, onPersonDeleted }: ActionPanelProps) {
  const { contacts, getAvatar, syncVersion, session } = useApp()
  const [profileModal, setProfileModal] = useState<'view' | 'edit' | null>(null)
  const [subPanel, setSubPanel] = useState<ActionPanelView>('main')
  void syncVersion // causes re-render when avatar/story is added

  const person = store.getPerson(personId)
  if (!person) return null

  // A person is a "connected contact" if their person ID (or any of its aliases)
  // matches a known contact's npub. The alias check is needed when the node was
  // created locally with a UUID before the contact's identity anchor arrived.
  const personAliasIds = (() => {
    const ids = new Set<string>([personId])
    const canonical = store.resolvePersonId(personId)
    if (canonical && canonical !== personId) ids.add(canonical)
    for (const alias of store.getAliasesFor(canonical ?? personId)) ids.add(alias.remoteId)
    return ids
  })()
  const isContact = contacts.some(c => personAliasIds.has(c.npub))
  const isRoot = personId === rootPubkey

  const claims = store.getClaimsForPerson(personId)
  const endorsements = store.getAllEndorsements()
  const resolutions = resolveAllFields(claims, endorsements)
  const born  = resolutions.find(r => r.field === 'born')?.winningClaim?.value
  const died  = resolutions.find(r => r.field === 'died')?.winningClaim?.value
  const place = resolutions.find(r => r.field === 'birthplace')?.winningClaim?.value

  const avatar = getAvatar(person.id)

  return (
    <>
      <div style={{
        position: 'absolute', top: 0, right: 0,
        width: 280, height: '100%', background: '#fff',
        borderLeft: '1px solid var(--border-soft)',
        boxShadow: '-4px 0 24px rgba(15,30,53,0.08)',
        display: 'flex', flexDirection: 'column', zIndex: 10,
        overflow: 'hidden',
      }}>
        {/* Sub-panel routing */}
        {subPanel === 'photos' && (
          <PhotosPanel person={person} onBack={() => setSubPanel('main')} />
        )}
        {subPanel === 'stories' && (
          <StoriesPanel person={person} onBack={() => setSubPanel('main')} />
        )}
        {subPanel === 'main' && (<>
        <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--border-soft)', background: 'var(--cream)', position: 'relative' }}>
          <button onClick={onClose} style={{ position: 'absolute', top: 12, right: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-muted)', fontSize: 18, lineHeight: 1, padding: 4 }}>✕</button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <AvatarDisplay dataUrl={avatar?.dataUrl ?? null} name={person.displayName} size={48} />
            <div>
              <div style={{ fontWeight: 600, fontSize: 16, color: 'var(--navy)', fontFamily: 'var(--font-display)' }}>{person.displayName}</div>
              <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 2 }}>
                {person.isLiving ? 'Living' : 'Ancestor'}{born && ` · b. ${born}`}{died && ` · d. ${died}`}
              </div>
              {place && <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{place}</div>}
              {isContact && (
                <div style={{ fontSize: 11, color: 'var(--gold)', fontWeight: 500, marginTop: 3 }}>
                  ● Connected family member
                </div>
              )}
              {isContact && (
                <div style={{ fontSize: 10, color: 'var(--ink-muted)', marginTop: 4, fontFamily: 'monospace', wordBreak: 'break-all', cursor: 'pointer', userSelect: 'all' }}
                  title="Click to select and copy">
                  {personId}
                </div>
              )}
            </div>
          </div>
        </div>
        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1, overflowY: 'auto' }}>
          <ActionButton icon="✏️" label="Edit information"  description="Update facts, dates and relationships" onClick={() => setProfileModal('edit')} />
          <ActionButton icon="📋" label="View full profile" description="See all details and history"            onClick={() => setProfileModal('view')} />
          <div style={{ borderTop: '1px solid var(--border-soft)', margin: '4px 0' }} />
          <ActionButton icon="🖼"  label="Photos & media"    description="View and add photos for this person"   onClick={() => setSubPanel('photos')} />
          <ActionButton icon="📖" label="Stories"            description="Personal stories and memories"         onClick={() => setSubPanel('stories')} />
          <ActionButton icon="📄" label="Documents"          description="Birth certificates, records and sources" onClick={() => {}} comingSoon />
          <ActionButton icon="🌍" label="Timeline"           description="Life events on a timeline"             onClick={() => {}} comingSoon />
        </div>
        {/* Show perspective switch for connected contacts and for the session user's
            own node (so clicking yourself while on someone else's tree brings you home). */}
        {(isContact || personId === session?.npub) && !isRoot && (
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-soft)' }}>
            <button className="btn btn-outline btn-sm" style={{ width: '100%', justifyContent: 'center' }}
              onClick={() => {
                const contactNpub = contacts.find(c => personAliasIds.has(c.npub))?.npub ?? personId
                onMakeRoot(contactNpub)
                onClose()
              }}>
              View tree from {person.displayName}'s perspective
            </button>
          </div>
        )}
        {rootPubkey !== session?.npub && (
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-soft)' }}>
            <button className="btn btn-ghost btn-sm" style={{ width: '100%', justifyContent: 'center' }}
              onClick={() => { onMakeRoot(session!.npub); onClose() }}>
              ↩ Return to my tree
            </button>
          </div>
        )}
        </>)}
      </div>

      {profileModal && (
        <PersonProfileModal
          pubkey={personId}
          startInEditMode={profileModal === 'edit'}
          onClose={() => setProfileModal(null)}
          onSaved={() => { onTreeRefresh(); setProfileModal(null) }}
          onDeleted={(pk) => { onPersonDeleted(pk); onClose() }}
        />
      )}
    </>
  )
}

function ActionButton({ icon, label, description, onClick, comingSoon }: {
  icon: string; label: string; description: string; onClick: () => void; comingSoon?: boolean
}) {
  return (
    <button onClick={comingSoon ? undefined : onClick} style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
      background: comingSoon ? 'transparent' : 'var(--cream)',
      border: '1px solid var(--border-soft)', borderRadius: 8,
      cursor: comingSoon ? 'default' : 'pointer', textAlign: 'left', width: '100%',
      opacity: comingSoon ? 0.5 : 1,
    }}
      onMouseEnter={e => { if (!comingSoon) (e.currentTarget as HTMLElement).style.background = 'var(--cream-mid)' }}
      onMouseLeave={e => { if (!comingSoon) (e.currentTarget as HTMLElement).style.background = 'var(--cream)' }}
    >
      <span style={{ fontSize: 20, width: 28, textAlign: 'center', flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--navy)' }}>
          {label}{comingSoon && <span style={{ fontSize: 10, color: 'var(--ink-muted)', marginLeft: 6, fontWeight: 400 }}>coming soon</span>}
        </div>
        <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 1 }}>{description}</div>
      </div>
      {!comingSoon && <span style={{ color: 'var(--ink-muted)', fontSize: 12 }}>›</span>}
    </button>
  )
}

// ─── Legend ───────────────────────────────────────────────────────────────────

function LegendItem({ color, dash, label }: { color: string; dash?: string; label: string }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <svg width="24" height="8">
        <line x1="0" y1="4" x2="24" y2="4" stroke={color} strokeWidth="1.5" strokeDasharray={dash} />
      </svg>
      {label}
    </span>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function FamilyTreeView({ rootPubkey, onSelectPerson }: FamilyTreeViewProps) {
  const svgRef       = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [nodeCount, setNodeCount]       = useState(0)
  const [truncated, setTruncated]       = useState(false)
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null)
  const [treeVersion, setTreeVersion] = useState(0)
  const { syncVersion, getAvatar } = useApp()

  const handleClosePanel  = useCallback(() => setSelectedPersonId(null), [])
  const handleMakeRoot    = useCallback((pk: string) => onSelectPerson?.(pk), [onSelectPerson])
  const handleTreeRefresh = useCallback(() => setTreeVersion(v => v + 1), [])
  const handlePersonDeleted = useCallback((pk: string) => {
    if (pk === selectedPersonId) setSelectedPersonId(null)
    setTreeVersion(v => v + 1)
  }, [selectedPersonId])

  const draw = useCallback(() => {
    if (!svgRef.current || !containerRef.current) return
    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const { nodes, edges, truncated: trunc } = traverseGraph(rootPubkey, { maxDepth: 6, maxNodes: 150 })
    setTruncated(trunc)
    setNodeCount(nodes.length)
    if (nodes.length === 0) return

    const width  = containerRef.current.clientWidth
    const height = containerRef.current.clientHeight
    svg.attr('width', width).attr('height', height)

    const g = svg.append('g')
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 3])
      .on('zoom', event => g.attr('transform', event.transform))
    svg.call(zoom)

    // ── Edge normalisation & layout ────────────────────────────────────────────
    const { parentChild, spouses, siblings } = normaliseEdges(edges)
    const genMap = assignGenerations(rootPubkey, nodes, parentChild, spouses)
    const posMap = computeLayout(nodes, genMap, parentChild, spouses, rootPubkey)

    const nodeMap = new Map<string, NodeData>()
    for (const pk of nodes) {
      const nd = buildNodeData(pk, getAvatar)
      const p = posMap.get(pk) ?? { x: 0, y: 0 }
      nd.x = p.x; nd.y = p.y
      nodeMap.set(pk, nd)
    }

    // ── Defs ───────────────────────────────────────────────────────────────────
    const defs = svg.append('defs')
    defs.append('filter').attr('id', 'node-shadow')
      .append('feDropShadow')
      .attr('dx', 0).attr('dy', 1).attr('stdDeviation', 3)
      .attr('flood-color', 'rgba(15,30,53,0.12)')

    // ── Edges ──────────────────────────────────────────────────────────────────
    const edgeGroup = g.append('g').attr('class', 'edges')
    const STROKE = '#c9a96e'
    const STROKE_SENSITIVE = '#c5b89a'

    // Parent→child connectors are drawn per SIBLING CLUSTER, not per edge.
    //
    // A sibling cluster is the set of children sharing the same parent-set.
    // For each cluster we draw one logical shape:
    //   1. From each parent: a vertical drop to a meeting point (cluster
    //      midpoint x, just below the parents' row).
    //   2. A short vertical from that meeting point to the cluster's
    //      horizontal "beam" Y, which sits just above the children's row.
    //   3. The beam spans only the leftmost-to-rightmost child in this
    //      cluster — NOT across the whole row.
    //   4. From the beam, a short vertical drop to each child.
    //
    // This means adjacent unrelated sibling clusters have visible gaps
    // between their beams (because each beam stays tight under its own
    // children). Previously every edge drew its own elbow at one shared
    // armY, so multiple clusters' beams fused into a single continuous
    // bar across the row.

    interface ClusterKey { key: string; parents: string[]; children: string[] }

    const clusterMap = new Map<string, ClusterKey>()
    for (const e of parentChild) {
      const cNode = nodeMap.get(e.child)
      if (!cNode) continue
      // Group children by their set of parents (sorted, joined).
      const childParentList: string[] = []
      for (const e2 of parentChild) if (e2.child === e.child) childParentList.push(e2.parent)
      childParentList.sort()
      const key = childParentList.join('|') + '→' + cNode.y
      let cl = clusterMap.get(key)
      if (!cl) {
        cl = { key, parents: childParentList, children: [] }
        clusterMap.set(key, cl)
      }
      if (!cl.children.includes(e.child)) cl.children.push(e.child)
    }

    // Track which clusters carry a "sensitive" flag — if ANY edge in the
    // cluster is sensitive, draw the whole cluster as sensitive.
    const sensitiveClusters = new Set<string>()
    for (const e of parentChild) {
      if (!e.sensitive) continue
      const childParentList: string[] = []
      for (const e2 of parentChild) if (e2.child === e.child) childParentList.push(e2.parent)
      childParentList.sort()
      const cNode = nodeMap.get(e.child)
      if (cNode) sensitiveClusters.add(childParentList.join('|') + '→' + cNode.y)
    }

    // Build a quick "is this pair a spouse couple" lookup.
    const spousePairKey = new Set<string>()
    for (const s of spouses) {
      const a = s.a < s.b ? s.a : s.b
      const b = s.a < s.b ? s.b : s.a
      spousePairKey.add(`${a}|${b}`)
    }
    const isSpousePair = (p1: string, p2: string): boolean => {
      const a = p1 < p2 ? p1 : p2
      const b = p1 < p2 ? p2 : p1
      return spousePairKey.has(`${a}|${b}`)
    }

    // Sort clusters left-to-right by their children's midpoint so we can
    // stagger childArmY/parentArmY across adjacent clusters. This breaks
    // up the "one continuous bar" illusion when several unrelated clusters
    // sit at the same generation and their beams would otherwise share a Y.
    const sortedClusters = Array.from(clusterMap.values()).sort((a, b) => {
      const ax = (a.children.map(c => nodeMap.get(c)?.x ?? 0).reduce((s, x) => s + x, 0)) / a.children.length
      const bx = (b.children.map(c => nodeMap.get(c)?.x ?? 0).reduce((s, x) => s + x, 0)) / b.children.length
      return ax - bx
    })

    // Index clusters per (childY) so the stagger restarts at each generation.
    const clusterIdxAtY = new Map<number, number>()
    for (const cluster of sortedClusters) {
      // Resolve nodes
      const parentNodes = cluster.parents.map(p => nodeMap.get(p)).filter((n): n is NodeData => !!n)
      const childNodes  = cluster.children.map(c => nodeMap.get(c)).filter((n): n is NodeData => !!n)
      if (parentNodes.length === 0 || childNodes.length === 0) continue

      const sensitive = sensitiveClusters.has(cluster.key)
      const stroke = sensitive ? STROKE_SENSITIVE : STROKE
      const dash = sensitive ? '4,4' : null

      const y1 = parentNodes[0].y + NODE_H / 2          // bottom of parents row
      const y2 = childNodes[0].y - NODE_H / 2           // top of children row
      if (y2 <= y1) continue

      // Per-generation cluster index for staggering. 0, 1, 2, ...
      const cIdx = clusterIdxAtY.get(y2) ?? 0
      clusterIdxAtY.set(y2, cIdx + 1)

      // X spans
      const childXs   = childNodes.map(n => n.x).sort((a, b) => a - b)
      const childMinX = childXs[0]
      const childMaxX = childXs[childXs.length - 1]
      const childMidX = (childMinX + childMaxX) / 2

      const parentXs   = parentNodes.map(n => n.x).sort((a, b) => a - b)
      const parentMinX = parentXs[0]
      const parentMaxX = parentXs[parentXs.length - 1]
      const parentMidX = (parentMinX + parentMaxX) / 2

      const parentsAreCouple = parentNodes.length === 2
        && isSpousePair(parentNodes[0].id, parentNodes[1].id)
        && parentNodes[0].y === parentNodes[1].y

      // parentArmY/childArmY are constant per generation pair so vertical
      // drops are uniform. junctionY is STAGGERED per cluster: every cluster
      // gets its own unique Y for its dogleg. This prevents the horizontal
      // dogleg segments of adjacent clusters from sharing a Y line and
      // visually fusing into one continuous bar — the issue users see when
      // a cluster needs to dogleg far horizontally (e.g. when a couple's
      // children are far from the couple's grandparent midpoint).
      const parentArmY = y1 + 24
      const childArmY  = y2 - 24
      const span = childArmY - parentArmY
      // Up to ~6 cluster bands fit in the vertical span.
      const STAGGER_BANDS = 5
      const stagger = ((cIdx % STAGGER_BANDS) + 1) / (STAGGER_BANDS + 1)  // 1/6, 2/6, 3/6, 4/6, 5/6
      const junctionY  = parentArmY + span * stagger

      const cornerR = 6

      if (parentsAreCouple) {
        edgeGroup.append('line')
          .attr('x1', parentMidX).attr('y1', y1).attr('x2', parentMidX).attr('y2', junctionY)
          .attr('stroke', stroke).attr('stroke-width', 1.5).attr('stroke-dasharray', dash)
      } else {
        for (const p of parentNodes) {
          edgeGroup.append('line')
            .attr('x1', p.x).attr('y1', y1).attr('x2', p.x).attr('y2', parentArmY)
            .attr('stroke', stroke).attr('stroke-width', 1.5).attr('stroke-dasharray', dash)
        }
        if (parentNodes.length > 1) {
          edgeGroup.append('line')
            .attr('x1', parentMinX).attr('y1', parentArmY)
            .attr('x2', parentMaxX).attr('y2', parentArmY)
            .attr('stroke', stroke).attr('stroke-width', 1.5).attr('stroke-dasharray', dash)
        }
        edgeGroup.append('line')
          .attr('x1', parentMidX).attr('y1', parentArmY)
          .attr('x2', parentMidX).attr('y2', junctionY)
          .attr('stroke', stroke).attr('stroke-width', 1.5).attr('stroke-dasharray', dash)
      }

      if (Math.abs(parentMidX - childMidX) > 1) {
        const dx = childMidX > parentMidX ? 1 : -1
        const cr = Math.min(cornerR, Math.abs(childMidX - parentMidX) / 2, Math.abs(junctionY - parentArmY) / 2)
        edgeGroup.append('path')
          .attr('d', [
            `M ${parentMidX} ${junctionY - cr}`,
            `Q ${parentMidX} ${junctionY} ${parentMidX + dx * cr} ${junctionY}`,
            `L ${childMidX - dx * cr} ${junctionY}`,
            `Q ${childMidX} ${junctionY} ${childMidX} ${junctionY + cr}`,
          ].join(' '))
          .attr('fill', 'none').attr('stroke', stroke).attr('stroke-width', 1.5).attr('stroke-dasharray', dash)
      }

      edgeGroup.append('line')
        .attr('x1', childMidX).attr('y1', junctionY)
        .attr('x2', childMidX).attr('y2', childArmY)
        .attr('stroke', stroke).attr('stroke-width', 1.5).attr('stroke-dasharray', dash)

      if (childNodes.length > 1) {
        edgeGroup.append('line')
          .attr('x1', childMinX).attr('y1', childArmY)
          .attr('x2', childMaxX).attr('y2', childArmY)
          .attr('stroke', stroke).attr('stroke-width', 1.5).attr('stroke-dasharray', dash)
      }

      for (const c of childNodes) {
        edgeGroup.append('line')
          .attr('x1', c.x).attr('y1', childArmY)
          .attr('x2', c.x).attr('y2', y2)
          .attr('stroke', stroke).attr('stroke-width', 1.5).attr('stroke-dasharray', dash)
      }
    }

    // Spouses: short horizontal line between cards on same row.
    for (const s of spouses) {
      const a = nodeMap.get(s.a)
      const b = nodeMap.get(s.b)
      if (!a || !b) continue
      const leftNode = a.x <= b.x ? a : b
      const rightNode = a.x <= b.x ? b : a
      const x1 = leftNode.x + NODE_W / 2
      const x2 = rightNode.x - NODE_W / 2
      const y  = (leftNode.y + rightNode.y) / 2
      const dash = (s.status && s.status !== 'married') ? '6,3'
                 : s.sensitive ? '4,4'
                 : null
      edgeGroup.append('line')
        .attr('x1', x1).attr('y1', y).attr('x2', x2).attr('y2', y)
        .attr('stroke', s.sensitive ? STROKE_SENSITIVE : STROKE)
        .attr('stroke-dasharray', dash)
        .attr('stroke-width', 1.5).attr('opacity', 0.85)
    }

    // Siblings: only draw if no shared parent exists (otherwise the parent connectors already show the relation).
    const childParents = new Map<string, Set<string>>()
    for (const e of parentChild) {
      if (!childParents.has(e.child)) childParents.set(e.child, new Set())
      childParents.get(e.child)!.add(e.parent)
    }
    for (const s of siblings) {
      const pa = childParents.get(s.a) ?? new Set()
      const pb = childParents.get(s.b) ?? new Set()
      let shared = false
      for (const p of pa) if (pb.has(p)) { shared = true; break }
      if (shared) continue
      const a = nodeMap.get(s.a); const b = nodeMap.get(s.b)
      if (!a || !b) continue
      // Dashed horizontal line at midpoint
      const x1 = Math.min(a.x, b.x) + NODE_W / 2
      const x2 = Math.max(a.x, b.x) - NODE_W / 2
      const y  = (a.y + b.y) / 2
      edgeGroup.append('line')
        .attr('x1', x1).attr('y1', y).attr('x2', x2).attr('y2', y)
        .attr('stroke', STROKE).attr('stroke-dasharray', '4,3')
        .attr('stroke-width', 1.2).attr('opacity', 0.6)
    }

    // ── Nodes ──────────────────────────────────────────────────────────────────
    const nodeGroup = g.append('g').attr('class', 'nodes')
    const nodeElems = nodeGroup.selectAll<SVGGElement, NodeData>('g.node')
      .data(Array.from(nodeMap.values()), d => d.id)
      .join('g').attr('class', 'node')
      .attr('transform', d => `translate(${d.x - NODE_W / 2},${d.y - NODE_H / 2})`)
      .style('cursor', 'pointer')
      .on('click', (_event, d) => {
        setSelectedPersonId(prev => prev === d.id ? null : d.id)
      })

    nodeElems.append('rect')
      .attr('width', NODE_W).attr('height', NODE_H).attr('rx', 10)
      .attr('filter', 'url(#node-shadow)')
      .attr('fill', d => d.id === rootPubkey ? 'var(--navy)' : '#ffffff')
      .attr('stroke', d => {
        if (d.id === selectedPersonId) return 'var(--gold)'
        if (d.hasConflict) return '#c0392b'
        if (d.id === rootPubkey) return 'var(--gold)'
        return 'var(--border-soft)'
      })
      .attr('stroke-width', d => d.id === selectedPersonId || d.id === rootPubkey ? 2 : 1)

    nodeElems.filter(d => d.isLiving)
      .append('circle')
      .attr('cx', NODE_W - 10).attr('cy', 10).attr('r', 3.5).attr('fill', '#4caf78')

    // Gold dot indicator for nodes that have a profile photo
    // Simple filled circle — emoji SVG text is unreliable across platforms
    nodeElems.filter(d => d.hasAvatar)
      .append('circle')
      .attr('cx', 9).attr('cy', 9).attr('r', 4.5)
      .attr('fill', 'var(--gold)')
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.5)

    nodeElems.append('text')
      .attr('x', NODE_W / 2).attr('y', 26)
      .attr('text-anchor', 'middle')
      .attr('font-size', 13).attr('font-family', 'Lora, Georgia, serif').attr('font-weight', '600')
      .attr('fill', d => d.id === rootPubkey ? 'var(--gold-light)' : 'var(--navy)')
      .text(d => d.displayName.length > 22 ? d.displayName.slice(0, 20) + '…' : d.displayName)

    nodeElems.append('text')
      .attr('x', NODE_W / 2).attr('y', 44)
      .attr('text-anchor', 'middle')
      .attr('font-size', 10.5)
      .attr('fill', d => d.id === rootPubkey ? 'rgba(201,169,110,0.8)' : 'var(--ink-muted)')
      .text(d => {
        if (d.birthYear && d.deathYear) return `${d.birthYear} – ${d.deathYear}`
        if (d.birthYear) return `b. ${d.birthYear}`
        return ''
      })

    // ── Auto-fit ───────────────────────────────────────────────────────────────
    const allPos = Array.from(posMap.values())
    if (allPos.length > 0) {
      const xs = allPos.map(p => p.x)
      const ys = allPos.map(p => p.y)
      const pad = 60
      const minX = Math.min(...xs) - NODE_W / 2 - pad
      const maxX = Math.max(...xs) + NODE_W / 2 + pad
      const minY = Math.min(...ys) - NODE_H / 2 - pad
      const maxY = Math.max(...ys) + NODE_H / 2 + pad
      const scale = Math.min(0.95, width / (maxX - minX), height / (maxY - minY))
      const cx = (minX + maxX) / 2
      const cy = (minY + maxY) / 2
      svg.call(zoom.transform, d3.zoomIdentity
        .translate(width / 2 - scale * cx, height / 2 - scale * cy)
        .scale(scale))
    }
  }, [rootPubkey, selectedPersonId, treeVersion, syncVersion])

  useEffect(() => { draw() }, [draw])
  useEffect(() => {
    const h = () => draw()
    window.addEventListener('resize', h)
    return () => window.removeEventListener('resize', h)
  }, [draw])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16, padding: '8px 16px',
        borderBottom: '1px solid var(--border-soft)', background: '#fff',
        fontSize: 13, color: 'var(--ink-muted)', flexShrink: 0,
      }}>
        <span>{nodeCount} {nodeCount === 1 ? 'person' : 'people'}</span>
        {truncated && <span style={{ color: 'var(--gold)', fontWeight: 500 }}>⚠ Tree truncated — zoom out to see more</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 16, alignItems: 'center', fontSize: 11 }}>
          <LegendItem color="var(--gold)" label="Parent / child" />
          <LegendItem color="var(--gold)" label="Married spouse" />
          <LegendItem color="var(--gold)" dash="6,3" label="Partner / divorced" />
          <LegendItem color="#c5b89a"    dash="4,4" label="Sensitive" />
        </div>
        <span style={{ color: 'var(--border)', fontSize: 11 }}>Scroll to zoom · Drag to pan · Click to select</span>
      </div>

      <div ref={containerRef} style={{ flex: 1, position: 'relative', overflow: 'hidden', background: 'var(--cream)' }}>
        <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
        {selectedPersonId && (
          <ActionPanel
            personId={selectedPersonId}
            rootPubkey={rootPubkey}
            onClose={handleClosePanel}
            onMakeRoot={handleMakeRoot}
            onTreeRefresh={handleTreeRefresh}
            onPersonDeleted={handlePersonDeleted}
          />
        )}
      </div>
    </div>
  )
}
