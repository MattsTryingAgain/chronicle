/**
 * Tests for the family tree visualisation layout.
 *
 * These tests exercise the pure layout functions used by FamilyTreeView,
 * verifying that:
 *   - Children are positioned BELOW parents (greater y value).
 *   - Every parent→child relationship produces exactly one connector edge.
 *   - Spouses share a generation (same y).
 *   - Multiple children of the same parent all sit at the same generation.
 *
 * The visual D3 rendering is not unit-tested here; the layout maths is.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  _resetGraphStore,
  addRelationship,
  traverseGraph,
} from './graph'
import type { RelationshipClaim } from './graph'
import type { RelationshipType } from '../types/chronicle'
import {
  __test_normaliseEdges,
  __test_assignGenerations,
  __test_computeLayout,
} from '../components/FamilyTreeView.layout'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const Matt    = 'npub_matt'
const Stephen = 'npub_stephen'
const Layla   = 'npub_layla'
const Anna    = 'npub_anna'
const Tom     = 'npub_tom'  // a child of Matt's
const Joe     = 'npub_joe'  // another child of Matt's

let idCounter = 0
function makeRel(
  subject: string,
  related: string,
  rel: RelationshipType,
): RelationshipClaim {
  idCounter++
  return {
    eventId: `evt-${idCounter}`,
    claimantPubkey: subject,
    subjectPubkey: subject,
    relatedPubkey: related,
    relationship: rel,
    sensitive: false,
    createdAt: 1_000_000 + idCounter,
    retracted: false,
  }
}

// Helper to record both directions of a relationship like AddPersonModal does.
function addBoth(subj: string, related: string, subjRel: RelationshipType) {
  const inv: RelationshipType =
    subjRel === 'parent'  ? 'child'  :
    subjRel === 'child'   ? 'parent' :
    subjRel  // spouse/sibling are their own inverses
  addRelationship(makeRel(subj, related, subjRel))
  addRelationship(makeRel(related, subj, inv))
}

beforeEach(() => {
  _resetGraphStore()
  idCounter = 0
})

// ─── Generation tests ─────────────────────────────────────────────────────────

describe('FamilyTreeView layout — generations', () => {
  it('root only: gen 0', () => {
    const { nodes, edges } = traverseGraph(Matt)
    const norm = __test_normaliseEdges(edges)
    const gens = __test_assignGenerations(Matt, nodes.length === 0 ? [Matt] : nodes, norm.parentChild, norm.spouses)
    expect(gens.get(Matt)).toBe(0)
  })

  it('one parent: parent is gen -1, root is gen 0', () => {
    // Matt is child of Stephen → Stephen is parent of Matt
    addBoth(Matt, Stephen, 'child')
    const { nodes, edges } = traverseGraph(Matt)
    const norm = __test_normaliseEdges(edges)
    const gens = __test_assignGenerations(Matt, nodes, norm.parentChild, norm.spouses)
    expect(gens.get(Stephen)).toBe(-1)
    expect(gens.get(Matt)).toBe(0)
  })

  it('two parents: both at gen -1', () => {
    addBoth(Matt, Stephen, 'child')
    addBoth(Matt, Layla, 'child')
    const { nodes, edges } = traverseGraph(Matt)
    const norm = __test_normaliseEdges(edges)
    const gens = __test_assignGenerations(Matt, nodes, norm.parentChild, norm.spouses)
    expect(gens.get(Stephen)).toBe(-1)
    expect(gens.get(Layla)).toBe(-1)
    expect(gens.get(Matt)).toBe(0)
  })

  it('child of root: at gen +1', () => {
    // Matt is parent of Tom
    addBoth(Matt, Tom, 'parent')
    const { nodes, edges } = traverseGraph(Matt)
    const norm = __test_normaliseEdges(edges)
    const gens = __test_assignGenerations(Matt, nodes, norm.parentChild, norm.spouses)
    expect(gens.get(Matt)).toBe(0)
    expect(gens.get(Tom)).toBe(1)
  })

  it('multiple children of root: all at gen +1', () => {
    addBoth(Matt, Tom, 'parent')
    addBoth(Matt, Joe, 'parent')
    const { nodes, edges } = traverseGraph(Matt)
    const norm = __test_normaliseEdges(edges)
    const gens = __test_assignGenerations(Matt, nodes, norm.parentChild, norm.spouses)
    expect(gens.get(Tom)).toBe(1)
    expect(gens.get(Joe)).toBe(1)
  })

  it('three generations: grandparent at -2 via parent chain', () => {
    // Anna -- parent of --> Stephen -- parent of --> Matt
    addBoth(Stephen, Anna,    'child')   // Stephen is child of Anna
    addBoth(Matt,    Stephen, 'child')   // Matt is child of Stephen
    const { nodes, edges } = traverseGraph(Matt)
    const norm = __test_normaliseEdges(edges)
    const gens = __test_assignGenerations(Matt, nodes, norm.parentChild, norm.spouses)
    expect(gens.get(Matt)).toBe(0)
    expect(gens.get(Stephen)).toBe(-1)
    expect(gens.get(Anna)).toBe(-2)
  })

  it('spouse shares a generation with subject', () => {
    addBoth(Matt, Anna, 'spouse')
    const { nodes, edges } = traverseGraph(Matt)
    const norm = __test_normaliseEdges(edges)
    const gens = __test_assignGenerations(Matt, nodes, norm.parentChild, norm.spouses)
    expect(gens.get(Matt)).toBe(0)
    expect(gens.get(Anna)).toBe(0)
  })
})

// ─── Layout tests ─────────────────────────────────────────────────────────────

describe('FamilyTreeView layout — positions', () => {
  it('parent has smaller y than child', () => {
    addBoth(Matt, Stephen, 'child') // Stephen is parent of Matt
    const { nodes, edges } = traverseGraph(Matt)
    const norm = __test_normaliseEdges(edges)
    const gens = __test_assignGenerations(Matt, nodes, norm.parentChild, norm.spouses)
    const pos  = __test_computeLayout(nodes, gens, norm.parentChild, norm.spouses, Matt)
    expect(pos.get(Stephen)!.y).toBeLessThan(pos.get(Matt)!.y)
  })

  it('multiple children all sit on the same row below the parent', () => {
    addBoth(Matt, Tom, 'parent')
    addBoth(Matt, Joe, 'parent')
    const { nodes, edges } = traverseGraph(Matt)
    const norm = __test_normaliseEdges(edges)
    const gens = __test_assignGenerations(Matt, nodes, norm.parentChild, norm.spouses)
    const pos  = __test_computeLayout(nodes, gens, norm.parentChild, norm.spouses, Matt)
    expect(pos.get(Tom)!.y).toBe(pos.get(Joe)!.y)
    expect(pos.get(Tom)!.y).toBeGreaterThan(pos.get(Matt)!.y)
  })

  it('two parents sit on the same row above the child', () => {
    addBoth(Matt, Stephen, 'child')
    addBoth(Matt, Layla,   'child')
    const { nodes, edges } = traverseGraph(Matt)
    const norm = __test_normaliseEdges(edges)
    const gens = __test_assignGenerations(Matt, nodes, norm.parentChild, norm.spouses)
    const pos  = __test_computeLayout(nodes, gens, norm.parentChild, norm.spouses, Matt)
    expect(pos.get(Stephen)!.y).toBe(pos.get(Layla)!.y)
    expect(pos.get(Stephen)!.y).toBeLessThan(pos.get(Matt)!.y)
  })

  it('spouses get distinct x positions on the same y', () => {
    addBoth(Matt, Anna, 'spouse')
    const { nodes, edges } = traverseGraph(Matt)
    const norm = __test_normaliseEdges(edges)
    const gens = __test_assignGenerations(Matt, nodes, norm.parentChild, norm.spouses)
    const pos  = __test_computeLayout(nodes, gens, norm.parentChild, norm.spouses, Matt)
    expect(pos.get(Matt)!.y).toBe(pos.get(Anna)!.y)
    expect(pos.get(Matt)!.x).not.toBe(pos.get(Anna)!.x)
  })
})

// ─── Edge normalisation tests ─────────────────────────────────────────────────

describe('FamilyTreeView layout — edge normalisation', () => {
  it('forward+inverse parent/child claims produce ONE parent-child edge', () => {
    addBoth(Matt, Stephen, 'child') // creates two claims: child + parent
    const { edges } = traverseGraph(Matt)
    const norm = __test_normaliseEdges(edges)
    expect(norm.parentChild).toHaveLength(1)
    expect(norm.parentChild[0].parent).toBe(Stephen)
    expect(norm.parentChild[0].child).toBe(Matt)
  })

  it('multiple parent-child edges between different pairs all preserved', () => {
    addBoth(Matt, Stephen, 'child')
    addBoth(Matt, Layla,   'child')
    addBoth(Matt, Tom,     'parent')
    const { edges } = traverseGraph(Matt)
    const norm = __test_normaliseEdges(edges)
    expect(norm.parentChild).toHaveLength(3)
    // Stephen and Layla parent Matt; Matt parents Tom
    const parents = norm.parentChild.filter(e => e.child === Matt).map(e => e.parent).sort()
    expect(parents).toEqual([Layla, Stephen].sort())
    const matsChildren = norm.parentChild.filter(e => e.parent === Matt).map(e => e.child)
    expect(matsChildren).toEqual([Tom])
  })

  it('spouse pair produces ONE spouse edge', () => {
    addBoth(Matt, Anna, 'spouse')
    const { edges } = traverseGraph(Matt)
    const norm = __test_normaliseEdges(edges)
    expect(norm.spouses).toHaveLength(1)
  })
})

// ─── End-to-end integration ───────────────────────────────────────────────────

describe('FamilyTreeView layout — end-to-end family', () => {
  it('Matt with two parents and two children: 3 generations, correct edges', () => {
    addBoth(Matt, Stephen, 'child')   // Stephen parent of Matt
    addBoth(Matt, Layla,   'child')   // Layla parent of Matt
    addBoth(Matt, Tom,     'parent')  // Matt parent of Tom
    addBoth(Matt, Joe,     'parent')  // Matt parent of Joe

    const { nodes, edges } = traverseGraph(Matt)
    const norm = __test_normaliseEdges(edges)
    const gens = __test_assignGenerations(Matt, nodes, norm.parentChild, norm.spouses)
    const pos  = __test_computeLayout(nodes, gens, norm.parentChild, norm.spouses, Matt)

    // Three distinct y rows
    const ys = new Set([
      pos.get(Stephen)!.y, pos.get(Layla)!.y,
      pos.get(Matt)!.y,
      pos.get(Tom)!.y, pos.get(Joe)!.y,
    ])
    expect(ys.size).toBe(3)

    // Stephen/Layla above Matt; Matt above Tom/Joe
    expect(pos.get(Stephen)!.y).toBe(pos.get(Layla)!.y)
    expect(pos.get(Stephen)!.y).toBeLessThan(pos.get(Matt)!.y)
    expect(pos.get(Matt)!.y).toBeLessThan(pos.get(Tom)!.y)
    expect(pos.get(Tom)!.y).toBe(pos.get(Joe)!.y)

    // Four parent-child edges total
    expect(norm.parentChild).toHaveLength(4)
  })
})

// ─── Regression: in-row ordering ──────────────────────────────────────────────
//
// Real bug from the screenshot at v1.0.47: Stephen and Eddie are both children
// of Ralph + Diane; Maria is a child of Bill + Patricia. Matt's parents are
// Stephen and Maria. The bottom-up layout was placing Stephen between Bill and
// Diane (because Stephen had children, so the algorithm centred him over them),
// which made it look like Stephen had Bill and Patricia as parents rather than
// Ralph and Diane.

describe('FamilyTreeView layout — in-row ordering by parent x', () => {
  it("Stephen and Eddie sit on the same side as Ralph + Diane; Maria sits under Bill + Patricia", () => {
    // Generation -2: Ralph + Diane (couple), Bill + Patricia (couple)
    // Generation -1: Stephen (child of Ralph + Diane), Eddie (child of Ralph + Diane),
    //                Maria (child of Bill + Patricia)
    // Generation  0: Matt (child of Stephen + Maria)
    const Ralph    = 'np_ralph'
    const Diane    = 'np_diane'
    const Bill     = 'np_bill'
    const Patricia = 'np_patricia'
    const Stephen2 = 'np_stephen'
    const Eddie    = 'np_eddie'
    const Maria    = 'np_maria'
    const Matt2    = 'np_matt'

    // Spouses on the grandparent generation
    addBoth(Ralph, Diane, 'spouse')
    addBoth(Bill,  Patricia, 'spouse')

    // Grandparents → parents
    addBoth(Stephen2, Ralph,    'child')
    addBoth(Stephen2, Diane,    'child')
    addBoth(Eddie,    Ralph,    'child')
    addBoth(Eddie,    Diane,    'child')
    addBoth(Maria,    Bill,     'child')
    addBoth(Maria,    Patricia, 'child')

    // Parents → Matt
    addBoth(Matt2, Stephen2, 'child')
    addBoth(Matt2, Maria,    'child')

    const { nodes, edges } = traverseGraph(Matt2)
    const norm = __test_normaliseEdges(edges)
    const gens = __test_assignGenerations(Matt2, nodes, norm.parentChild, norm.spouses)
    const pos  = __test_computeLayout(nodes, gens, norm.parentChild, norm.spouses, Matt2)

    // All four grandparents at the top row
    const grandparentY = pos.get(Ralph)!.y
    expect(pos.get(Diane)!.y).toBe(grandparentY)
    expect(pos.get(Bill)!.y).toBe(grandparentY)
    expect(pos.get(Patricia)!.y).toBe(grandparentY)

    // Parents row below the grandparents
    const parentY = pos.get(Stephen2)!.y
    expect(parentY).toBeGreaterThan(grandparentY)
    expect(pos.get(Maria)!.y).toBe(parentY)
    expect(pos.get(Eddie)!.y).toBe(parentY)

    // Matt below the parents
    expect(pos.get(Matt2)!.y).toBeGreaterThan(parentY)

    // The key invariant: Stephen must sit on the SAME SIDE as Ralph + Diane,
    // and Maria must sit on the SAME SIDE as Bill + Patricia. Specifically,
    // Stephen's x should be between Ralph's x and Diane's x — i.e., his x
    // must be closer to his actual parents' midpoint than to Bill+Patricia's
    // midpoint.
    const ralphDianeMid = (pos.get(Ralph)!.x + pos.get(Diane)!.x) / 2
    const billPatMid    = (pos.get(Bill)!.x + pos.get(Patricia)!.x) / 2
    const stephenX      = pos.get(Stephen2)!.x
    const mariaX        = pos.get(Maria)!.x

    expect(Math.abs(stephenX - ralphDianeMid)).toBeLessThan(Math.abs(stephenX - billPatMid))
    expect(Math.abs(mariaX   - billPatMid))   .toBeLessThan(Math.abs(mariaX   - ralphDianeMid))

    // Eddie must also be near Ralph + Diane, not under Bill + Patricia.
    const eddieX = pos.get(Eddie)!.x
    expect(Math.abs(eddieX - ralphDianeMid)).toBeLessThan(Math.abs(eddieX - billPatMid))
  })

  it('grandparents row: couples sit adjacent, not interleaved', () => {
    // Same fixture as above but only asserting on grandparent row layout.
    const Ralph    = 'np_ralph'
    const Diane    = 'np_diane'
    const Bill     = 'np_bill'
    const Patricia = 'np_patricia'
    const Stephen2 = 'np_stephen'
    const Maria    = 'np_maria'
    const Matt2    = 'np_matt'

    addBoth(Ralph, Diane, 'spouse')
    addBoth(Bill, Patricia, 'spouse')
    addBoth(Stephen2, Ralph, 'child')
    addBoth(Stephen2, Diane, 'child')
    addBoth(Maria, Bill, 'child')
    addBoth(Maria, Patricia, 'child')
    addBoth(Matt2, Stephen2, 'child')
    addBoth(Matt2, Maria, 'child')

    const { nodes, edges } = traverseGraph(Matt2)
    const norm = __test_normaliseEdges(edges)
    const gens = __test_assignGenerations(Matt2, nodes, norm.parentChild, norm.spouses)
    const pos  = __test_computeLayout(nodes, gens, norm.parentChild, norm.spouses, Matt2)

    // Ralph and Diane should be next to each other (couple)
    const ralphDianeDist = Math.abs(pos.get(Ralph)!.x - pos.get(Diane)!.x)
    const billPatDist    = Math.abs(pos.get(Bill)!.x - pos.get(Patricia)!.x)

    // A couple is rendered NODE_W + COUPLE_GAP apart.
    // Any cross-couple distance must be larger than the within-couple distance.
    const ralphBillDist     = Math.abs(pos.get(Ralph)!.x - pos.get(Bill)!.x)
    const dianePatriciaDist = Math.abs(pos.get(Diane)!.x - pos.get(Patricia)!.x)
    const dianeBillDist     = Math.abs(pos.get(Diane)!.x - pos.get(Bill)!.x)

    expect(ralphBillDist).toBeGreaterThan(ralphDianeDist)
    expect(dianePatriciaDist).toBeGreaterThan(ralphDianeDist)
    expect(dianeBillDist).toBeGreaterThan(ralphDianeDist)
    expect(dianeBillDist).toBeGreaterThan(billPatDist)
  })
})

// ─── Regression: parents centred over their children's group ──────────────────
//
// Real bug from screenshot 140: the parents row was placed in input order,
// not centred over the children of each couple. Diane+Ralph were sitting
// off to the left of their children's actual midpoint, and the arm coming
// up from Stephen+Maria's couple-midpoint crossed Patricia's drop line.

describe('FamilyTreeView layout — parents centred over children groups', () => {
  it('each grandparent couple sits directly above the midpoint of their own children', () => {
    // Two grandparent couples, three children each, one of those children
    // from each side marries the other to produce Matt.
    const D='diane', R='ralph', P='patricia', BSr='billsr'
    const Ed='eddie', Ph='phil', St='stephen', Ma='maria', BJr='billjr', So='sonya'
    const Mt='matt'

    addBoth(D, R, 'spouse')
    addBoth(P, BSr, 'spouse')
    addBoth(St, Ma, 'spouse')

    for (const c of [Ed, Ph, St]) {
      addBoth(c, D, 'child'); addBoth(c, R, 'child')
    }
    for (const c of [Ma, BJr, So]) {
      addBoth(c, P, 'child'); addBoth(c, BSr, 'child')
    }
    addBoth(Mt, St, 'child'); addBoth(Mt, Ma, 'child')

    const { nodes, edges } = traverseGraph(Mt)
    const norm = __test_normaliseEdges(edges)
    const gens = __test_assignGenerations(Mt, nodes, norm.parentChild, norm.spouses)
    const pos  = __test_computeLayout(nodes, gens, norm.parentChild, norm.spouses, Mt)

    const drMid    = (pos.get(D)!.x + pos.get(R)!.x) / 2
    const ephsMid  = (pos.get(Ed)!.x + pos.get(Ph)!.x + pos.get(St)!.x) / 3
    const pbMid    = (pos.get(P)!.x + pos.get(BSr)!.x) / 2
    const mbsoMid  = (pos.get(Ma)!.x + pos.get(BJr)!.x + pos.get(So)!.x) / 3

    // Couple midpoint should match children's centroid within a small tolerance.
    expect(Math.abs(drMid - ephsMid)).toBeLessThan(5)
    expect(Math.abs(pbMid - mbsoMid)).toBeLessThan(5)
  })

  it('a single parent couple with multiple children sits centred above them', () => {
    // Simpler scenario: one couple at top, three kids below.
    const D='d', R='r'
    const A='a', B='b', C='c'
    addBoth(D, R, 'spouse')
    for (const k of [A, B, C]) { addBoth(k, D, 'child'); addBoth(k, R, 'child') }

    const { nodes, edges } = traverseGraph(A)   // root one of the kids
    const norm = __test_normaliseEdges(edges)
    const gens = __test_assignGenerations(A, nodes, norm.parentChild, norm.spouses)
    const pos  = __test_computeLayout(nodes, gens, norm.parentChild, norm.spouses, A)

    const drMid    = (pos.get(D)!.x + pos.get(R)!.x) / 2
    const kidsMid  = (pos.get(A)!.x + pos.get(B)!.x + pos.get(C)!.x) / 3
    expect(Math.abs(drMid - kidsMid)).toBeLessThan(5)
  })
})
