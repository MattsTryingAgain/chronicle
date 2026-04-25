/**
 * FamilyTreeView — Generational family tree layout
 *
 * Replaces the force-directed layout with a proper hierarchical layout:
 * - Generations assigned by BFS from root (parent = up, child = down, spouse = same row)
 * - Each generation rendered as a horizontal row
 * - Parent–child edges drawn as vertical connectors with horizontal brackets
 * - Spouse edges drawn as a short horizontal line between adjacent nodes
 * - Zoom + pan via D3
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
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
}

// ─── Constants ────────────────────────────────────────────────────────────────

const NODE_W       = 180
const NODE_H       = 64
const H_GAP        = 32   // horizontal gap between nodes in same generation
const V_GAP        = 100  // vertical gap between generations
const CORNER_R     = 10   // radius on connector elbows

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

/**
 * Assign a generation number to each node via BFS.
 *
 * Edge semantics: GraphEdge.relationship describes what fromPubkey IS TO toPubkey.
 * e.g. fromPubkey=Matt, toPubkey=Layla, relationship='parent' → Matt is parent of Layla
 *      → from Matt's perspective, Layla is gen+1 (descendant)
 *      → from Layla's perspective, Matt is gen-1 (ancestor)
 *
 * When traversing from `current`:
 *   - If current === fromPubkey: relationship describes current→neighbour
 *       parent/grandparent → neighbour is gen+1 (current is above)
 *       child/grandchild   → neighbour is gen-1 (current is below)
 *   - If current === toPubkey: relationship describes neighbour→current (inverse)
 *       parent/grandparent → neighbour is gen-1 (neighbour is above current)
 *       child/grandchild   → neighbour is gen+1 (neighbour is below current)
 */
function assignGenerations(
  rootPubkey: string,
  nodes: string[],
  edges: GraphEdge[],
): Map<string, number> {
  const genMap = new Map<string, number>()
  genMap.set(rootPubkey, 0)

  // Build direction-aware adjacency
  const adj = new Map<string, Array<{ neighbour: string; rel: string; asSubject: boolean }>>()
  for (const n of nodes) adj.set(n, [])
  for (const e of edges) {
    // fromPubkey is subject of the relationship
    adj.get(e.fromPubkey)?.push({ neighbour: e.toPubkey, rel: e.relationship, asSubject: true })
    // toPubkey is the object — sees inverse
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
        // current IS rel TO neighbour
        // e.g. current=parent of neighbour → neighbour is one gen below
        if (rel === 'parent' || rel === 'grandparent') delta = 1   // neighbour is child/grandchild
        else if (rel === 'child' || rel === 'grandchild') delta = -1 // neighbour is parent/grandparent
      } else {
        // neighbour IS rel TO current (inverse perspective)
        // e.g. neighbour=parent of current → neighbour is one gen above
        if (rel === 'parent' || rel === 'grandparent') delta = -1  // neighbour is ancestor
        else if (rel === 'child' || rel === 'grandchild') delta = 1  // neighbour is descendant
      }
      // spouse, sibling → delta = 0
      genMap.set(neighbour, currentGen + delta)
      queue.push(neighbour)
    }
  }

  // Any nodes unreached get generation 0
  for (const n of nodes) {
    if (!genMap.has(n)) genMap.set(n, 0)
  }

  return genMap
}

/**
 * Assign x/y positions. Groups nodes by generation, sorts within each
 * generation to minimise edge crossings (root-adjacent nodes centred),
 * then spaces evenly.
 */
function computeLayout(
  nodes: string[],
  genMap: Map<string, number>,
  rootPubkey: string,
): Map<string, { x: number; y: number }> {
  // Group by generation
  const byGen = new Map<number, string[]>()
  for (const n of nodes) {
    const g = genMap.get(n) ?? 0
    if (!byGen.has(g)) byGen.set(g, [])
    byGen.get(g)!.push(n)
  }

  // Shift generations so the minimum is 0
  const gens = Array.from(byGen.keys()).sort((a, b) => a - b)
  const minGen = gens[0] ?? 0

  // Position root's generation at y=0; ancestors above, descendants below
  const posMap = new Map<string, { x: number; y: number }>()

  for (const gen of gens) {
    const members = byGen.get(gen)!
    // Put root first in its generation row
    const sorted = [...members].sort((a, b) =>
      a === rootPubkey ? -1 : b === rootPubkey ? 1 : 0
    )
    const totalWidth = sorted.length * (NODE_W + H_GAP) - H_GAP
    const startX = -totalWidth / 2 + NODE_W / 2
    const y = (gen - minGen) * (NODE_H + V_GAP)
    sorted.forEach((pk, i) => {
      posMap.set(pk, { x: startX + i * (NODE_W + H_GAP), y })
    })
  }

  return posMap
}

