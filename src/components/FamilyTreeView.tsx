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
import type { Person } from '../types/chronicle'
import {
  NODE_W, NODE_H,
  normaliseEdges,
  assignGenerations,
  computeLayout,
} from './FamilyTreeView.layout'

const CORNER_R = 10

// ─── Types ────────────────────────────────────────────────────────────────────

interface NodeData {
  pubkey: string
  displayName: string
  birthYear: string | null
  deathYear: string | null
  hasConflict: boolean
  isLiving: boolean
  x: number
  y: number
}

interface FamilyTreeViewProps {
  rootPubkey: string
  onSelectPerson?: (pubkey: string) => void
  onEditPerson?: (pubkey: string) => void
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractYear(val: string | null): string | null {
  if (!val) return null
  const m = val.match(/\b(\d{4})\b/)
  return m ? m[1] : null
}

function buildNodeData(pubkey: string): NodeData {
  const person: Person | undefined = store.getPerson(pubkey)
  const claims = store.getClaimsForPerson(pubkey)
  const endorsements = store.getAllEndorsements()
  const resolutions = resolveAllFields(claims, endorsements)
  const hasConflict = resolutions.some(r => r.conflictState === 'hard' || r.conflictState === 'soft')
  const born = resolutions.find(r => r.field === 'born')?.winningClaim?.value ?? null
  const died = resolutions.find(r => r.field === 'died')?.winningClaim?.value ?? null
  return {
    pubkey,
    displayName: person?.displayName ?? pubkey.slice(0, 12) + '…',
    birthYear: extractYear(born),
    deathYear: extractYear(died),
    hasConflict,
    isLiving: person?.isLiving ?? false,
    x: 0,
    y: 0,
  }
}


// ─── Action Panel ─────────────────────────────────────────────────────────────

interface ActionPanelProps {
  pubkey: string
  onClose: () => void
  onEdit: (pubkey: string) => void
  onViewInList: (pubkey: string) => void
  onMakeRoot: (pubkey: string) => void
}

function ActionPanel({ pubkey, onClose, onEdit, onViewInList, onMakeRoot }: ActionPanelProps) {
  const person = store.getPerson(pubkey)
  if (!person) return null
  const initials = person.displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
  const claims = store.getClaimsForPerson(pubkey)
  const endorsements = store.getAllEndorsements()
  const resolutions = resolveAllFields(claims, endorsements)
  const born  = resolutions.find(r => r.field === 'born')?.winningClaim?.value
  const died  = resolutions.find(r => r.field === 'died')?.winningClaim?.value
  const place = resolutions.find(r => r.field === 'birthplace')?.winningClaim?.value

  return (
    <div style={{
      position: 'absolute', top: 0, right: 0,
      width: 280, height: '100%', background: '#fff',
      borderLeft: '1px solid var(--border-soft)',
      boxShadow: '-4px 0 24px rgba(15,30,53,0.08)',
      display: 'flex', flexDirection: 'column', zIndex: 10,
    }}>
      <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--border-soft)', background: 'var(--cream)', position: 'relative' }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 12, right: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-muted)', fontSize: 18, lineHeight: 1, padding: 4 }}>✕</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--navy)', color: 'var(--gold)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, flexShrink: 0 }}>{initials}</div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 16, color: 'var(--navy)', fontFamily: 'var(--font-display)' }}>{person.displayName}</div>
            <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 2 }}>
              {person.isLiving ? 'Living' : 'Ancestor'}{born && ` · b. ${born}`}{died && ` · d. ${died}`}
            </div>
            {place && <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{place}</div>}
          </div>
        </div>
      </div>
      <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1, overflowY: 'auto' }}>
        <ActionButton icon="✏️" label="Edit information"  description="Update facts, dates and relationships" onClick={() => onEdit(pubkey)} />
        <ActionButton icon="📋" label="View full profile" description="See all claims and conflict history"   onClick={() => onViewInList(pubkey)} />
        <div style={{ borderTop: '1px solid var(--border-soft)', margin: '4px 0' }} />
        <ActionButton icon="🖼"  label="Photos & media"    description="View and add photos for this person"   onClick={() => {}} comingSoon />
        <ActionButton icon="📖" label="Stories"            description="Personal stories and memories"         onClick={() => {}} comingSoon />
        <ActionButton icon="📄" label="Documents"          description="Birth certificates, records and sources" onClick={() => {}} comingSoon />
        <ActionButton icon="🌍" label="Timeline"           description="Life events on a timeline"             onClick={() => {}} comingSoon />
      </div>
      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-soft)' }}>
        <button className="btn btn-outline btn-sm" style={{ width: '100%', justifyContent: 'center' }}
          onClick={() => { onMakeRoot(pubkey); onClose() }}>
          Make this person the tree root
        </button>
      </div>
    </div>
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

