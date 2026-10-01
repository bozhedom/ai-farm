export const paymentErrors: Record<string, string> = {
  WRONG_CHAIN: 'RPC сообщил другую сеть. Подтверждение остановлено до восстановления Sepolia.',
  WRONG_RECEIVER: 'Адрес получателя не совпадает со счётом. Укажите хеш правильного перевода.',
  WRONG_AMOUNT: 'Сумма перевода не совпадает со счётом. Укажите хеш перевода с точной суммой.',
  TX_REVERTED: 'Транзакция завершилась ошибкой. Она не подтверждает оплату.',
  TX_HASH_MISMATCH: 'RPC вернул другую транзакцию. Оплата не подтверждена.',
  ONLY_NATIVE_TRANSFER_ALLOWED: 'Нужен обычный перевод тестового ETH без вызова контракта.',
  TX_OUTSIDE_INVOICE_WINDOW:
    'Перевод сделан вне срока действия счёта. Он не подтверждает этот заказ.',
  BLOCK_MISMATCH: 'Данные блока расходятся. Сверка повторится автоматически.',
  NON_CANONICAL_BLOCK: 'Блок не подтверждён основной цепочкой. Сверка повторится автоматически.',
  INVALID_BLOCK_HEIGHT: 'RPC вернул противоречивую высоту блока. Сверка повторится автоматически.',
  RPC_INVALID_RESPONSE: 'RPC вернул некорректные данные. Сверка повторится автоматически.',
  RPC_UNAVAILABLE: 'RPC временно недоступен. Сверка повторится автоматически.',
}
export function paymentErrorText(code: string | null) {
  return code
    ? paymentErrors[code] || 'Платёж пока не подтверждён. Требуется проверка владельцем.'
    : null
}

const jobErrors: Record<string, string> = {
  UNCERTAIN_CALL_REQUIRES_REVIEW:
    'Исход вызова модели неизвестен. Автоматический повтор запрещён, чтобы не списать деньги повторно.',
  ORDER_REVIEW_REQUIRED:
    'После оплаты прошло больше 30 минут. Автоматическое исполнение остановлено; требуется проверка владельцем.',
  OUTPUT_REVIEW_REQUIRED:
    'Проверка качества отклонила текст. Результат не выдан; требуется проверка владельцем.',
  OUTPUT_FORMAT_INVALID: 'Текст не соответствует формату услуги. Результат не выдан.',
  OPENAI_BUDGET_BLOCKED:
    'Общего остатка бюджета модели недостаточно. Лимит не повышается автоматически.',
  BUDGET_BLOCKED: 'Недостаточно бюджета для исполнения. Лимит не повышается автоматически.',
  LEASE_EXPIRED:
    'Обработчик прервался. Разрешённые попытки исчерпаны; требуется проверка владельцем.',
  PROVIDER_CHANGED:
    'Настройки провайдера изменились после начала задания. Повторная оплата запроса запрещена.',
}

export function orderProgress(
  order: Record<string, any>,
  job: Record<string, any> | null,
  state: Record<string, any>,
  now = new Date(),
) {
  const fresh = (value: Date | string | null, ms: number) => {
    const age = value ? now.getTime() - new Date(value).getTime() : Infinity
    return age >= -5000 && age < ms
  }
  let title = '',
    detail = '',
    tone: 'good' | 'warn' = 'warn'
  const canSubmit = order.status === 'awaiting_payment' && new Date(order.expires_at) > now
  if (order.status === 'delivered') {
    title = 'Результат выдан'
    detail = 'Тестовая оплата подтверждена, текст прошёл проверку качества и сохранён.'
    tone = 'good'
  } else if (order.status === 'manual_review') {
    title = 'Нужна проверка владельцем'
    detail = order.paid_at
      ? jobErrors[job?.error_code] ||
        'Автоматические попытки остановлены. Причина и исходный материал сохранены.'
      : 'За сутки после окончания счёта платёж не подтверждён. Автоматическая выдача остановлена, история перевода сохранена.'
  } else if (order.status === 'expired') {
    title = 'Срок счёта истёк'
    detail =
      'Оплата не подтверждена. Резерв исполнения освобождён; можно создать новый тестовый заказ.'
  } else if (order.status === 'awaiting_payment') {
    title = order.tx_hash ? 'Проверяем тестовый перевод' : 'Ожидаем тестовую оплату'
    detail = order.tx_hash
      ? paymentErrorText(order.payment_error) ||
        `Подтверждений: ${order.confirmations} из ${order.required_confirmations}. Сверка выполняется автоматически.`
      : 'После подтверждения оплаты заказ попадёт в очередь исполнения автоматически.'
    if (order.tx_hash && !fresh(state.payment_heartbeat, 120000))
      detail += ' Нет свежего сигнала сверки платежей; хеш сохранён.'
    if (!canSubmit)
      detail += order.tx_hash
        ? ' Срок отправки истёк. Ещё сутки проверяем ранее указанный хеш; новый перевод делать не нужно.'
        : ' Срок оплаты истёк; обработчик закроет счёт автоматически.'
  } else if (state.mode === 'emergency_stop') {
    title = 'Исполнение остановлено'
    detail =
      'Действует аварийный стоп. Оплата и обязательство сохранены; новые вызовы модели запрещены.'
  } else if (!fresh(state.worker_heartbeat, 90000)) {
    title = 'Ждём обработчик'
    detail =
      'Нет свежего сигнала обработчика. Оплата и задание сохранены; после запуска обработка возобновится в пределах срока и числа попыток.'
  } else if (
    !fresh(state.provider_readiness?.checkedAt, 90000) ||
    !state.provider_readiness?.model
  ) {
    title = 'Ждём готовности модели'
    detail = 'Заказ сохранён. Пока модель недоступна, новые попытки исполнения не расходуются.'
  } else if (job?.status === 'queued' && new Date(job.run_after) > now) {
    title = 'Назначена повторная попытка'
    detail =
      'Предыдущая попытка прервалась. Обработчик повторит допустимые действия автоматически; сохранённые ответы используются повторно.'
  } else {
    title = job?.status === 'running' ? 'Готовим и проверяем текст' : 'Заказ в очереди'
    detail =
      'Оплата подтверждена. Принятые заказы выполняются автоматически, в том числе при паузе исследований.'
  }
  return {
    title,
    detail,
    tone,
    canSubmit,
    errorCode: job?.error_code || order.payment_error || null,
  }
}