function edgeStyle(edge: GraphEdge): { stroke: string; dash: string; width: number } {
  if (edge.sensitive) return { stroke: '#8a8a8a', dash: '4,4', width: 1.5 }
  if (edge.relationship === 'spouse') return { stroke: '#c9a96e', dash: '6,3', width: 1.5 }
  if (!edge.acknowledged) return { stroke: '#7090b8', dash: '6,3', width: 1.5 }
  return { stroke: '#c9a96e', dash: 'none', width: 2 }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function FamilyTreeView({ rootPubkey, onSelectPerson }: FamilyTreeViewProps) {
  const { t } = useTranslation()
  const svgRef = useRef<SVGSVGElement>(null)
  const [truncated, setTruncated] = useState(false)
  const [nodeCount, setNodeCount] = useState(0)
  const [selectedPubkey, setSelectedPubkey] = useState<string | null>(null)

  const draw = useCallback(() => {
    if (!svgRef.current) return
    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const { nodes, edges, truncated: trunc } = traverseGraph(rootPubkey, {
      maxDepth: 6,
      maxNodes: 150,
    })
    setTruncated(trunc)
    setNodeCount(nodes.length)
    if (nodes.length === 0) return

    const container = svgRef.current.parentElement
    const width  = container?.clientWidth  || 900
    const height = container?.clientHeight || 600

    svg.attr('width', width).attr('height', height)

    // Defs: arrowheads
    const defs = svg.append('defs')
    ;[
      { id: 'arr-gold', color: '#c9a96e' },
      { id: 'arr-blue', color: '#7090b8' },
    ].forEach(({ id, color }) => {
      defs.append('marker')
        .attr('id', id).attr('viewBox', '0 -5 10 10')
        .attr('refX', NODE_W / 2 + 8).attr('refY', 0)
        .attr('markerWidth', 6).attr('markerHeight', 6)
        .attr('orient', 'auto')
        .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', color)
    })

    const g = svg.append('g')

    // Zoom + pan
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 3])
      .on('zoom', event => g.attr('transform', event.transform))
    svg.call(zoom)

    // ── Layout ────────────────────────────────────────────────────────────────
    const genMap = assignGenerations(rootPubkey, nodes, edges)
    const posMap = computeLayout(nodes, genMap, rootPubkey)

    // Build node data
    const nodeDataMap = new Map<string, NodeData>()
    for (const pk of nodes) {
      const nd = buildNodeData(pk, genMap.get(pk) ?? 0)
      const pos = posMap.get(pk) ?? { x: 0, y: 0 }
      nd.x = pos.x
      nd.y = pos.y
      nodeDataMap.set(pk, nd)
    }

    // ── Draw edges ────────────────────────────────────────────────────────────
    const edgeGroup = g.append('g').attr('class', 'edges')

    for (const edge of edges) {
      const from = nodeDataMap.get(edge.fromPubkey)
      const to   = nodeDataMap.get(edge.toPubkey)
      if (!from || !to) continue

      const style = edgeStyle(edge)
      const isSpouse = edge.relationship === 'spouse' || edge.relationship === 'sibling'

      if (isSpouse) {
        // Simple horizontal line between same-generation nodes
        const x1 = from.x + (from.x < to.x ? NODE_W / 2 : -NODE_W / 2)
        const x2 = to.x   + (from.x < to.x ? -NODE_W / 2 : NODE_W / 2)
        const y  = (from.y + to.y) / 2 + NODE_H / 2 - 8
        edgeGroup.append('line')
          .attr('x1', x1).attr('y1', y)
          .attr('x2', x2).attr('y2', y)
          .attr('stroke', style.stroke)
          .attr('stroke-dasharray', style.dash)
          .attr('stroke-width', style.width)
          .attr('opacity', 0.7)
      } else {
        // Vertical connector with elbow: parent bottom-center → child top-center
        const fromBelow = from.y < to.y  // from is ancestor
        const x1 = from.x
        const y1 = from.y + (fromBelow ? NODE_H / 2 : -NODE_H / 2)
        const x2 = to.x
        const y2 = to.y   + (fromBelow ? -NODE_H / 2 : NODE_H / 2)
        const midY = (y1 + y2) / 2

        if (Math.abs(x1 - x2) < 4) {
          // Straight vertical
          edgeGroup.append('line')
            .attr('x1', x1).attr('y1', y1)
            .attr('x2', x2).attr('y2', y2)
            .attr('stroke', style.stroke)
            .attr('stroke-dasharray', style.dash)
            .attr('stroke-width', style.width)
        } else {
          // Elbow path
          const r = Math.min(CORNER_R, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2)
          const dx = x2 > x1 ? 1 : -1
          const dy = fromBelow ? 1 : -1
          const path = [
            `M ${x1} ${y1}`,
            `L ${x1} ${midY - dy * r}`,
            `Q ${x1} ${midY} ${x1 + dx * r} ${midY}`,
            `L ${x2 - dx * r} ${midY}`,
            `Q ${x2} ${midY} ${x2} ${midY + dy * r}`,
            `L ${x2} ${y2}`,
          ].join(' ')
          edgeGroup.append('path')
            .attr('d', path)
            .attr('fill', 'none')
            .attr('stroke', style.stroke)
            .attr('stroke-dasharray', style.dash)
            .attr('stroke-width', style.width)
        }
      }
    }

    // ── Draw nodes ────────────────────────────────────────────────────────────
    const nodeGroup = g.append('g').attr('class', 'nodes')

    const nodeElems = nodeGroup.selectAll<SVGGElement, NodeData>('g.tree-node')
      .data(Array.from(nodeDataMap.values()), d => d.pubkey)
      .join('g')
      .attr('class', 'tree-node')
      .attr('transform', d => `translate(${d.x},${d.y})`)
      .style('cursor', 'pointer')
      .on('click', (_event, d) => {
        setSelectedPubkey(d.pubkey)
        onSelectPerson?.(d.pubkey)
        draw()
      })

    // Drop shadow
    defs.append('filter').attr('id', 'shadow')
      .append('feDropShadow')
      .attr('dx', 0).attr('dy', 2)
      .attr('stdDeviation', 4)
      .attr('flood-color', 'rgba(0,0,0,0.5)')

    // Card background
    nodeElems.append('rect')
      .attr('x', -NODE_W / 2).attr('y', -NODE_H / 2)
      .attr('width', NODE_W).attr('height', NODE_H)
      .attr('rx', 10)
      .attr('filter', 'url(#shadow)')
      .attr('fill', d => {
        if (d.pubkey === rootPubkey) return '#1e3060'
        if (d.pubkey === selectedPubkey) return '#1a2a50'
        return '#101e3a'
      })
      .attr('stroke', d => {
        if (d.hasConflict) return '#d06040'
        if (d.pubkey === rootPubkey) return '#c9a96e'
        if (d.pubkey === selectedPubkey) return '#8ca6c8'
        return '#263354'
      })
      .attr('stroke-width', d => (d.pubkey === rootPubkey || d.pubkey === selectedPubkey) ? 2 : 1)

    // Living indicator
    nodeElems.filter(d => d.isLiving)
      .append('circle')
      .attr('cx', NODE_W / 2 - 10).attr('cy', -NODE_H / 2 + 10)
      .attr('r', 4).attr('fill', '#4caf78')

    // Conflict indicator
    nodeElems.filter(d => d.hasConflict)
      .append('text')
      .attr('x', -NODE_W / 2 + 8).attr('y', -NODE_H / 2 + 14)
      .attr('font-size', 11).attr('fill', '#d06040').text('⚠')

    // Name
    nodeElems.append('text')
      .attr('y', -8)
      .attr('text-anchor', 'middle')
      .attr('font-size', 14)
      .attr('font-family', 'Lora, Georgia, serif')
      .attr('fill', d => d.pubkey === rootPubkey ? '#c9a96e' : '#e8e0d0')
      .attr('font-weight', d => d.pubkey === rootPubkey ? 'bold' : 'normal')
      .text(d => d.displayName.length > 22 ? d.displayName.slice(0, 20) + '…' : d.displayName)

    // Dates
    nodeElems.append('text')
      .attr('y', 14)
      .attr('text-anchor', 'middle')
      .attr('font-size', 11)
      .attr('fill', '#7090b0')
      .text(d => {
        if (d.birthYear && d.deathYear) return `${d.birthYear} – ${d.deathYear}`
        if (d.birthYear) return `b. ${d.birthYear}`
        return ''
      })

    // Generation label (faint, for orientation)
    const gens = Array.from(new Set(Array.from(genMap.values()))).sort((a, b) => a - b)
    const minGen = gens[0] ?? 0
    for (const gen of gens) {
      const yPos = (gen - minGen) * (NODE_H + V_GAP)
      g.append('text')
        .attr('x', -width / 2 + 8)
        .attr('y', yPos + 4)
        .attr('font-size', 10)
        .attr('fill', '#2a3a5a')
        .attr('font-family', 'sans-serif')
        .text(gen < 0 ? `Gen ${gen}` : gen === 0 ? 'You' : `Gen +${gen}`)
    }

    // ── Initial zoom to fit ────────────────────────────────────────────────────
    const allPos = Array.from(posMap.values())
    if (allPos.length > 0) {
      const xs = allPos.map(p => p.x)
      const ys = allPos.map(p => p.y)
      const minX = Math.min(...xs) - NODE_W / 2 - 32
      const maxX = Math.max(...xs) + NODE_W / 2 + 32
      const minY = Math.min(...ys) - NODE_H / 2 - 32
      const maxY = Math.max(...ys) + NODE_H / 2 + 32
      const contentW = maxX - minX
      const contentH = maxY - minY
      const scale = Math.min(0.95, Math.min(width / contentW, height / contentH))
      const tx = width / 2  - scale * (minX + contentW / 2)
      const ty = height / 2 - scale * (minY + contentH / 2)
      svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale))
    }

  }, [rootPubkey, selectedPubkey, onSelectPerson])

  useEffect(() => { draw() }, [draw])

  useEffect(() => {
    const handler = () => draw()
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [draw])

  return (
    <div className="family-tree-view d-flex flex-column h-100">
      {/* Toolbar */}
      <div className="d-flex align-items-center gap-3 px-3 py-2 border-bottom border-secondary">
        <span className="text-muted small">
          {nodeCount} {nodeCount === 1 ? 'person' : 'people'} shown
        </span>
        {truncated && (
          <span className="badge text-bg-warning">
            {t('tree.truncated', { defaultValue: 'Tree truncated — zoom out to see more' })}
          </span>
        )}
        <div className="ms-auto d-flex gap-3 align-items-center small text-muted">
          <span>
            <svg width="24" height="8">
              <line x1="0" y1="4" x2="24" y2="4" stroke="#c9a96e" strokeWidth="2" />
            </svg>
            {' '}Confirmed
          </span>
          <span>
            <svg width="24" height="8">
              <line x1="0" y1="4" x2="24" y2="4" stroke="#7090b8" strokeWidth="1.5" strokeDasharray="6,3" />
            </svg>
            {' '}Unconfirmed
          </span>
          <span>
            <svg width="24" height="8">
              <line x1="0" y1="4" x2="24" y2="4" stroke="#8a8a8a" strokeWidth="1.5" strokeDasharray="4,4" />
            </svg>
            {' '}Sensitive
          </span>
          <span>
            <svg width="24" height="8">
              <line x1="0" y1="4" x2="24" y2="4" stroke="#c9a96e" strokeWidth="1.5" strokeDasharray="6,3" />
            </svg>
            {' '}Spouse
          </span>
          <span style={{ color: '#d06040' }}>⚠</span>
          {' '}Conflict
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-grow-1 position-relative overflow-hidden" style={{ background: '#080f1e' }}>
        <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
        <div className="position-absolute bottom-0 end-0 p-2 text-muted" style={{ fontSize: '0.7rem' }}>
          Scroll to zoom · Drag to pan · Click a node to view profile
        </div>
      </div>
    </div>
  )
}
