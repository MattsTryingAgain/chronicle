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
// Order of operations:
//   1. Find the topmost generation. Place those slots in a stable order
//      (root's slot first if present, otherwise stable by member order).
//   2. Walk DOWN one generation at a time. For each slot in a generation,
//      compute the average x of any already-placed PARENTS — slots sort by
//      this so that children appear under their parents.
//   3. Slots with no placed parents (e.g. ancestors who weren't in the
//      previous generation, or root's own row when root has no parents)
//      keep their declared input order.
//   4. After all generations are placed, shift the whole tree so the root
//      ends up at x = 0 (the auto-fit zoom then centres everything).
//
// This is the inverse of the older bottom-up pass, which mis-sorted slots
// like Stephen+Maria when Stephen's children and Maria's children were
// being averaged together and Stephen drifted between the wrong parents.

function computeLayout(
  nodes: string[],
  genMap: Map<string, number>,
  pc: ParentChildEdge[],
  spouses: SpouseEdge[],
  rootPubkey: string,
): Map<string, { x: number; y: number }> {
  // Adjacency maps
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

  // Build slots for a generation: couples first, then solos. Returns slots
  // in the input order — the caller is responsible for ordering them.
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

  // Average x of any already-placed parents of the people in this slot.
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

  // Process generations top-down.
  for (const gen of gens) {
    const members = byGen.get(gen)!
    const yPos = (gen - minGen) * (NODE_H + V_GAP)
    const slots = buildSlots(members)

    // Group slots into "sibling groups" by shared parent-set. Slots that
    // share the same parents (or that are siblings via shared parents)
    // form one group and are laid out adjacently, centred over their
    // parents' midpoint.
    //
    // Slots with no placed parents form their own one-slot groups. The
    // root's slot is always in a group of its own at the front so it
    // stays anchored.
    interface SlotGroup {
      slots: string[][]
      parentMidX: number | null
      hasRoot: boolean
    }

    const slotParentKey = (slot: string[]): string => {
      // Combine the parent sets of every member of the slot. For a couple,
      // each spouse usually has different parents, but the slot is treated
      // as a unit so we union them.
      const parents = new Set<string>()
      for (const pk of slot) {
        for (const p of parentsOf.get(pk) ?? []) parents.add(p)
      }
      return Array.from(parents).sort().join('|')
    }

    const groupMap = new Map<string, SlotGroup>()
    const groupOrder: SlotGroup[] = []
    for (const slot of slots) {
      const key = slotParentKey(slot)
      const hasRoot = slot.includes(rootPubkey)
      // No parents → singleton group (so unrelated trees stay separate).
      // Root → always its own singleton at the front.
      if (key === '' || hasRoot) {
        const g: SlotGroup = { slots: [slot], parentMidX: avgParentX(slot), hasRoot }
        groupOrder.push(g)
        continue
      }
      let g = groupMap.get(key)
      if (!g) {
        g = { slots: [], parentMidX: avgParentX(slot), hasRoot: false }
        groupMap.set(key, g)
        groupOrder.push(g)
      }
      g.slots.push(slot)
    }

    // Sort groups: root first, then by parent midpoint, then null-parent
    // groups at the end in input order.
    groupOrder.sort((a, b) => {
      if (a.hasRoot && !b.hasRoot) return -1
      if (b.hasRoot && !a.hasRoot) return 1
      if (a.parentMidX !== null && b.parentMidX !== null) return a.parentMidX - b.parentMidX
      if (a.parentMidX !== null) return -1
      if (b.parentMidX !== null) return 1
      return 0  // preserve input order for unrelated null-parent groups
    })

    // Width of an entire group: sum of slot widths plus H_GAP between them.
    const groupWidth = (g: SlotGroup): number => {
      let w = 0
      for (let i = 0; i < g.slots.length; i++) {
        if (i > 0) w += H_GAP
        w += slotWidth(g.slots[i])
      }
      return w
    }

    // Place groups: each group's centre prefers its parentMidX. Sweep
    // left-to-right and push later groups right if they would overlap
    // their predecessor. (A larger inter-group gap keeps unrelated
    // sibling groups visually distinct.)
    const INTER_GROUP_GAP = H_GAP + 24

    const groupCentres: number[] = []
    for (let i = 0; i < groupOrder.length; i++) {
      const g = groupOrder[i]
      const w = groupWidth(g)
      let centre = g.parentMidX ?? 0
      if (i > 0) {
        const prev = groupOrder[i - 1]
        const prevW = groupWidth(prev)
        const minCentre = groupCentres[i - 1] + prevW / 2 + INTER_GROUP_GAP + w / 2
        if (centre < minCentre) centre = minCentre
      }
      groupCentres.push(centre)
    }

    // Pull-back pass: if a later group was pushed right of its target,
    // try to slide earlier groups (those currently left of their target)
    // rightward to share the load.
    for (let i = groupOrder.length - 1; i > 0; i--) {
      const target = groupOrder[i].parentMidX
      if (target === null) continue
      let surplus = groupCentres[i] - target
      if (surplus <= 0) continue
      for (let j = i - 1; j >= 0; j--) {
        const tj = groupOrder[j].parentMidX
        if (tj === null) break
        const want = tj - groupCentres[j]
        if (want <= 0) break
        const shift = Math.min(want, surplus)
        if (shift <= 0) break
        groupCentres[j] += shift
        surplus -= shift
        if (surplus <= 0) break
      }
    }

    // Now place each slot inside its group. The first slot's centre is at
    // groupCentre - groupWidth/2 + firstSlotWidth/2; each subsequent slot
    // is placed with H_GAP between adjacent edges.
    for (let gi = 0; gi < groupOrder.length; gi++) {
      const g = groupOrder[gi]
      const gw = groupWidth(g)
      let curX = groupCentres[gi] - gw / 2
      for (const slot of g.slots) {
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
  }

  // Final shift: anchor the root to x = 0 so the visual centre matches the
  // user's identity. Auto-fit zoom will recentre everything anyway, but
  // this keeps the root predictable.
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
