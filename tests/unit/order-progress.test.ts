import { expect, it } from 'vitest'
import { orderProgress } from '../../core/order-progress'

const now = new Date('2026-10-01T10:00:00Z')
const state = {
  mode: 'paused',
  worker_heartbeat: now,
  payment_heartbeat: now,
  provider_readiness: { model: true, checkedAt: now },
}
it('reports offline and emergency execution without claiming work is running', () => {
  const order = { status: 'paid', paid_at: now }
  expect(orderProgress(order, null, state, now).title).toBe('Заказ в очереди')
  expect(orderProgress(order, null, { ...state, worker_heartbeat: null }, now).title).toBe(
    'Ждём обработчик',
  )
  expect(orderProgress(order, null, { ...state, mode: 'emergency_stop' }, now).title).toBe(
    'Исполнение остановлено',
  )
  expect(
    orderProgress(
      order,
      null,
      { ...state, provider_readiness: { model: false, checkedAt: now } },
      now,
    ).title,
  ).toBe('Ждём готовности модели')
})
it('separates an expired submission window from ongoing payment reconciliation', () => {
  const progress = orderProgress(
    {
      status: 'awaiting_payment',
      tx_hash: 'saved',
      expires_at: '2026-10-01T09:59:00Z',
      confirmations: 2,
      required_confirmations: 5,
    },
    null,
    state,
    now,
  )
  expect(progress.canSubmit).toBe(false)
  expect(progress.detail).toContain('2 из 5')
  expect(progress.detail).toContain('новый перевод делать не нужно')
})
it('preserves the reason for stopping an uncertain paid call', () => {
  const progress = orderProgress(
    { status: 'manual_review', paid_at: now },
    { error_code: 'UNCERTAIN_CALL_REQUIRES_REVIEW' },
    state,
    now,
  )
  expect(progress.detail).toContain('не списать деньги повторно')
  expect(progress.canSubmit).toBe(false)
})
it('offers owner resolution only for test review and keeps a closed order distinct from delivery', () => {
  expect(
    orderProgress({ status: 'manual_review', payment_mode: 'sandbox' }, null, state, now)
      .canResolve,
  ).toBe(true)
  expect(
    orderProgress({ status: 'manual_review', payment_mode: 'sepolia' }, null, state, now)
      .canResolve,
  ).toBe(true)
  expect(
    orderProgress({ status: 'manual_review', payment_mode: 'mainnet' }, null, state, now)
      .canResolve,
  ).toBe(false)
  const closed = orderProgress(
    {
      status: 'closed',
      payment_mode: 'sandbox',
      paid_at: now,
      resolution_reason: 'Тест завершён.',
    },
    { status: 'failed', error_code: 'OUTPUT_REVIEW_REQUIRED' },
    { mode: 'emergency_stop' },
    now,
  )
  expect(closed).toMatchObject({
    title: 'Тестовый заказ закрыт',
    canSubmit: false,
    canResolve: false,
    errorCode: 'OUTPUT_REVIEW_REQUIRED',
  })
  expect(closed.detail).toContain('без выдачи')
  expect(closed.detail).toContain('возврат не выполнялся')
})
