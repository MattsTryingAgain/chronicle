/**
 * FamilyTreeView — family-unit-aware generational layout
 *
 * Layout principles:
 * - Couples (spouse pairs) are positioned adjacent and treated as one unit
 * - Parent→child connectors drop from the midpoint between a couple (or from
 *   a solo parent), only when an actual parent edge exists in the graph
 * - Sibling edges are not drawn — siblings are visually grouped under the same
 *   parent connector
 * - Spouse line: solid = married, dashed = all other statuses
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import * as d3 from 'd3'
import { store } from '../lib/storage'
import { traverseGraph } from '../lib/graph'
import type { GraphEdge } from '../lib/graph'
import { resolveAllFields } from '../lib/confidence'
import type { Person } from '../types/chronicle'

// ─── Types ────────────────────────────────────────────────────────────────────

interface NodeData {
  pubkey: string
  displayName: string
  birthYear: string | null
  deathYear: string | null
  hasConflict: boolean
  isLiving: boolean
  generation: number
  x: number
  y: number
}

interface FamilyTreeViewProps {
  rootPubkey: string
  onSelectPerson?: (pubkey: string) => void
  onEditPerson?: (pubkey: string) => void
}

// ─── Constants ────────────────────────────────────────────────────────────────

const NODE_W   = 180
const NODE_H   = 60
const H_GAP    = 40       // gap between nodes in same row
const COUPLE_GAP = 24     // tighter gap between spouses
const V_GAP    = 110
const CORNER_R = 10

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractYear(val: string | null): string | null {
  if (!val) return null
  const m = val.match(/\b(\d{4})\b/)
  return m ? m[1] : null
}

function buildNodeData(pubkey: string, generation: number): NodeData {
  const person: Person | undefined = store.getPerson(pubkey)
  const claims = store.getClaimsForPerson(pubkey)
  const endorsements = store.getAllEndorsements()
  const resolutions = resolveAllFields(claims, endorsements)
  const hasConflict = resolutions.some(r => r.conflictState === 'hard' || r.conflictState === 'soft')
  const bornRes = resolutions.find(r => r.field === 'born')
  const diedRes = resolutions.find(r => r.field === 'died')
  return {
    pubkey,
    displayName: person?.displayName ?? pubkey.slice(0, 12) + '…',
    birthYear: extractYear(bornRes?.winningClaim?.value ?? null),
    deathYear: extractYear(diedRes?.winningClaim?.value ?? null),
    hasConflict,
    isLiving: person?.isLiving ?? false,
    generation,
    x: 0,
    y: 0,
  }
}

// ─── Generation assignment ────────────────────────────────────────────────────

function assignGenerations(
  rootPubkey: string,
  nodes: string[],
  edges: GraphEdge[],
): Map<string, number> {
  const genMap = new Map<string, number>()
  genMap.set(rootPubkey, 0)

  // Build adjacency: for each node, list of {neighbour, rel, asSubject}
  const adj = new Map<string, Array<{ neighbour: string; rel: string; asSubject: boolean }>>()
  for (const n of nodes) adj.set(n, [])
  for (const e of edges) {
    adj.get(e.fromPubkey)?.push({ neighbour: e.toPubkey, rel: e.relationship, asSubject: true })
    adj.get(e.toPubkey)?.push({ neighbour: e.fromPubkey, rel: e.relationship, asSubject: false })
  }

  const queue = [rootPubkey]
  while (queue.length > 0) {
    const current = queue.shift()!
    const currentGen = genMap.get(current) ?? 0
    for (const { neighbour, rel, asSubject } of (adj.get(current) ?? [])) {
      if (genMap.has(neighbour)) continue
      let delta = 0
      if (asSubject) {
        if (rel === 'parent') delta = 1
        else if (rel === 'child') delta = -1
        // spouse/sibling = same gen, delta stays 0
      } else {
        if (rel === 'parent') delta = -1
        else if (rel === 'child') delta = 1
      }
      genMap.set(neighbour, currentGen + delta)
      queue.push(neighbour)
    }
  }
  for (const n of nodes) { if (!genMap.has(n)) genMap.set(n, 0) }
  return genMap
}

// ─── Family-unit-aware layout ─────────────────────────────────────────────────
//
// Algorithm:
// 1. Find all spouse pairs — treat each pair as a single "slot"
// 2. For each generation, lay out slots (couple or solo) left to right
// 3. Position couple members side by side with COUPLE_GAP between them
// 4. Track the midpoint X of each slot — used for connector origins/targets

interface Slot {
  members: string[]      // 1 or 2 pubkeys
  midX: number           // centre of the slot
  y: number
}

function computeLayout(
  nodes: string[],
  genMap: Map<string, number>,
  edges: GraphEdge[],
  rootPubkey: string,
): { posMap: Map<string, { x: number; y: number }>; slotMap: Map<string, Slot> } {

  // Build spouse and parent→child lookup maps
  const spouseOf = new Map<string, string>()
  const childrenOf = new Map<string, Set<string>>() // parentPk → Set<childPk>
  const parentsOf  = new Map<string, Set<string>>() // childPk  → Set<parentPk>

  for (const n of nodes) {
    childrenOf.set(n, new Set())
    parentsOf.set(n, new Set())
  }

  for (const e of edges) {
    if (e.relationship === 'spouse') {
      spouseOf.set(e.fromPubkey, e.toPubkey)
      spouseOf.set(e.toPubkey, e.fromPubkey)
    } else if (e.relationship === 'parent') {
      childrenOf.get(e.fromPubkey)?.add(e.toPubkey)
      parentsOf.get(e.toPubkey)?.add(e.fromPubkey)
    } else if (e.relationship === 'child') {
      // inverse edge: fromPubkey is the child, toPubkey is the parent
      childrenOf.get(e.toPubkey)?.add(e.fromPubkey)
      parentsOf.get(e.fromPubkey)?.add(e.toPubkey)
    }
  }

  // Group nodes by generation
  const byGen = new Map<number, string[]>()
  for (const n of nodes) {
    const g = genMap.get(n) ?? 0
    if (!byGen.has(g)) byGen.set(g, [])
    byGen.get(g)!.push(n)
  }

  const gens = Array.from(byGen.keys()).sort((a, b) => a - b)
  const minGen = gens[0] ?? 0

  const posMap = new Map<string, { x: number; y: number }>()
  const slotMap = new Map<string, Slot>()

  // Process generations bottom-up (descendants first) so that when we place
  // parents, their children are already positioned and we can sort parent slots
  // directly above their children.
  for (const gen of [...gens].reverse()) {
    const members = byGen.get(gen)!
    const yPos = (gen - minGen) * (NODE_H + V_GAP)

    // Build couple slots — each couple is one slot, solos are their own slot
    const slots: Array<string[]> = []
    const placed = new Set<string>()

    for (const pk of members) {
      if (placed.has(pk)) continue
      const spouse = spouseOf.get(pk)
      if (spouse && members.includes(spouse) && !placed.has(spouse)) {
        slots.push([pk, spouse])
        placed.add(pk); placed.add(spouse)
      } else {
        slots.push([pk])
        placed.add(pk)
      }
    }

    // Sort slots so that slots with children in the next generation appear
    // ordered by the average x-position of those children (already placed).
    // Slots with no children placed yet keep their original order relative
    // to each other, but go after slots that do have children placed.
    const childAvgX = (slot: string[]): number | null => {
      const xs: number[] = []
      for (const pk of slot) {
        for (const child of childrenOf.get(pk) ?? []) {
          const pos = posMap.get(child)
          if (pos) xs.push(pos.x)
        }
      }
      return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null
    }

    // Separate slots that have placed children from those that don't
    const withChildren    = slots.filter(s => childAvgX(s) !== null)
    const withoutChildren = slots.filter(s => childAvgX(s) === null)

    // Sort the ones with children by their children's average x
    withChildren.sort((a, b) => (childAvgX(a) ?? 0) - (childAvgX(b) ?? 0))

    // Put root's slot in the middle of withChildren if present, else prepend
    const rootSlotIdx = withChildren.findIndex(s => s.includes(rootPubkey))
    const orderedSlots = rootSlotIdx >= 0
      ? [...withChildren, ...withoutChildren]
      : [...withChildren, ...withoutChildren]

    // Calculate total row width
    let totalWidth = 0
    for (const slot of orderedSlots) {
      if (totalWidth > 0) totalWidth += H_GAP
      totalWidth += slot.length === 2 ? NODE_W * 2 + COUPLE_GAP : NODE_W
    }

    let curX = -totalWidth / 2 + NODE_W / 2

    for (const slot of orderedSlots) {
      const slotMidX = slot.length === 2
        ? curX + NODE_W / 2 + COUPLE_GAP / 2
        : curX

      if (slot.length === 2) {
        const [a, b] = slot
        posMap.set(a, { x: curX, y: yPos })
        posMap.set(b, { x: curX + NODE_W + COUPLE_GAP, y: yPos })
        const slotObj: Slot = { members: [a, b], midX: slotMidX, y: yPos }
        slotMap.set(a, slotObj)
        slotMap.set(b, slotObj)
        curX += NODE_W * 2 + COUPLE_GAP + H_GAP
      } else {
        const [a] = slot
        posMap.set(a, { x: curX, y: yPos })
        const slotObj: Slot = { members: [a], midX: curX, y: yPos }
        slotMap.set(a, slotObj)
        curX += NODE_W + H_GAP
      }
    }
  }

  return { posMap, slotMap }
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
      position: 'absolute',
      top: 0, right: 0,
      width: 280,
      height: '100%',
      background: '#fff',
      borderLeft: '1px solid var(--border-soft)',
      boxShadow: '-4px 0 24px rgba(15,30,53,0.08)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 10,
    }}>
      {/* Header */}
      <div style={{
        padding: '20px 20px 16px',
        borderBottom: '1px solid var(--border-soft)',
        background: 'var(--cream)',
      }}>
        <button
          onClick={onClose}
          style={{
            position: 'absolute', top: 12, right: 12,
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--ink-muted)', fontSize: 18, lineHeight: 1, padding: 4,
          }}
        >✕</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{
            width: 48, height: 48, borderRadius: '50%',
            background: 'var(--navy)', color: 'var(--gold)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700,
            flexShrink: 0,
          }}>
            {initials}
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 16, color: 'var(--navy)', fontFamily: 'var(--font-display)' }}>
              {person.displayName}
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 2 }}>
              {person.isLiving ? 'Living' : 'Ancestor'}
              {born && ` · b. ${born}`}
              {died && ` · d. ${died}`}
            </div>
            {place && (
              <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{place}</div>
            )}
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ padding: '16px 16px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1, overflowY: 'auto' }}>

        <ActionButton
          icon="✏️"
          label="Edit information"
          description="Update facts, dates and relationships"
          onClick={() => onEdit(pubkey)}
        />

        <ActionButton
          icon="📋"
          label="View full profile"
          description="See all claims and conflict history"
          onClick={() => onViewInList(pubkey)}
        />

        <div style={{ borderTop: '1px solid var(--border-soft)', margin: '4px 0' }} />

        <ActionButton
          icon="🖼"
          label="Photos & media"
          description="View and add photos for this person"
          onClick={() => {}}
          comingSoon
        />

        <ActionButton
          icon="📖"
          label="Stories"
          description="Personal stories and memories"
          onClick={() => {}}
          comingSoon
        />

        <ActionButton
          icon="📄"
          label="Documents"
          description="Birth certificates, records and sources"
          onClick={() => {}}
          comingSoon
        />

        <ActionButton
          icon="🌍"
          label="Timeline"
          description="Life events on a timeline"
          onClick={() => {}}
          comingSoon
        />
      </div>

      {/* Focus tree on this person */}
      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-soft)' }}>
        <button
          className="btn btn-outline btn-sm"
          style={{ width: '100%', justifyContent: 'center' }}
          onClick={() => { onViewInList(pubkey); onClose() }}
        >
          Make this person the tree root
        </button>
      </div>
    </div>
  )
}

