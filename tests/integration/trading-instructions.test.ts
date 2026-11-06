import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { pool, query } from '../../core/db'
import * as settings from '../../core/config'
import {
  addContext,
  profilesView,
  roleModel,
  rolePricing,
  withAgentProfiles,
} from '../../core/agent-profiles'
import { applyTradingInstructions } from '../../core/trading/instructions'
import { tradingInstructions } from '../../core/trading/owner-rules'
import { defaultTradingRules } from '../../core/contracts/trading-instructions'
import { applyMigrations, resetDatabase } from './helpers/db'

beforeAll(applyMigrations)
beforeEach(() => resetDatabase())
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
afterAll(() => pool.end())
const input = (instruction: string, revision = 0) => ({
  requestId: randomUUID(),
  role: 'manager',
  instruction,
  model: '',
  revision,
  instructionsRevision: revision,
})

it('atomically applies owner rules and manager text, survives fresh reads, and does not charge a repeated save', async () => {
  const request = input('Не покупать BTC; покупка не больше 7 USDT')
  const first = await applyTradingInstructions(request)
  expect(first.applied).toBe(true)
  expect(await applyTradingInstructions(request)).toEqual(first)
  expect(await tradingInstructions()).toMatchObject({
    revision: 1,
    synchronized: true,
    source: 'parser',
    rules: { blockedSymbols: ['BTC-USDT'], maxOrderUsdt: '7' },
  })
  expect((await profilesView()).roles.find((r) => r.id === 'manager')?.instruction).toBe(
    request.instruction,
  )
  expect(await query('SELECT id FROM tool_calls')).toHaveLength(0)
  await expect(applyTradingInstructions({ ...request, instruction: '' })).rejects.toThrow(
    'IDEMPOTENCY_CONFLICT',
  )
  await expect(applyTradingInstructions(input('Не покупать ETH'))).rejects.toThrow(
    'PROFILE_CHANGED',
  )
})

it('does not pretend an arbitrary demo instruction was interpreted or apply only its recognised portion', async () => {
  await applyTradingInstructions(input('Не покупать BTC'))
  const reply = await applyTradingInstructions(
    input('Покупка не больше 7 USDT; учитывать новости', 1),
  )
  expect(reply.applied).toBe(false)
  expect(reply.issues[0]).toContain('настоящей моделью')
  expect((await tradingInstructions()).rules.blockedSymbols).toEqual(['BTC-USDT'])
  expect((await tradingInstructions()).revision).toBe(1)
})

it('uses a validated model interpretation and preserves old rules if any part is unsupported', async () => {
  vi.spyOn(settings, 'config').mockReturnValue({
    ...settings.config(),
    MODEL_PROVIDER: 'openai',
    OPENAI_TRANSPORT: 'openrouter',
  })
  const interpreter = vi.fn(async () => ({
    rules: { ...defaultTradingRules(), maxOrderUsdt: '8', allowedSymbols: ['ETH-USDT'] },
    managerNotes: ['Объяснять комиссии при разборе.'],
    issues: [],
  }))
  const reply = await applyTradingInstructions(
    input('Ограничь новые покупки эфиром и восемью USDT; поясняй комиссии.'),
    interpreter,
  )
  expect(reply.applied).toBe(true)
  expect(reply.current.source).toBe('model')
  expect(interpreter).toHaveBeenCalledOnce()
  expect(
    (
      await query("SELECT status FROM budget_reservations WHERE category='trading_instructions'")
    )[0],
  ).toMatchObject({ status: 'closed' })
  const rejected = await applyTradingInstructions(
    input('Теперь торгуй только когда появляются хорошие новости.', 1),
    async () => ({
      rules: defaultTradingRules(),
      managerNotes: [],
      issues: ['Условия по новостям не реализованы.'],
    }),
  )
  expect(rejected.applied).toBe(false)
  expect((await tradingInstructions()).rules.maxOrderUsdt).toBe('8')
})

