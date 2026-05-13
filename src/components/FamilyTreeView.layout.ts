/**
 * Pure layout functions for FamilyTreeView.
 *
 * Extracted into its own module so the algorithm can be unit-tested without
 * spinning up React or D3. All functions in here are pure: input → output,
 * no side effects, no DOM. See FamilyTreeView.tsx for the rendering code
 * that consumes these results.
 *
 * The exports prefixed with __test_ are intended for the test suite — they
 * are stable, but the test prefix makes their purpose obvious.
 */

import type { GraphEdge } from '../lib/graph'

// ─── Tunables ─────────────────────────────────────────────────────────────────

export const NODE_W     = 180
export const NODE_H     = 64
export const H_GAP      = 56
export const COUPLE_GAP = 12
export const V_GAP      = 110

// ─── Edge types ───────────────────────────────────────────────────────────────

export interface ParentChildEdge { parent: string; child: string; sensitive: boolean }
export interface SpouseEdge { a: string; b: string; sensitive: boolean; status?: string }
export interface SiblingEdge { a: string; b: string }

export interface NormalisedEdges {
  parentChild: ParentChildEdge[]
  spouses: SpouseEdge[]
  siblings: SiblingEdge[]
}

// ─── Edge normalisation ───────────────────────────────────────────────────────
// traverseGraph returns BOTH directions of every relationship; we collapse
// each unordered pair to at most one parent-child OR one spouse OR one sibling.

function normaliseEdges(edges: GraphEdge[]): NormalisedEdges {
  const pcMap = new Map<string, ParentChildEdge>()
  const spouseMap = new Map<string, SpouseEdge>()
  const sibMap = new Map<string, SiblingEdge>()
  const pairKey = (a: string, b: string) => a < b ? `${a}|${b}` : `${b}|${a}`

  for (const e of edges) {
    if (e.relationship === 'parent') {
      const key = pairKey(e.fromPubkey, e.toPubkey)
      if (!pcMap.has(key)) {
        pcMap.set(key, { parent: e.fromPubkey, child: e.toPubkey, sensitive: e.sensitive })
      }
    } else if (e.relationship === 'child') {
      const key = pairKey(e.fromPubkey, e.toPubkey)
      if (!pcMap.has(key)) {
        pcMap.set(key, { parent: e.toPubkey, child: e.fromPubkey, sensitive: e.sensitive })
      }
    } else if (e.relationship === 'spouse') {
      const key = pairKey(e.fromPubkey, e.toPubkey)
      if (!spouseMap.has(key)) {
        spouseMap.set(key, {
          a: e.fromPubkey, b: e.toPubkey,
          sensitive: e.sensitive,
          status: e.meta?.status,
        })
      }
    } else if (e.relationship === 'sibling') {
      const key = pairKey(e.fromPubkey, e.toPubkey)
      if (!sibMap.has(key)) {
        sibMap.set(key, { a: e.fromPubkey, b: e.toPubkey })
      }
    }
  }

  return {
    parentChild: Array.from(pcMap.values()),
    spouses: Array.from(spouseMap.values()),
    siblings: Array.from(sibMap.values()),
  }
}

// ─── Generation assignment ────────────────────────────────────────────────────
// BFS from the root, walking parent-child edges (and spouse edges, which
// share a generation). Root is generation 0. Parents are -1, children +1.

function assignGenerations(
  rootPubkey: string,
  nodes: string[],
  pc: ParentChildEdge[],
  spouses: SpouseEdge[],
): Map<string, number> {
  const adj = new Map<string, Array<{ neighbour: string; delta: number }>>()
  for (const n of nodes) adj.set(n, [])

  for (const e of pc) {
    adj.get(e.parent)?.push({ neighbour: e.child, delta: +1 })
    adj.get(e.child)?.push({ neighbour: e.parent, delta: -1 })
  }
  for (const s of spouses) {
    adj.get(s.a)?.push({ neighbour: s.b, delta: 0 })
    adj.get(s.b)?.push({ neighbour: s.a, delta: 0 })
  }

  const gen = new Map<string, number>()
  gen.set(rootPubkey, 0)
  const queue: string[] = [rootPubkey]
  while (queue.length > 0) {
    const cur = queue.shift()!
    const g = gen.get(cur)!
    for (const { neighbour, delta } of adj.get(cur) ?? []) {
      if (gen.has(neighbour)) continue
      gen.set(neighbour, g + delta)
      queue.push(neighbour)
    }
  }
  for (const n of nodes) if (!gen.has(n)) gen.set(n, 0)
  return gen
}

