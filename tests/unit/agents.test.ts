import { describe, expect, it } from 'vitest'
import {
  agentLabels,
  agentName,
  defaultParams,
  describeMutation,
  renderApproach,
  type StrategyRow,
} from '../../core/agents'
import {
  applyMutation,
  mutableParams,
  mutationIndex,
  strategyParamsSchema,
  validateContent,
  type StrategyParams,
} from '../../core/policy'
import { taxonomyCategoryIds } from '../../core/taxonomy'

const row = (
  id: string,
  name: string,
  parent: string | null,
  generation: number,
  at: string,
): StrategyRow => ({ id, name, parent_id: parent, generation, created_at: at })

describe('agent names', () => {
  it('names founders А, Б, В, Г and copies by founder letter and generation', () => {
    const rows = [
      row('d', 'Дельта', null, 1, '2026-10-01T00:00:03Z'),
      row('a', 'Альфа', null, 1, '2026-10-01T00:00:00Z'),
      row('b', 'Бета', null, 1, '2026-10-01T00:00:01Z'),
      row('c', 'Гамма', null, 1, '2026-10-01T00:00:02Z'),
      row('a2', 'x', 'a', 2, '2026-10-05T00:00:00Z'),
      row('a3', 'x', 'a2', 3, '2026-10-09T00:00:00Z'),
      row('b3', 'x', 'b', 3, '2026-10-09T00:00:01Z'),
      row('a3b', 'x', 'a', 3, '2026-10-09T00:00:02Z'),
    ]
    const labels = agentLabels(rows)
    expect(Object.fromEntries(labels)).toEqual({
      a: 'А',
      b: 'Б',
      c: 'В',
      d: 'Г',
      a2: 'А2',
      a3: 'А3',
      b3: 'Б3',
      a3b: 'А3.2',
    })
    expect(agentName(labels.get('a2')!)).toBe('Разведчик А2')
    // Deterministic regardless of row order.
    expect(Object.fromEntries(agentLabels([...rows].reverse()))).toEqual(Object.fromEntries(labels))
  })

  it('names unknown founders by age with free letters', () => {
    const labels = agentLabels([
      row('x', 'Новый', null, 1, '2026-10-01T00:00:01Z'),
      row('y', 'Альфа', null, 1, '2026-10-01T00:00:02Z'),
      row('z', 'Ещё', null, 1, '2026-10-01T00:00:00Z'),
    ])
    expect(Object.fromEntries(labels)).toEqual({ y: 'А', z: 'Б', x: 'В' })
  })
})

describe('agent parameters and mutations', () => {
  it('gives founders valid, different focus industries', () => {
    const founders = [0, 1, 2, 3, 4, 5].map(defaultParams)
    for (const params of founders) expect(strategyParamsSchema.parse(params)).toEqual(params)
    const focus = founders.slice(0, 4).flatMap((p) => p.focusCategories)
    expect(new Set(focus).size).toBe(12)
    expect(
      strategyParamsSchema.safeParse({ ...founders[0], focusCategories: ['casino'] }).success,
    ).toBe(false)
    expect(
      strategyParamsSchema.safeParse({ ...founders[0], focusCategories: ['food', 'food'] }).success,
    ).toBe(false)
    expect(strategyParamsSchema.safeParse({ ...founders[0], extra: 'instruction' }).success).toBe(
      false,
    )
  })

  it('changes exactly one allowed parameter, deterministically', () => {
    const parent = defaultParams(0)
    for (let index = 0; index < 5; index++) {
      const { params, mutation } = applyMutation(parent, index, { categoryScouts: {} })
      expect(mutation.param).toBe(mutableParams[index])
      expect(strategyParamsSchema.parse(params)).toEqual(params)
      const changed = (Object.keys(parent) as (keyof StrategyParams)[]).filter(
        (key) => JSON.stringify(parent[key]) !== JSON.stringify(params[key]),
      )
      expect(changed).toEqual([mutation.param])
      expect(applyMutation(parent, index, { categoryScouts: {} })).toEqual({ params, mutation })
    }
    expect(mutationIndex('abc', 1)).toBe((97 + 98 + 99 + 1) % 5)
  })

  it('replaces a focus industry with the least scouted one outside the list', () => {
    const parent = defaultParams(0)
    const scouts = Object.fromEntries(taxonomyCategoryIds.map((id) => [id, 5]))
    scouts.pets = 0
    const { params, mutation } = applyMutation(parent, 0, { categoryScouts: scouts })
    expect(mutation.param).toBe('focusCategories')
    expect(params.focusCategories).toContain('pets')
    expect(params.focusCategories).toHaveLength(parent.focusCategories.length)
  })

  it('never repeats the parent’s last mutation', () => {
    const parent = defaultParams(1)
    const { mutation } = applyMutation(parent, 2, { categoryScouts: {} }, 'tone')
    expect(mutation.param).toBe('ideaScope')
  })

  it('rebuilds the instruction from parameters only, in plain words', () => {
    const text = renderApproach(defaultParams(2))
    expect(text).toMatch(/Ищет идеи в отраслях: Репетиторы и обучение/)
    expect(text).not.toMatch(/[—→]/)
    expect(() => validateContent(text)).not.toThrow()
    expect(describeMutation({ param: 'focusCategories', from: ['food'], to: ['b2b'] })).toBe(
      'ищет в B2B, а не в общепите',
    )
    expect(describeMutation({ param: 'evidenceMinimum', from: 2, to: 3 })).toBe(
      'просит 3 подтверждения спроса вместо 2',
    )
  })
})
