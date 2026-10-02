import { describe, expect, it } from 'vitest'
import { applyOrder, moveDown, moveUp } from './staffOrder'

const IDS = ['a', 'b', 'c'] as const

describe('moveUp / moveDown (contract 1.6 §4.4)', () => {
  it('swap with the neighbour and return the full list', () => {
    expect(moveUp(IDS, 'b')).toEqual(['b', 'a', 'c'])
    expect(moveDown(IDS, 'b')).toEqual(['a', 'c', 'b'])
  })

  it('at the edges or for an unknown id the order stays', () => {
    expect(moveUp(IDS, 'a')).toEqual(['a', 'b', 'c'])
    expect(moveDown(IDS, 'c')).toEqual(['a', 'b', 'c'])
    expect(moveUp(IDS, 'x')).toEqual(['a', 'b', 'c'])
    expect(moveDown(IDS, 'x')).toEqual(['a', 'b', 'c'])
  })

  it('pure: the input list is never changed', () => {
    const ids = ['a', 'b']
    moveUp(ids, 'b')
    expect(ids).toEqual(['a', 'b'])
  })
})

describe('applyOrder', () => {
  it('sorts the cached list by the sorts the server answered', () => {
    const staff = [
      { id: 'a', sort: 0, name: 'Α' },
      { id: 'b', sort: 1, name: 'Β' },
    ]
    expect(
      applyOrder(staff, [
        { id: 'b', sort: 0 },
        { id: 'a', sort: 1 },
      ]),
    ).toEqual([
      { id: 'b', sort: 0, name: 'Β' },
      { id: 'a', sort: 1, name: 'Α' },
    ])
  })
})
