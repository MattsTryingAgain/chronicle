/**
 * FamilyTreeView — D3 generational layout
 *
 * Layout: nodes in generation rows, top = oldest ancestors.
 * Connectors: one elbow per parent→child edge, drawn from the
 * bottom-centre of the parent directly to the top-centre of the child.
 * No shared bars, no midpoint grouping — just what the data says.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import * as d3 from 'd3'
import { store } from '../lib/storage'
import { traverseGraph } from '../lib/graph'
import type { GraphEdge } from '../lib/graph'
import { resolveAllFields } from '../lib/confidence'
import type { Person } from '../types/chronicle'

// ─── Constants ────────────────────────────────────────────────────────────────

const NODE_W    = 180
const NODE_H    = 60
const H_GAP     = 48
const V_GAP     = 100
const CORNER_R  = 8

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

// ─── Generation assignment ────────────────────────────────────────────────────
// BFS from root. parent edge = go up one generation (-1), child edge = go down (+1).
// Both forward and inverse edges are stored; we handle both directions correctly.

function assignGenerations(
  rootPubkey: string,
  nodes: string[],
  edges: GraphEdge[],
): Map<string, number> {
  // Build adjacency list
  const adj = new Map<string, Array<{ neighbour: string; rel: string; asSubject: boolean }>>()
  for (const n of nodes) adj.set(n, [])
  for (const e of edges) {
    adj.get(e.fromPubkey)?.push({ neighbour: e.toPubkey, rel: e.relationship, asSubject: true })
    adj.get(e.toPubkey)?.push({ neighbour: e.fromPubkey, rel: e.relationship, asSubject: false })
  }

  const genMap = new Map<string, number>()
  genMap.set(rootPubkey, 0)
  const queue = [rootPubkey]

  while (queue.length > 0) {
    const current = queue.shift()!
    const currentGen = genMap.get(current)!
    for (const { neighbour, rel, asSubject } of adj.get(current) ?? []) {
      if (genMap.has(neighbour)) continue
      let delta = 0
      if (asSubject) {
        if (rel === 'parent') delta = -1   // subject is parent → neighbour is child (lower gen)
        else if (rel === 'child') delta = 1 // subject is child → neighbour is parent (higher gen)
      } else {
        if (rel === 'parent') delta = 1    // traversing inverse of parent edge → go up
        else if (rel === 'child') delta = -1
      }
      genMap.set(neighbour, currentGen + delta)
      queue.push(neighbour)
    }
  }
  for (const n of nodes) { if (!genMap.has(n)) genMap.set(n, 0) }
  return genMap
}

// ─── Layout ───────────────────────────────────────────────────────────────────
// Place nodes in horizontal rows by generation.
// Couples (spouse pairs) sit adjacent. Ordering within a row:
// couples are sorted by the average x-position of their children in the row
// below, so parents sit directly above their own children.

function computeLayout(
  nodes: string[],
  genMap: Map<string, number>,
  edges: GraphEdge[],
  rootPubkey: string,
): Map<string, { x: number; y: number }> {
  // Build lookup maps
  const spouseOf   = new Map<string, string>()
  const childrenOf = new Map<string, Set<string>>() // pk → children pubkeys
  const parentsOf  = new Map<string, Set<string>>() // pk → parent pubkeys

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
      childrenOf.get(e.toPubkey)?.add(e.fromPubkey)
      parentsOf.get(e.fromPubkey)?.add(e.toPubkey)
    }
  }

  // Group by generation
  const byGen = new Map<number, string[]>()
  for (const n of nodes) {
    const g = genMap.get(n) ?? 0
    if (!byGen.has(g)) byGen.set(g, [])
    byGen.get(g)!.push(n)
  }

  const gens = Array.from(byGen.keys()).sort((a, b) => a - b)
  const minGen = gens[0] ?? 0
  const posMap = new Map<string, { x: number; y: number }>()

  // Process bottom-up so children are placed before parents.
  // That way parents can sort themselves above their children.
  for (const gen of [...gens].reverse()) {
    const members = byGen.get(gen)!
    const yPos = (gen - minGen) * (NODE_H + V_GAP)

    // Build couple slots
    const slots: string[][] = []
    const placed = new Set<string>()
    for (const pk of members) {
      if (placed.has(pk)) continue
      const spouse = spouseOf.get(pk)
      if (spouse && members.includes(spouse) && !placed.has(spouse)) {
        // Root always goes first in couple
        slots.push(pk === rootPubkey ? [pk, spouse] : [pk, spouse])
        placed.add(pk); placed.add(spouse)
      } else {
        slots.push([pk])
        placed.add(pk)
      }
    }

    // Sort slots by average x of their children (already placed below)
    const avgChildX = (slot: string[]): number | null => {
      const xs: number[] = []
      for (const pk of slot) {
        for (const child of childrenOf.get(pk) ?? []) {
          const pos = posMap.get(child)
          if (pos) xs.push(pos.x)
        }
      }
      return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null
    }

    const withKids    = slots.filter(s => avgChildX(s) !== null).sort((a, b) => (avgChildX(a) ?? 0) - (avgChildX(b) ?? 0))
    const withoutKids = slots.filter(s => avgChildX(s) === null)
    const ordered     = [...withKids, ...withoutKids]

    // Calculate total row width
    let totalWidth = 0
    for (const slot of ordered) {
      if (totalWidth > 0) totalWidth += H_GAP
      totalWidth += slot.length === 2 ? NODE_W * 2 + H_GAP / 2 : NODE_W
    }

    let curX = -totalWidth / 2 + NODE_W / 2
    for (const slot of ordered) {
      if (slot.length === 2) {
        posMap.set(slot[0], { x: curX, y: yPos })
        posMap.set(slot[1], { x: curX + NODE_W + H_GAP / 2, y: yPos })
        curX += NODE_W * 2 + H_GAP / 2 + H_GAP
      } else {
        posMap.set(slot[0], { x: curX, y: yPos })
        curX += NODE_W + H_GAP
      }
    }

    void parentsOf // suppress unused warning
  }

  return posMap
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
  const initials = person.displayName.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()
  const claims = store.getClaimsForPerson(pubkey)
  const endorsements = store.getAllEndorsements()
  const resolutions = resolveAllFields(claims, endorsements)
  const born  = resolutions.find(r => r.field === 'born')?.winningClaim?.value
  const died  = resolutions.find(r => r.field === 'died')?.winningClaim?.value
  const place = resolutions.find(r => r.field === 'birthplace')?.winningClaim?.value

  return (
    <div style={{
      position: 'absolute', top: 0, right: 0,
      width: 280, height: '100%',
      background: '#fff',
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
        <ActionButton icon="✏️" label="Edit information"    description="Update facts, dates and relationships" onClick={() => onEdit(pubkey)} />
        <ActionButton icon="📋" label="View full profile"   description="See all claims and conflict history"   onClick={() => onViewInList(pubkey)} />
        <div style={{ borderTop: '1px solid var(--border-soft)', margin: '4px 0' }} />
        <ActionButton icon="🖼"  label="Photos & media"     description="View and add photos for this person"   onClick={() => {}} comingSoon />
        <ActionButton icon="📖" label="Stories"             description="Personal stories and memories"         onClick={() => {}} comingSoon />
        <ActionButton icon="📄" label="Documents"           description="Birth certificates, records and sources" onClick={() => {}} comingSoon />
        <ActionButton icon="🌍" label="Timeline"            description="Life events on a timeline"             onClick={() => {}} comingSoon />
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

    // ── Layout ────────────────────────────────────────────────────────────────
    const genMap = assignGenerations(rootPubkey, nodes, edges)
    const posMap = computeLayout(nodes, genMap, edges, rootPubkey)

    const nodeMap = new Map<string, NodeData>()
    for (const pk of nodes) {
      const nd = buildNodeData(pk)
      const pos = posMap.get(pk) ?? { x: 0, y: 0 }
      nd.x = pos.x; nd.y = pos.y
      nodeMap.set(pk, nd)
    }

    // ── Edges ─────────────────────────────────────────────────────────────────
    // Rule: one line per edge. Spouse = horizontal between nodes.
    // Parent→child = elbow from bottom of parent to top of child.
    // Sibling edges skipped — siblings are connected through shared parents.
    // Duplicate parent/child edges (both directions stored) are deduplicated
    // by only drawing when fromNode is above toNode (y is lower number).

    const edgeGroup = g.append('g')
    const drawnParentEdges = new Set<string>() // avoid drawing A→B and B→A both

    for (const edge of edges) {
      if (edge.relationship === 'sibling') continue

      const fromNode = nodeMap.get(edge.fromPubkey)
      const toNode   = nodeMap.get(edge.toPubkey)
      if (!fromNode || !toNode) continue

      if (edge.relationship === 'spouse') {
        // Only draw once per pair
        const key = [edge.fromPubkey, edge.toPubkey].sort().join('|')
        if (drawnParentEdges.has(key)) continue
        drawnParentEdges.add(key)

        const status = edge.meta?.status
        const dash   = (status === 'married') ? undefined : '6,3'
        const stroke = edge.sensitive ? '#c5b89a' : '#c9a96e'
        const x1 = fromNode.x + (fromNode.x <= toNode.x ? NODE_W / 2 : -NODE_W / 2)
        const x2 = toNode.x   + (fromNode.x <= toNode.x ? -NODE_W / 2 : NODE_W / 2)
        const y  = (fromNode.y + toNode.y) / 2
        edgeGroup.append('line')
          .attr('x1', x1).attr('y1', y).attr('x2', x2).attr('y2', y)
          .attr('stroke', stroke).attr('stroke-dasharray', dash ?? null)
          .attr('stroke-width', 1.5).attr('opacity', 0.7)
        continue
      }

      // Parent→child: figure out which is parent, which is child
      let parentNode: NodeData, childNode: NodeData
      if (edge.relationship === 'parent') {
        parentNode = fromNode; childNode = toNode
      } else {
        // 'child' edge: subject (from) is child, to is parent
        parentNode = toNode; childNode = fromNode
      }

      // Deduplicate — only draw if we haven't already drawn this parent→child pair
      const edgeKey = `${parentNode.pubkey}→${childNode.pubkey}`
      if (drawnParentEdges.has(edgeKey)) continue
      drawnParentEdges.add(edgeKey)

      // Only draw downward connectors
      if (parentNode.y >= childNode.y) continue

      const x1 = parentNode.x
      const y1 = parentNode.y + NODE_H / 2
      const x2 = childNode.x
      const y2 = childNode.y - NODE_H / 2
      const midY = (y1 + y2) / 2
      const stroke = '#c9a96e'

      if (Math.abs(x1 - x2) < 2) {
        edgeGroup.append('line')
          .attr('x1', x1).attr('y1', y1).attr('x2', x2).attr('y2', y2)
          .attr('stroke', stroke).attr('stroke-width', 1.5)
      } else {
        const dx = x2 > x1 ? 1 : -1
        const cr = Math.min(CORNER_R, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2)
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
    const defs = svg.append('defs')
    defs.append('filter').attr('id', 'node-shadow')
      .append('feDropShadow')
      .attr('dx', 0).attr('dy', 1).attr('stdDeviation', 3)
      .attr('flood-color', 'rgba(15,30,53,0.10)')

    const nodeGroup = g.append('g')
    const nodeElems = nodeGroup.selectAll<SVGGElement, NodeData>('g.node')
      .data(Array.from(nodeMap.values()), d => d.pubkey)
      .join('g').attr('class', 'node')
      .attr('transform', d => `translate(${d.x - NODE_W / 2},${d.y - NODE_H / 2})`)
      .style('cursor', 'pointer')
      .on('click', (_event, d) => {
        setSelectedPubkey(prev => prev === d.pubkey ? null : d.pubkey)
      })

    // Card background
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

    // Living dot
    nodeElems.filter(d => d.isLiving)
      .append('circle')
      .attr('cx', NODE_W - 10).attr('cy', 10).attr('r', 3.5).attr('fill', '#4caf78')

    // Name
    nodeElems.append('text')
      .attr('x', NODE_W / 2).attr('y', 24)
      .attr('text-anchor', 'middle')
      .attr('font-size', 13).attr('font-family', 'Lora, Georgia, serif').attr('font-weight', '600')
      .attr('fill', d => d.pubkey === rootPubkey ? 'var(--gold-light)' : 'var(--navy)')
      .text(d => d.displayName.length > 22 ? d.displayName.slice(0, 20) + '…' : d.displayName)

    // Dates
    nodeElems.append('text')
      .attr('x', NODE_W / 2).attr('y', 42)
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
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16, padding: '8px 16px',
        borderBottom: '1px solid var(--border-soft)', background: '#fff',
        fontSize: 13, color: 'var(--ink-muted)', flexShrink: 0,
      }}>
        <span>{nodeCount} {nodeCount === 1 ? 'person' : 'people'}</span>
        {truncated && <span style={{ color: 'var(--gold)', fontWeight: 500 }}>⚠ Tree truncated — zoom out to see more</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 16, alignItems: 'center', fontSize: 11 }}>
          <LegendItem color="var(--gold)"  label="Married" />
          <LegendItem color="var(--gold)"  dash="6,3" label="Partner / divorced" />
          <LegendItem color="#c5b89a" dash="4,4" label="Sensitive" />
        </div>
        <span style={{ color: 'var(--border)', fontSize: 11 }}>Scroll to zoom · Drag to pan · Click to select</span>
      </div>

      {/* Canvas */}
      <div ref={containerRef} style={{ flex: 1, position: 'relative', overflow: 'hidden', background: 'var(--cream)' }}>
        <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
        {selectedPubkey && (
          <ActionPanel
            pubkey={selectedPubkey}
            onClose={handleClosePanel}
            onEdit={pk => { onEditPerson?.(pk); handleClosePanel() }}
            onViewInList={pk => { onSelectPerson?.(pk) }}
          />
        )}
      </div>
    </div>
  )
}
