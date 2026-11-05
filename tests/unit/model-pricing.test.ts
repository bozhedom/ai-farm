import { expect, it } from 'vitest'
import { priceNano } from '../../core/agent-profiles'
import { openaiCost, openaiMaximum } from '../../core/providers/openai-cost'

it('converts exact decimal tariffs upward and refuses malformed prices', () => {
  expect(priceNano('0.000001')).toBe(1000)
  expect(priceNano('0.0000000001')).toBe(1)
  expect(priceNano('-0.1')).toBeNull()
  expect(priceNano('NaN')).toBeNull()
  expect(priceNano('0')).toBe(0)
})

it('prices a cheaper role conservatively using integer units', () => {
  const pricing = { inputNano: 1000, outputNano: 2000 }
  expect(openaiCost(1000, 500, 0, 0, pricing)).toBe(2000)
  expect(openaiMaximum(1000, 500, pricing)).toBe(2250)
  expect(openaiMaximum(1, 0, { inputNano: 1, outputNano: 1 })).toBe(1)
  expect(openaiMaximum(1000, 500, pricing)).toBeLessThan(openaiMaximum(1000, 500))
})
