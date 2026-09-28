import { expect, it } from 'vitest'
import { stageState } from '../../app/utils/activity'

it('animates only a running call in the selected job with a live worker', () => {
  const calls = [{ role: 'Критик', status: 'pending' }]
  expect(stageState('Критик', calls, ['Критик'], true, false)).toBe('working')
  expect(stageState('Критик', calls, ['Критик'], false, false)).toBe('unconfirmed')
  expect(stageState('Критик', calls, [], true, false)).toBe('unconfirmed')
  expect(stageState('Архитектор', calls, ['Критик'], true, false)).toBe('waiting')
})

it('distinguishes skipped stages, failed calls and successful saved stages', () => {
  const calls = [
    { role: 'Поиск', status: 'done' },
    { role: 'Критик', status: 'uncertain' },
  ]
  expect(stageState('Поиск', calls, [], false, true)).toBe('complete')
  expect(stageState('Критик', calls, [], true, true)).toBe('issue')
  expect(stageState('Архитектор', calls, [], true, true)).toBe('skipped')
})