interface ActionButtonProps {
  icon: string
  label: string
  description: string
  onClick: () => void
  comingSoon?: boolean
}

function ActionButton({ icon, label, description, onClick, comingSoon }: ActionButtonProps) {
  return (
    <button
      onClick={comingSoon ? undefined : onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 12px',
        background: comingSoon ? 'transparent' : 'var(--cream)',
        border: '1px solid var(--border-soft)',
        borderRadius: 8, cursor: comingSoon ? 'default' : 'pointer',
        textAlign: 'left', width: '100%',
        opacity: comingSoon ? 0.5 : 1,
        transition: 'background 0.15s',
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
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [truncated, setTruncated] = useState(false)
  const [nodeCount, setNodeCount] = useState(0)
  const [selectedPubkey, setSelectedPubkey] = useState<string | null>(null)

  const handleClosePanel = useCallback(() => setSelectedPubkey(null), [])

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
      .scaleExtent([0.15, 3])
      .on('zoom', event => g.attr('transform', event.transform))
    svg.call(zoom)

    // ── Layout ────────────────────────────────────────────────────────────────
    const genMap = assignGenerations(rootPubkey, nodes, edges)
    const { posMap } = computeLayout(nodes, genMap, edges, rootPubkey)

    const nodeDataMap = new Map<string, NodeData>()
    for (const pk of nodes) {
      const nd = buildNodeData(pk, genMap.get(pk) ?? 0)
      const pos = posMap.get(pk) ?? { x: 0, y: 0 }
      nd.x = pos.x; nd.y = pos.y
      nodeDataMap.set(pk, nd)
    }

    // ── Edges ─────────────────────────────────────────────────────────────────
    // Simple rule: one line per edge. Parent→child = elbow connector from
    // bottom of parent to top of child. Spouse = horizontal line between them.
    // No grouping, no inferred midpoints — just draw what the data says.
    const edgeGroup = g.append('g')

    for (const edge of edges) {
      if (edge.relationship === 'sibling') continue

      const from = nodeDataMap.get(edge.fromPubkey)
      const to   = nodeDataMap.get(edge.toPubkey)
      if (!from || !to) continue

      const stroke = edge.sensitive ? '#c5b89a' : '#c9a96e'

      if (edge.relationship === 'spouse') {
        const status = edge.meta?.status
        const dash = (status === 'married') ? null : '6,3'
        const x1 = from.x + (from.x <= to.x ? NODE_W / 2 : -NODE_W / 2)
        const x2 = to.x   + (from.x <= to.x ? -NODE_W / 2 : NODE_W / 2)
        const y  = (from.y + to.y) / 2
        edgeGroup.append('line')
          .attr('x1', x1).attr('y1', y).attr('x2', x2).attr('y2', y)
          .attr('stroke', stroke).attr('stroke-dasharray', dash)
          .attr('stroke-width', 1.5).attr('opacity', 0.7)
        continue
      }

      // Parent→child: determine which end is the parent
      let parentNode: NodeData, childNode: NodeData
      if (edge.relationship === 'parent') {
        parentNode = from; childNode = to
      } else {
        // 'child' edge: fromPubkey is the child, toPubkey is the parent
        parentNode = to; childNode = from
      }

      // Only draw if parent is actually above child
      if (parentNode.y >= childNode.y) continue

      const x1 = parentNode.x
      const y1 = parentNode.y + NODE_H / 2
      const x2 = childNode.x
      const y2 = childNode.y - NODE_H / 2
      const midY = (y1 + y2) / 2
      const r = CORNER_R

      if (Math.abs(x1 - x2) < 4) {
        edgeGroup.append('line')
          .attr('x1', x1).attr('y1', y1).attr('x2', x2).attr('y2', y2)
          .attr('stroke', stroke).attr('stroke-width', 1.5)
      } else {
        const dx = x2 > x1 ? 1 : -1
        const cr = Math.min(r, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2)
        edgeGroup.append('path')
          .attr('d', [
            `M ${x1} ${y1}`,
            `L ${x1} ${midY - cr}`,
            `Q ${x1} ${midY} ${x1 + dx * cr} ${midY}`,
            `L ${x2 - dx * cr} ${midY}`,
            `Q ${x2} ${midY} ${x2} ${midY + cr}`,
            `L ${x2} ${y2}`,
          ].join(' '))
          .attr('fill', 'none').attr('stroke', stroke).attr('stroke-width', 1.5)
      }
    }

    // ── Nodes ─────────────────────────────────────────────────────────────────
        // ── Nodes ─────────────────────────────────────────────────────────────────
    const nodeGroup = g.append('g')

    const defs = svg.append('defs')
    defs.append('filter').attr('id', 'node-shadow')
      .append('feDropShadow')
      .attr('dx', 0).attr('dy', 1).attr('stdDeviation', 3)
      .attr('flood-color', 'rgba(15,30,53,0.12)')

    const nodeElems = nodeGroup.selectAll<SVGGElement, NodeData>('g.tree-node')
      .data(Array.from(nodeDataMap.values()), d => d.pubkey)
      .join('g')
      .attr('class', 'tree-node')
      .attr('transform', d => `translate(${d.x},${d.y})`)
      .style('cursor', 'pointer')
      .on('click', (_event, d) => {
        setSelectedPubkey(prev => prev === d.pubkey ? null : d.pubkey)
      })

    // Card
    nodeElems.append('rect')
      .attr('x', -NODE_W / 2).attr('y', -NODE_H / 2)
      .attr('width', NODE_W).attr('height', NODE_H)
      .attr('rx', 10)
      .attr('filter', 'url(#node-shadow)')
      .attr('fill', d => d.pubkey === rootPubkey ? 'var(--navy)' : '#ffffff')
      .attr('stroke', d => {
        if (d.pubkey === selectedPubkey) return 'var(--gold)'
        if (d.hasConflict) return '#c0392b'
        if (d.pubkey === rootPubkey) return 'var(--gold)'
        return 'var(--border-soft)'
      })
      .attr('stroke-width', d => (d.pubkey === selectedPubkey || d.pubkey === rootPubkey) ? 2 : 1)

    // Living dot
    nodeElems.filter(d => d.isLiving)
      .append('circle')
      .attr('cx', NODE_W / 2 - 10).attr('cy', -NODE_H / 2 + 10)
      .attr('r', 3.5)
      .attr('fill', '#4caf78')

    // Conflict dot
    nodeElems.filter(d => d.hasConflict)
      .append('text')
      .attr('x', -NODE_W / 2 + 8).attr('y', -NODE_H / 2 + 14)
      .attr('font-size', 10).attr('fill', '#c0392b').text('⚠')

    // Name
    nodeElems.append('text')
      .attr('y', -6)
      .attr('text-anchor', 'middle')
      .attr('font-size', 13)
      .attr('font-family', 'Lora, Georgia, serif')
      .attr('font-weight', '600')
      .attr('fill', d => d.pubkey === rootPubkey ? 'var(--gold-light)' : 'var(--navy)')
      .text(d => d.displayName.length > 22 ? d.displayName.slice(0, 20) + '…' : d.displayName)

    // Dates
    nodeElems.append('text')
      .attr('y', 13)
      .attr('text-anchor', 'middle')
      .attr('font-size', 10.5)
      .attr('fill', d => d.pubkey === rootPubkey ? 'rgba(201,169,110,0.8)' : 'var(--ink-muted)')
      .text(d => {
        if (d.birthYear && d.deathYear) return `${d.birthYear} – ${d.deathYear}`
        if (d.birthYear) return `b. ${d.birthYear}`
        return ''
      })

    // ── Auto-fit ──────────────────────────────────────────────────────────────
    const allPos = Array.from(posMap.values())
    if (allPos.length > 0) {
      const xs = allPos.map(p => p.x)
      const ys = allPos.map(p => p.y)
      const pad = 48
      const minX = Math.min(...xs) - NODE_W / 2 - pad
      const maxX = Math.max(...xs) + NODE_W / 2 + pad
      const minY = Math.min(...ys) - NODE_H / 2 - pad
      const maxY = Math.max(...ys) + NODE_H / 2 + pad
      const cw = maxX - minX, ch = maxY - minY
      const scale = Math.min(0.95, width / cw, height / ch)
      svg.call(zoom.transform, d3.zoomIdentity
        .translate(width / 2 - scale * (minX + cw / 2), height / 2 - scale * (minY + ch / 2))
        .scale(scale))
    }

  }, [rootPubkey, selectedPubkey])

  useEffect(() => { draw() }, [draw])

  useEffect(() => {
    const handler = () => draw()
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [draw])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>

      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16,
        padding: '8px 16px',
        borderBottom: '1px solid var(--border-soft)',
        background: '#fff',
        fontSize: 13,
        color: 'var(--ink-muted)',
        flexShrink: 0,
      }}>
        <span>{nodeCount} {nodeCount === 1 ? 'person' : 'people'}</span>
        {truncated && (
          <span style={{ color: 'var(--gold)', fontWeight: 500 }}>
            ⚠ Tree truncated — zoom out to see more
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 16, alignItems: 'center' }}>
          <LegendItem color="var(--gold)" dash="none" label="Married" />
          <LegendItem color="var(--gold)" dash="6,3" label="Partner / divorced" />
          <LegendItem color="#c5b89a" dash="4,4" label="Sensitive" />
        </div>
        <span style={{ color: 'var(--border)', marginLeft: 8, fontSize: 11 }}>
          Scroll to zoom · Drag to pan · Click to select
        </span>
      </div>

      {/* Canvas + panel */}
      <div ref={containerRef} style={{ flex: 1, position: 'relative', overflow: 'hidden', background: 'var(--cream)' }}>
        <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />

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

function LegendItem({ color, dash, label }: { color: string; dash: string; label: string }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <svg width="24" height="8">
        <line x1="0" y1="4" x2="24" y2="4"
          stroke={color} strokeWidth="1.5"
          strokeDasharray={dash === 'none' ? undefined : dash} />
      </svg>
      {label}
    </span>
  )
}