it('uses the newly selected cheap model for interpretation before the profile is saved', async () => {
  vi.spyOn(settings, 'config').mockReturnValue({
    ...settings.config(),
    MODEL_PROVIDER: 'openai',
    OPENAI_TRANSPORT: 'openrouter',
  })
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'vendor/cheap',
              name: 'Cheap',
              context_length: 128000,
              pricing: { prompt: '0.0000001', completion: '0.0000004' },
              supported_parameters: ['structured_outputs'],
            },
          ],
        }),
      ),
    ),
  )
  const interpreter = vi.fn(async () => {
    expect(roleModel('Разбор торговых инструкций')).toBe('vendor/cheap')
    expect(rolePricing('Разбор торговых инструкций')).toMatchObject({
      inputNano: 100,
      outputNano: 400,
    })
    expect(await query("SELECT * FROM agent_profiles WHERE role='manager'")).toHaveLength(0)
    return {
      rules: { ...defaultTradingRules(), blockedSymbols: ['BTC-USDT'] },
      managerNotes: [],
      issues: [],
    }
  })
  const reply = await applyTradingInstructions(
    { ...input('Избегай входов в биткоин.'), model: 'vendor/cheap' },
    interpreter,
  )
  expect(reply.applied).toBe(true)
  expect(interpreter).toHaveBeenCalledOnce()
  await withAgentProfiles(async () => {
    expect(roleModel('Разбор торговых инструкций')).toBe('vendor/cheap')
    expect(roleModel('Торговый менеджер')).toBe('vendor/cheap')
  })
})

it('does not overwrite a newer profile when instructions change while the model is thinking', async () => {
  vi.spyOn(settings, 'config').mockReturnValue({
    ...settings.config(),
    MODEL_PROVIDER: 'openai',
    OPENAI_TRANSPORT: 'openrouter',
  })
  await expect(
    applyTradingInstructions(input('Торгуй только эфиром.'), async () => {
      await query(
        "INSERT INTO agent_profiles(role,instruction) VALUES('manager','Более новая инструкция')",
      )
      return {
        rules: { ...defaultTradingRules(), allowedSymbols: ['ETH-USDT'] },
        managerNotes: [],
        issues: [],
      }
    }),
  ).rejects.toThrow('PROFILE_CHANGED')
  expect((await tradingInstructions()).appliedAt).toBeNull()
  expect((await profilesView()).roles.find((r) => r.id === 'manager')?.instruction).toBe(
    'Более новая инструкция',
  )
})

it('updates the enabled manager request and instruction revision for text and material edits without starting a paused manager', async () => {
  await applyTradingInstructions(input('Не покупать BTC'))
  expect((await query('SELECT enabled,requested_at FROM trading_manager'))[0]).toMatchObject({
    enabled: false,
    requested_at: null,
  })
  await query('UPDATE trading_manager SET enabled=true')
  await addContext({
    role: 'manager',
    title: 'Новые комиссии',
    content: 'Сравнить расходы до эксперимента.',
  })
  expect(
    (await query('SELECT instruction_revision,requested_at FROM trading_manager'))[0],
  ).toMatchObject({ instruction_revision: 2, requested_at: expect.any(Date) })
})

it('keeps paid translation behind the emergency stop and rejects expanded limits without partial changes', async () => {
  await applyTradingInstructions(input('Не покупать BTC'))
  vi.spyOn(settings, 'config').mockReturnValue({
    ...settings.config(),
    MODEL_PROVIDER: 'openai',
    OPENAI_TRANSPORT: 'openrouter',
  })
  await query("UPDATE system_state SET mode='emergency_stop'")
  const interpreter = vi.fn(async () => ({
    rules: { ...defaultTradingRules(), maxOrderUsdt: '100' },
    managerNotes: [],
    issues: [],
  }))
  await expect(
    applyTradingInstructions(input('Покупать не дороже ста USDT.', 1), interpreter),
  ).rejects.toThrow('STOPPED')
  expect(interpreter).not.toHaveBeenCalled()
  await query("UPDATE system_state SET mode='running'")
  await expect(
    applyTradingInstructions(input('Покупать не дороже ста USDT.', 1), interpreter),
  ).rejects.toThrow('TRADING_INSTRUCTION_ORDER_LIMIT')
  expect((await tradingInstructions()).rules.blockedSymbols).toEqual(['BTC-USDT'])
  expect((await tradingInstructions()).revision).toBe(1)
})

it('reuses the result of a paid interpretation after a lost response without another model call', async () => {
  vi.spyOn(settings, 'config').mockReturnValue({
    ...settings.config(),
    MODEL_PROVIDER: 'openai',
    OPENAI_TRANSPORT: 'openrouter',
  })
  const request = input('Используй для покупок только эфир.')
  const interpreter = vi.fn(async () => ({
    rules: { ...defaultTradingRules(), allowedSymbols: ['ETH-USDT'] },
    managerNotes: [],
    issues: [],
  }))
  const result = await applyTradingInstructions(request, interpreter)
  expect(await applyTradingInstructions(request, interpreter)).toEqual(result)
  expect(interpreter).toHaveBeenCalledOnce()
  expect(
    await query("SELECT id FROM budget_reservations WHERE category='trading_instructions'"),
  ).toHaveLength(1)
})
