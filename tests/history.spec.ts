/**
 * Open-history tests: the pure list semantics (front-insert, dedupe by
 * path, cap) that back the persisted history UI.
 */
import { describe, expect, it } from 'vitest'
import { HISTORY_CAP, pushHistory } from '../src/client/history.ts'

describe('pushHistory', () => {
  it('inserts at the front and caps the length', () => {
    const list = pushHistory([], { name: 'a.txt', path: 'D:/a.txt' })
    expect(list).toHaveLength(1)
    let current = list
    for (let i = 2; i <= HISTORY_CAP + 3; i += 1) {
      current = pushHistory(current, { name: `f${i}`, path: `D:/f${i}.txt` })
    }
    expect(current).toHaveLength(HISTORY_CAP)
    expect(current[0]?.path).toBe(`D:/f${HISTORY_CAP + 3}.txt`)
    // The oldest entries fell off the tail.
    expect(current.some(item => item.path === 'D:/a.txt')).toBe(false)
  })

  it('dedupes by path, moving the repeat to the front', () => {
    const list = pushHistory(
      pushHistory([], { name: 'a', path: 'D:/a.txt' }),
      { name: 'b', path: 'D:/b.txt' },
    )
    const moved = pushHistory(list, { name: 'a', path: 'D:/a.txt' })
    expect(moved.map(item => item.path)).toEqual(['D:/a.txt', 'D:/b.txt'])
  })

  it('updates the name of a repeated path', () => {
    const list = pushHistory([], { name: 'old', path: 'D:/a.txt' })
    const renamed = pushHistory(list, { name: 'new', path: 'D:/a.txt' })
    expect(renamed[0]?.name).toBe('new')
    expect(renamed).toHaveLength(1)
  })
})