// ─── Layout ───────────────────────────────────────────────────────────────────
// Place each node at (x, y). y is determined strictly by generation. x is
// chosen to keep couples adjacent and parents roughly above their children.
// Processed bottom-up so parent rows can centre over children rows.

function computeLayout(
  nodes: string[],
  genMap: Map<string, number>,
  pc: ParentChildEdge[],
  spouses: SpouseEdge[],
  rootPubkey: string,
): Map<string, { x: number; y: number }> {
  const spouseOf = new Map<string, string>()
  for (const s of spouses) {
    spouseOf.set(s.a, s.b)
    spouseOf.set(s.b, s.a)
  }
  const childrenOf = new Map<string, Set<string>>()
  for (const n of nodes) childrenOf.set(n, new Set())
  for (const e of pc) childrenOf.get(e.parent)?.add(e.child)

  const byGen = new Map<number, string[]>()
  for (const n of nodes) {
    const g = genMap.get(n) ?? 0
    if (!byGen.has(g)) byGen.set(g, [])
    byGen.get(g)!.push(n)
  }
  const gens = Array.from(byGen.keys()).sort((a, b) => a - b)
  const minGen = gens[0] ?? 0
  const pos = new Map<string, { x: number; y: number }>()

  for (const gen of [...gens].reverse()) {
    const members = byGen.get(gen)!
    const yPos = (gen - minGen) * (NODE_H + V_GAP)

    // Build slots: couples adjacent, then solos.
    const slots: string[][] = []
    const placed = new Set<string>()
    for (const pk of members) {
      if (placed.has(pk)) continue
      const sp = spouseOf.get(pk)
      if (sp && members.includes(sp) && !placed.has(sp)) {
        slots.push([pk, sp])
        placed.add(pk); placed.add(sp)
      } else {
        slots.push([pk])
        placed.add(pk)
      }
    }

    // Order: those with children first (sorted by avg child x), then those without.
    const avgChildX = (slot: string[]): number | null => {
      const xs: number[] = []
      for (const pk of slot) {
        for (const child of childrenOf.get(pk) ?? []) {
          const p = pos.get(child)
          if (p) xs.push(p.x)
        }
      }
      return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null
    }
    const withKids = slots
      .filter(s => avgChildX(s) !== null)
      .sort((a, b) => (avgChildX(a) ?? 0) - (avgChildX(b) ?? 0))
    const withoutKids = slots.filter(s => avgChildX(s) === null)
    // Put root's slot first if it's in the no-kids list (stable anchor).
    const rsIdx = withoutKids.findIndex(s => s.includes(rootPubkey))
    if (rsIdx > 0) {
      const [rs] = withoutKids.splice(rsIdx, 1)
      withoutKids.unshift(rs)
    }
    const ordered = [...withKids, ...withoutKids]

    const slotWidth = (slot: string[]) =>
      slot.length === 2 ? NODE_W * 2 + COUPLE_GAP : NODE_W
    let totalWidth = 0
    for (let i = 0; i < ordered.length; i++) {
      if (i > 0) totalWidth += H_GAP
      totalWidth += slotWidth(ordered[i])
    }

    let curX = -totalWidth / 2
    for (const slot of ordered) {
      const w = slotWidth(slot)
      const centre = curX + w / 2
      if (slot.length === 2) {
        pos.set(slot[0], { x: centre - (NODE_W + COUPLE_GAP) / 2, y: yPos })
        pos.set(slot[1], { x: centre + (NODE_W + COUPLE_GAP) / 2, y: yPos })
      } else {
        pos.set(slot[0], { x: centre, y: yPos })
      }
      curX += w + H_GAP
    }
  }

  return pos
}

// ─── Public API ───────────────────────────────────────────────────────────────

export { normaliseEdges, assignGenerations, computeLayout }
export {
  normaliseEdges    as __test_normaliseEdges,
  assignGenerations as __test_assignGenerations,
  computeLayout     as __test_computeLayout,
}
