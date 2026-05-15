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
// Place each node at (x, y). y is determined strictly by generation.
//
// TWO-PASS ALGORITHM:
//
//   Pass 1 — top-down. For each generation oldest → youngest, group slots
//   by their parent-set ("sibling groups"). Within each generation, sort
//   groups by the x of their parents (already placed in the row above),
//   then place groups left-to-right with overlap resolution.
//
//   Pass 2 — bottom-up re-centring. For each generation youngest → oldest,
//   slide each sibling group's centre so that it matches the midpoint of
//   the group of children it parents. Constrained: a group can only move
//   horizontally within the gaps left by its neighbours in the same row.
//
//   Pass 2 fixes the case where a parent couple ends up off-centre over
//   their children — the symptom is connector arms that cross sideways
//   between generations. After re-centring, each couple sits directly
//   above its children's midpoint whenever there's room.
//
// Finally, the whole tree is shifted so the root sits at x = 0.

interface SlotGroup {
  slots: string[][]
  parentMidX: number | null
  hasRoot: boolean
  members: string[]   // flat list of all pubkeys in this group
  width: number       // total horizontal width of the group
}

function computeLayout(
  nodes: string[],
  genMap: Map<string, number>,
  pc: ParentChildEdge[],
  spouses: SpouseEdge[],
  rootPubkey: string,
): Map<string, { x: number; y: number }> {
  // Adjacency
  const spouseOf = new Map<string, string>()
  for (const s of spouses) {
    spouseOf.set(s.a, s.b)
    spouseOf.set(s.b, s.a)
  }
  const parentsOf = new Map<string, Set<string>>()
  for (const n of nodes) parentsOf.set(n, new Set())
  for (const e of pc) parentsOf.get(e.child)?.add(e.parent)

  // Group by generation
  const byGen = new Map<number, string[]>()
  for (const n of nodes) {
    const g = genMap.get(n) ?? 0
    if (!byGen.has(g)) byGen.set(g, [])
    byGen.get(g)!.push(n)
  }
  const gens = Array.from(byGen.keys()).sort((a, b) => a - b)
  const minGen = gens[0] ?? 0
  const pos = new Map<string, { x: number; y: number }>()

  const buildSlots = (members: string[]): string[][] => {
    const slots: string[][] = []
    const placedSet = new Set<string>()
    for (const pk of members) {
      if (placedSet.has(pk)) continue
      const sp = spouseOf.get(pk)
      if (sp && members.includes(sp) && !placedSet.has(sp)) {
        slots.push([pk, sp])
        placedSet.add(pk); placedSet.add(sp)
      } else {
        slots.push([pk])
        placedSet.add(pk)
      }
    }
    return slots
  }

  const slotWidth = (slot: string[]) =>
    slot.length === 2 ? NODE_W * 2 + COUPLE_GAP : NODE_W

  const avgParentX = (slot: string[]): number | null => {
    const xs: number[] = []
    for (const pk of slot) {
      for (const parent of parentsOf.get(pk) ?? []) {
        const p = pos.get(parent)
        if (p) xs.push(p.x)
      }
    }
    return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null
  }

  const slotParentKey = (slot: string[]): string => {
    const parents = new Set<string>()
    for (const pk of slot) {
      for (const p of parentsOf.get(pk) ?? []) parents.add(p)
    }
    return Array.from(parents).sort().join('|')
  }

  const groupWidth = (g: { slots: string[][] }): number => {
    let w = 0
    for (let i = 0; i < g.slots.length; i++) {
      if (i > 0) w += H_GAP
      w += slotWidth(g.slots[i])
    }
    return w
  }

  const INTER_GROUP_GAP = H_GAP + 24

  // Place all slots of a group, given the group's centre x and y.
  // Records resulting positions in `pos`.
  const placeGroupSlots = (g: SlotGroup, centreX: number, y: number) => {
    let curX = centreX - g.width / 2
    for (const slot of g.slots) {
      const w = slotWidth(slot)
      const c = curX + w / 2
      if (slot.length === 2) {
        pos.set(slot[0], { x: c - (NODE_W + COUPLE_GAP) / 2, y })
        pos.set(slot[1], { x: c + (NODE_W + COUPLE_GAP) / 2, y })
      } else {
        pos.set(slot[0], { x: c, y })
      }
      curX += w + H_GAP
    }
  }

  // Per-generation state for pass 2.
  const generationLayout = new Map<number, {
    yPos: number
    groups: SlotGroup[]
    centres: number[]
  }>()

  // ── PASS 1 — top-down placement by parent x ────────────────────────────────
  for (const gen of gens) {
    const members = byGen.get(gen)!
    const yPos = (gen - minGen) * (NODE_H + V_GAP)
    const slots = buildSlots(members)

    // Group slots by parent-set
    const groupMap = new Map<string, SlotGroup>()
    const groupOrder: SlotGroup[] = []
    // Group slots by parent-set. Slots with no parents form their own
    // singleton groups (typically the top generation). The root's slot
    // joins its sibling group like any other — we just remember which
    // group it's in so pass 2 doesn't slide it (keeping the root anchored).
    for (const slot of slots) {
      const key = slotParentKey(slot)
      const hasRoot = slot.includes(rootPubkey)
      if (key === '') {
        // No parents at all → singleton group (unrelated tree, e.g. top gen)
        const g: SlotGroup = {
          slots: [slot], parentMidX: avgParentX(slot), hasRoot,
          members: [...slot], width: 0,
        }
        g.width = groupWidth(g)
        groupOrder.push(g)
        continue
      }
      let g = groupMap.get(key)
      if (!g) {
        g = { slots: [], parentMidX: avgParentX(slot), hasRoot: false, members: [], width: 0 }
        groupMap.set(key, g)
        groupOrder.push(g)
      }
      g.slots.push(slot)
      g.members.push(...slot)
      if (hasRoot) g.hasRoot = true
    }
    for (const g of groupOrder) g.width = groupWidth(g)

    // Sort by parent midpoint x. null-parent groups (top gen) sort by
    // input order, placed after parented groups.
    groupOrder.sort((a, b) => {
      if (a.parentMidX !== null && b.parentMidX !== null) return a.parentMidX - b.parentMidX
      if (a.parentMidX !== null) return -1
      if (b.parentMidX !== null) return 1
      return 0
    })

    // Initial centres: each group at its target, with overlap resolution.
    const centres: number[] = []
    for (let i = 0; i < groupOrder.length; i++) {
      const g = groupOrder[i]
      let centre = g.parentMidX ?? 0
      if (i > 0) {
        const prev = groupOrder[i - 1]
        const minCentre = centres[i - 1] + prev.width / 2 + INTER_GROUP_GAP + g.width / 2
        if (centre < minCentre) centre = minCentre
      }
      centres.push(centre)
    }

    // Pull-back pass
    for (let i = groupOrder.length - 1; i > 0; i--) {
      const target = groupOrder[i].parentMidX
      if (target === null) continue
      let surplus = centres[i] - target
      if (surplus <= 0) continue
      for (let j = i - 1; j >= 0; j--) {
        const tj = groupOrder[j].parentMidX
        if (tj === null) break
        const want = tj - centres[j]
        if (want <= 0) break
        const shift = Math.min(want, surplus)
        if (shift <= 0) break
        centres[j] += shift
        surplus -= shift
        if (surplus <= 0) break
      }
    }

    // Write positions for this generation
    for (let gi = 0; gi < groupOrder.length; gi++) {
      placeGroupSlots(groupOrder[gi], centres[gi], yPos)
    }

    generationLayout.set(gen, { yPos, groups: groupOrder, centres })
  }

  // ── PASS 2 — bottom-up re-centring of parent groups over their children ───
  //
  // For each generation from youngest to oldest, look at every group in
  // the *next* (older) generation and ask: "what's the midpoint of my
  // children in this generation?" Then slide the parent group's centre
  // toward that midpoint, constrained by its neighbours.
  //
  // Children of a parent group g are the union of all children of its
  // members. We compute the average x of those children's current
  // positions.
  //
  // We make several iterations to let alignments propagate up multiple
  // generations — 3 sweeps is enough for typical trees.

  const childrenOf = new Map<string, Set<string>>()
  for (const n of nodes) childrenOf.set(n, new Set())
  for (const e of pc) childrenOf.get(e.parent)?.add(e.child)

  for (let sweep = 0; sweep < 3; sweep++) {
    let movedAny = false
    for (let gi = gens.length - 2; gi >= 0; gi--) {
      const gen = gens[gi]
      const layout = generationLayout.get(gen)!

      for (let i = 0; i < layout.groups.length; i++) {
        const g = layout.groups[i]
        if (g.hasRoot) continue   // root anchor is immovable

        // Find this group's children that are placed in lower generations.
        const childXs: number[] = []
        for (const member of g.members) {
          for (const child of childrenOf.get(member) ?? []) {
            const cp = pos.get(child)
            if (cp) childXs.push(cp.x)
          }
        }
        if (childXs.length === 0) continue

        const desiredCentre = childXs.reduce((a, b) => a + b, 0) / childXs.length
        const currentCentre = layout.centres[i]
        const delta = desiredCentre - currentCentre
        if (Math.abs(delta) < 0.5) continue

        // Bounds: how far can we slide without colliding with neighbours
        // in the same row?
        let minAllowed = -Infinity
        let maxAllowed = +Infinity
        if (i > 0) {
          const prev = layout.groups[i - 1]
          minAllowed = layout.centres[i - 1] + prev.width / 2 + INTER_GROUP_GAP + g.width / 2
        }
        if (i < layout.groups.length - 1) {
          const next = layout.groups[i + 1]
          maxAllowed = layout.centres[i + 1] - next.width / 2 - INTER_GROUP_GAP - g.width / 2
        }
        const newCentre = Math.max(minAllowed, Math.min(maxAllowed, desiredCentre))
        if (Math.abs(newCentre - currentCentre) < 0.5) continue

        layout.centres[i] = newCentre
        placeGroupSlots(g, newCentre, layout.yPos)
        movedAny = true
      }
    }
    if (!movedAny) break
  }

  // Final shift: anchor the root to x = 0.
  const rootPos = pos.get(rootPubkey)
  if (rootPos) {
    const dx = -rootPos.x
    if (dx !== 0) {
      for (const [k, p] of pos.entries()) pos.set(k, { x: p.x + dx, y: p.y })
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