export default function FamilyTreeView({ rootPubkey, onSelectPerson, onEditPerson }: FamilyTreeViewProps) {
  const svgRef       = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [nodeCount, setNodeCount]       = useState(0)
  const [truncated, setTruncated]       = useState(false)
  const [selectedPubkey, setSelectedPubkey] = useState<string | null>(null)

  const handleClosePanel = useCallback(() => setSelectedPubkey(null), [])
  const handleMakeRoot   = useCallback((pk: string) => onSelectPerson?.(pk), [onSelectPerson])

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
      const nd = buildNodeData(pk)
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

    // Parent → child: elbow connector from bottom of parent to top of child.
    for (const e of parentChild) {
      const pNode = nodeMap.get(e.parent)
      const cNode = nodeMap.get(e.child)
      if (!pNode || !cNode) continue

      const x1 = pNode.x
      const y1 = pNode.y + NODE_H / 2
      const x2 = cNode.x
      const y2 = cNode.y - NODE_H / 2

      // If child is somehow not below parent (shouldn't happen with correct gens),
      // skip drawing rather than producing weird visual.
      if (y2 <= y1) continue

      // The horizontal "beam" of the elbow sits closer to the CHILD (not
      // midway). This keeps T-junctions tight under their own children's
      // group instead of stretching halfway across the row at one shared
      // Y — which made multiple unrelated couples' beams visually fuse
      // into a single continuous bar across the top of the tree.
      const armY = y2 - 28
      const stroke = e.sensitive ? STROKE_SENSITIVE : STROKE
      const dash = e.sensitive ? '4,4' : null

      if (Math.abs(x1 - x2) < 2) {
        edgeGroup.append('line')
          .attr('x1', x1).attr('y1', y1).attr('x2', x2).attr('y2', y2)
          .attr('stroke', stroke).attr('stroke-width', 1.5)
          .attr('stroke-dasharray', dash)
      } else {
        const dx = x2 > x1 ? 1 : -1
        const cr = Math.min(CORNER_R, Math.abs(x2 - x1) / 2, Math.abs(armY - y1) / 2, Math.abs(y2 - armY) / 2)
        edgeGroup.append('path')
          .attr('d', [
            `M ${x1} ${y1}`,
            `L ${x1} ${armY - cr}`,
            `Q ${x1} ${armY} ${x1 + dx * cr} ${armY}`,
            `L ${x2 - dx * cr} ${armY}`,
            `Q ${x2} ${armY} ${x2} ${armY + cr}`,
            `L ${x2} ${y2}`,
          ].join(' '))
          .attr('fill', 'none')
          .attr('stroke', stroke).attr('stroke-width', 1.5)
          .attr('stroke-dasharray', dash)
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
      .data(Array.from(nodeMap.values()), d => d.pubkey)
      .join('g').attr('class', 'node')
      .attr('transform', d => `translate(${d.x - NODE_W / 2},${d.y - NODE_H / 2})`)
      .style('cursor', 'pointer')
      .on('click', (_event, d) => {
        setSelectedPubkey(prev => prev === d.pubkey ? null : d.pubkey)
      })

    nodeElems.append('rect')
      .attr('width', NODE_W).attr('height', NODE_H).attr('rx', 10)
      .attr('filter', 'url(#node-shadow)')
      .attr('fill', d => d.pubkey === rootPubkey ? 'var(--navy)' : '#ffffff')
      .attr('stroke', d => {
        if (d.pubkey === selectedPubkey) return 'var(--gold)'
        if (d.hasConflict) return '#c0392b'
        if (d.pubkey === rootPubkey) return 'var(--gold)'
        return 'var(--border-soft)'
      })
      .attr('stroke-width', d => d.pubkey === selectedPubkey || d.pubkey === rootPubkey ? 2 : 1)

    nodeElems.filter(d => d.isLiving)
      .append('circle')
      .attr('cx', NODE_W - 10).attr('cy', 10).attr('r', 3.5).attr('fill', '#4caf78')

    nodeElems.append('text')
      .attr('x', NODE_W / 2).attr('y', 26)
      .attr('text-anchor', 'middle')
      .attr('font-size', 13).attr('font-family', 'Lora, Georgia, serif').attr('font-weight', '600')
      .attr('fill', d => d.pubkey === rootPubkey ? 'var(--gold-light)' : 'var(--navy)')
      .text(d => d.displayName.length > 22 ? d.displayName.slice(0, 20) + '…' : d.displayName)

    nodeElems.append('text')
      .attr('x', NODE_W / 2).attr('y', 44)
      .attr('text-anchor', 'middle')
      .attr('font-size', 10.5)
      .attr('fill', d => d.pubkey === rootPubkey ? 'rgba(201,169,110,0.8)' : 'var(--ink-muted)')
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
  }, [rootPubkey, selectedPubkey])

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
        {selectedPubkey && (
          <ActionPanel
            pubkey={selectedPubkey}
            onClose={handleClosePanel}
            onEdit={pk => { onEditPerson?.(pk); handleClosePanel() }}
            onViewInList={pk => { onSelectPerson?.(pk) }}
            onMakeRoot={handleMakeRoot}
          />
        )}
      </div>
    </div>
  )
}
