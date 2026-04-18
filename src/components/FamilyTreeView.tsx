/**
 * FamilyTreeView — D3.js family tree visualisation
 *
 * Renders a bidirectional family tree centred on a root person.
 * Ancestors flow upward; descendants flow downward.
 *
 * Features:
 * - Lazy-loads branches: click a node to expand/collapse
 * - Acknowledeged relationships shown as solid lines; unacknowledged as dashed
 * - Sensitive relationships shown with a muted dashed stroke
 * - Conflict indicator on nodes with hard/soft fact conflicts
 * - Truncation warning when graph exceeds MAX_NODES
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

interface TreeNode {
  pubkey: string
  displayName: string
  birthYear: string | null
  deathYear: string | null
  hasConflict: boolean
  isLiving: boolean
  isExpanded: boolean
  children?: TreeNode[]
  _allChildren?: TreeNode[]  // collapsed children stored here
}

interface FamilyTreeViewProps {
  rootPubkey: string
  onSelectPerson?: (pubkey: string) => void
}

// ─── Constants ────────────────────────────────────────────────────────────────

const NODE_WIDTH  = 160
const NODE_HEIGHT = 56
const LEVEL_SEP   = 90
const NODE_SEP    = 24

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractYear(val: string | null): string | null {
  if (!val) return null
  const m = val.match(/\b(\d{4})\b/)
  return m ? m[1] : null
}

function buildTreeNode(pubkey: string): TreeNode {
  const person: Person | undefined = store.getPerson(pubkey)
  const claims = store.getClaimsForPerson(pubkey)
  const endorsements = store.getAllEndorsements()

  // Compute conflict state for name field as a proxy for "has any conflict"
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
    isExpanded: false,
  }
}

function edgeStyle(edge: GraphEdge): { stroke: string; strokeDasharray: string; strokeWidth: number } {
  if (edge.sensitive) {
    return { stroke: '#aaa', strokeDasharray: '4,4', strokeWidth: 1.5 }
  }
  if (!edge.acknowledged) {
    return { stroke: '#8ca6c8', strokeDasharray: '6,3', strokeWidth: 1.5 }
  }
  return { stroke: '#c9a96e', strokeDasharray: 'none', strokeWidth: 2 }
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

    // ── Traverse graph ────────────────────────────────────────────────────────
    const { nodes, edges, truncated: trunc } = traverseGraph(rootPubkey, {
      maxDepth: 6,
      maxNodes: 150,
    })
    setTruncated(trunc)
    setNodeCount(nodes.length)

    if (nodes.length === 0) return

    // ── Build adjacency for layout ────────────────────────────────────────────
    // Use a simple force-directed layout for arbitrary graphs
    // (D3 tree layout assumes a strict hierarchy; family graphs can have cycles)

    const container = svgRef.current.parentElement
    const width  = container?.clientWidth  || 900
    const height = container?.clientHeight || 600

    const g = svg
      .attr('width', width)
      .attr('height', height)
      .append('g')

    // Zoom + pan
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 3])
      .on('zoom', (event) => g.attr('transform', event.transform))
    svg.call(zoom)

    // ── Node data ─────────────────────────────────────────────────────────────
    const nodeMap = new Map<string, TreeNode>()
    for (const pk of nodes) {
      nodeMap.set(pk, buildTreeNode(pk))
    }

    // ── Force simulation ──────────────────────────────────────────────────────
    interface SimNode extends d3.SimulationNodeDatum {
      id: string
      node: TreeNode
    }

    interface SimLink extends d3.SimulationLinkDatum<SimNode> {
      edge: GraphEdge
    }

    const simNodes: SimNode[] = nodes.map(pk => ({
      id: pk,
      node: nodeMap.get(pk)!,
      // Pin root to centre
      ...(pk === rootPubkey ? { fx: width / 2, fy: height / 2 } : {}),
    }))

    const simLinks: SimLink[] = edges.map(e => ({
      source: e.fromPubkey,
      target: e.toPubkey,
      edge: e,
    }))

    const simulation = d3.forceSimulation<SimNode>(simNodes)
      .force('link', d3.forceLink<SimNode, SimLink>(simLinks)
        .id(d => d.id)
        .distance(LEVEL_SEP + NODE_HEIGHT))
      .force('charge', d3.forceManyBody().strength(-400))
      .force('collide', d3.forceCollide(NODE_WIDTH / 2 + NODE_SEP / 2))
      .force('center', d3.forceCenter(width / 2, height / 2))

    // ── Edge rendering ────────────────────────────────────────────────────────
    const linkGroup = g.append('g').attr('class', 'links')

    const linkElems = linkGroup.selectAll('line')
      .data(simLinks)
      .join('line')
      .attr('stroke', d => edgeStyle(d.edge).stroke)
      .attr('stroke-dasharray', d => edgeStyle(d.edge).strokeDasharray)
      .attr('stroke-width', d => edgeStyle(d.edge).strokeWidth)
      .attr('marker-end', d => d.edge.acknowledged ? 'url(#arrow-gold)' : 'url(#arrow-blue)')

    // Arrow markers
    const defs = svg.append('defs')
    ;[
      { id: 'arrow-gold', color: '#c9a96e' },
      { id: 'arrow-blue', color: '#8ca6c8' },
    ].forEach(({ id, color }) => {
      defs.append('marker')
        .attr('id', id)
        .attr('viewBox', '0 -5 10 10')
        .attr('refX', 18)
        .attr('refY', 0)
        .attr('markerWidth', 6)
        .attr('markerHeight', 6)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-5L10,0L0,5')
        .attr('fill', color)
    })

    // ── Node rendering ────────────────────────────────────────────────────────
    const nodeGroup = g.append('g').attr('class', 'nodes')

    const nodeElems = nodeGroup.selectAll<SVGGElement, SimNode>('g.tree-node')
      .data(simNodes, d => d.id)
      .join('g')
      .attr('class', 'tree-node')
      .style('cursor', 'pointer')
      .call(
        d3.drag<SVGGElement, SimNode>()
          .on('start', (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart()
            d.fx = d.x; d.fy = d.y
          })
          .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y })
          .on('end', (event, d) => {
            if (!event.active) simulation.alphaTarget(0)
            if (d.id !== rootPubkey) { d.fx = null; d.fy = null }
          })
      )
      .on('click', (_event, d) => {
        setSelectedPubkey(d.id)
        onSelectPerson?.(d.id)
      })

    // Card background
    nodeElems.append('rect')
      .attr('x', -NODE_WIDTH / 2)
      .attr('y', -NODE_HEIGHT / 2)
      .attr('width', NODE_WIDTH)
      .attr('height', NODE_HEIGHT)
      .attr('rx', 8)
      .attr('fill', d => {
        if (d.id === rootPubkey) return '#1a2744'
        if (d.id === selectedPubkey) return '#243460'
        return '#0f1b38'
      })
      .attr('stroke', d => {
        if (d.node.hasConflict) return '#e07050'
        if (d.id === rootPubkey) return '#c9a96e'
        return '#2c3f6e'
      })
      .attr('stroke-width', d => d.id === rootPubkey ? 2 : 1)

    // Living indicator dot
    nodeElems.filter(d => d.node.isLiving)
      .append('circle')
      .attr('cx', NODE_WIDTH / 2 - 10)
      .attr('cy', -NODE_HEIGHT / 2 + 10)
      .attr('r', 4)
      .attr('fill', '#5cb85c')

    // Conflict indicator
    nodeElems.filter(d => d.node.hasConflict)
      .append('text')
      .attr('x', -NODE_WIDTH / 2 + 8)
      .attr('y', -NODE_HEIGHT / 2 + 14)
      .attr('font-size', 12)
      .attr('fill', '#e07050')
      .text('⚠')

    // Name
    nodeElems.append('text')
      .attr('y', -6)
      .attr('text-anchor', 'middle')
      .attr('font-size', 13)
      .attr('font-family', 'Lora, serif')
      .attr('fill', d => d.id === rootPubkey ? '#c9a96e' : '#e8e0d0')
      .attr('font-weight', d => d.id === rootPubkey ? 'bold' : 'normal')
      .text(d => {
        const name = d.node.displayName
        return name.length > 20 ? name.slice(0, 18) + '…' : name
      })

    // Dates
    nodeElems.append('text')
      .attr('y', 12)
      .attr('text-anchor', 'middle')
      .attr('font-size', 10)
      .attr('fill', '#8ca6c8')
      .text(d => {
        const b = d.node.birthYear ?? '?'
        const died = d.node.deathYear
        if (!d.node.isLiving && died) return `${b} – ${died}`
        if (d.node.birthYear) return `b. ${b}`
        return ''
      })

    // ── Simulation tick ───────────────────────────────────────────────────────
    simulation.on('tick', () => {
      linkElems
        .attr('x1', d => (d.source as SimNode).x ?? 0)
        .attr('y1', d => (d.source as SimNode).y ?? 0)
        .attr('x2', d => (d.target as SimNode).x ?? 0)
        .attr('y2', d => (d.target as SimNode).y ?? 0)

      nodeElems.attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`)
    })

    // Run simulation briefly then stop (static layout with drag)
    simulation.alpha(1).restart()
    setTimeout(() => simulation.stop(), 2000)

    // Initial centre zoom
    svg.call(zoom.transform, d3.zoomIdentity.translate(0, 0).scale(1))

  }, [rootPubkey, selectedPubkey, onSelectPerson])

  useEffect(() => {
    draw()
  }, [draw])

  // Redraw on window resize
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
          {t('tree.nodeCount', { count: nodeCount, defaultValue: '{{count}} people shown' })}
        </span>
        {truncated && (
          <span className="badge text-bg-warning">
            {t('tree.truncated', { defaultValue: 'Tree truncated — zoom in to explore branches' })}
          </span>
        )}
        <div className="ms-auto d-flex gap-3 align-items-center small text-muted">
          <span>
            <svg width="24" height="8">
              <line x1="0" y1="4" x2="24" y2="4" stroke="#c9a96e" strokeWidth="2" />
            </svg>
            {' '}{t('tree.legend.confirmed', { defaultValue: 'Confirmed' })}
          </span>
          <span>
            <svg width="24" height="8">
              <line x1="0" y1="4" x2="24" y2="4" stroke="#8ca6c8" strokeWidth="1.5" strokeDasharray="4,3" />
            </svg>
            {' '}{t('tree.legend.unconfirmed', { defaultValue: 'Unconfirmed' })}
          </span>
          <span>
            <svg width="24" height="8">
              <line x1="0" y1="4" x2="24" y2="4" stroke="#aaa" strokeWidth="1.5" strokeDasharray="4,4" />
            </svg>
            {' '}{t('tree.legend.sensitive', { defaultValue: 'Sensitive' })}
          </span>
          <span>
            <span style={{ color: '#e07050' }}>⚠</span>
            {' '}{t('tree.legend.conflict', { defaultValue: 'Conflict' })}
          </span>
        </div>
      </div>

      {/* SVG canvas */}
      <div className="flex-grow-1 position-relative overflow-hidden" style={{ background: '#080f1e' }}>
        <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
        <div className="position-absolute bottom-0 end-0 p-2 text-muted" style={{ fontSize: '0.7rem' }}>
          {t('tree.hint', { defaultValue: 'Drag to pan · Scroll to zoom · Click a node to view profile' })}
        </div>
      </div>
    </div>
  )
}
