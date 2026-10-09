import type { OrderStep, PublicOrderStatus } from './contracts/common'

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
  TX_ALREADY_USED:
    'Хеш перевода на сумму этого счёта уже закреплён за другим заказом. Сверьте переводы вручную.',
  PAID_ORDERS_LIMIT:
    'Тестовая оплата подтверждена, но дневной предел оплаченных заказов с сайта исчерпан. Исполнение не запускалось.',
  BUDGET_BLOCKED:
    'Тестовая оплата подтверждена, но бюджета модели на исполнение не хватило. Исполнение не запускалось.',
}
export function paymentErrorText(code: string | null) {
  return code
    ? paymentErrors[code] || 'Платёж пока не подтверждён. Требуется проверка владельцем.'
    : null
}

const jobErrors: Record<string, string> = {
  UNCERTAIN_CALL_REQUIRES_REVIEW:
    'Исход вызова модели неизвестен. Автоматический повтор запрещён, чтобы не списать деньги повторно. Проверьте журнал и расходы у провайдера; решение укажите при закрытии тестового заказа.',
  ORDER_REVIEW_REQUIRED:
    'После оплаты прошло больше 30 минут. Автоматическое исполнение остановлено; требуется проверка владельцем.',
  OUTPUT_REVIEW_REQUIRED:
    'Проверка качества отклонила текст. Результат не выдан; требуется проверка владельцем.',
  MODEL_SCHEMA_INVALID:
    'Модель ответила в неверном формате. Результат не выдан. Проверьте журнал и настройки модели, затем укажите решение при закрытии тестового заказа.',
  OUTPUT_FORMAT_INVALID:
    'Текст не соответствует формату услуги. Результат не выдан. Проверьте требования услуги и укажите причину при закрытии тестового заказа.',
  OUTPUT_FORMAT_REQUIRED:
    'В тексте нет обязательных частей результата. Результат не выдан. Проверьте требования услуги и укажите причину при закрытии тестового заказа.',
  MODEL_OUTPUT_INCOMPLETE:
    'Модель не завершила ответ. Неполный результат не выдан. Проверьте журнал и состояние запроса у провайдера, затем укажите решение при закрытии тестового заказа.',
  OPENROUTER_RESPONSE_ERROR:
    'OpenRouter сообщил об ошибке запроса. Результат не выдан. Проверьте журнал и состояние провайдера, затем укажите решение при закрытии тестового заказа.',
  TRANSLATION_LANGUAGE_REQUIRED:
    'В сохранённом материале не указан язык перевода. Автоматическое исполнение остановлено; требуется проверка владельцем.',
  OUTPUT_SOURCE_DUPLICATE: 'Модель не выбрала три разных оформления. Результат не выдан.',
  PRODUCT_RECIPE_REFRESH_REQUIRED:
    'Локальная модель не выполняет прежний рецепт публикаций. Снимок и обязательство сохранены; требуется проверка владельцем.',
  OPENROUTER_COST_REVIEW_REQUIRED:
    'OpenRouter сообщил ненулевую плату. Запросы остановлены до проверки расходов в кабинете провайдера.',
  OPENAI_BUDGET_BLOCKED:
    'Общего остатка бюджета модели недостаточно. Лимит не повышается автоматически.',
  BUDGET_BLOCKED: 'Недостаточно бюджета для исполнения. Лимит не повышается автоматически.',
  LEASE_EXPIRED:
    'Обработчик прервался. Разрешённые попытки исчерпаны; требуется проверка владельцем.',
  LEASE_LOST:
    'Обработчик больше не может продолжать это задание. Результат не выдан. Проверьте состояние служб и журнал, затем укажите решение при закрытии тестового заказа.',
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
    title = 'Готово'
    detail =
      order.source === 'public'
        ? 'Текст прошёл проверку, покупатель его видит.'
        : 'Текст прошёл проверку и сохранён.'
    tone = 'good'
  } else if (order.status === 'closed') {
    title = 'Тестовый заказ закрыт'
    detail =
      'Владелец завершил проверку и закрыл тестовое обязательство без выдачи. Причина, платёж и история расходов сохранены; возврат не выполнялся.'
  } else if (order.status === 'manual_review') {
    title = 'Нужна проверка владельцем'
    detail = order.paid_at
      ? jobErrors[job?.error_code] ||
        (!job && paymentErrorText(order.payment_error)) ||
        'Автоматические попытки остановлены. Причина и исходный материал сохранены.'
      : (order.payment_error === 'TX_ALREADY_USED' && paymentErrorText(order.payment_error)) ||
        'За сутки после окончания счёта платёж не подтверждён. Автоматическая выдача остановлена, история перевода сохранена.'
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
    canResolve:
      order.status === 'manual_review' && ['sandbox', 'sepolia'].includes(order.payment_mode),
    errorCode: job?.error_code || order.payment_error || null,
  }
}

/** Buyer wording for payment problems. No codes, hashes or node details. */
const buyerPaymentErrors: Record<string, string> = {
  WRONG_AMOUNT: 'Сумма перевода не совпадает со счётом. Переведите точную сумму.',
  WRONG_RECEIVER: 'Перевод ушёл на другой адрес. Проверьте адрес получателя.',
  TX_REVERTED: 'Сеть отклонила перевод. Попробуйте отправить ещё раз.',
  ONLY_NATIVE_TRANSFER_ALLOWED: 'Нужен обычный перевод тестового ETH, без токенов и контрактов.',
  TX_OUTSIDE_INVOICE_WINDOW: 'Перевод сделан вне срока счёта, он не подходит к этому заказу.',
  TX_HASH_MISMATCH: 'Не нашли такой перевод. Проверьте номер транзакции.',
}
export function publicPaymentText(code: string | null | undefined) {
  return code ? buyerPaymentErrors[code] || null : null
}

type Tone = 'good' | 'warn'
export type PublicProgress = {
  status: PublicOrderStatus
  steps: OrderStep[]
  message: { title: string; detail: string; tone: Tone }
}

/**
 * What a buyer sees about an order: a short status, four steps and one message. Strategies,
 * product versions, attempts, error codes and model details never appear here.
 */
export function publicProgress(
  order: Record<string, any>,
  job: Record<string, any> | null,
  generatedAt: Date | string | null,
  state: Record<string, any>,
  now = new Date(),
): PublicProgress {
  const iso = (value: Date | string | null | undefined) =>
    value ? new Date(value).toISOString() : null
  const delivered = order.status === 'delivered'
  const paid = !!order.paid_at || ['paid', 'running', 'delivered'].includes(order.status)
  const written = !!generatedAt || delivered
  const steps: OrderStep[] = [
    { label: 'Оплачен', at: iso(order.paid_at), done: paid },
    { label: 'Пишем текст', at: iso(generatedAt), done: written },
    { label: 'Проверяем', at: iso(order.delivered_at), done: delivered },
    { label: 'Готово', at: iso(order.delivered_at), done: delivered },
  ]
  const say = (status: PublicOrderStatus, title: string, detail: string, tone: Tone = 'warn') => ({
    status,
    steps,
    message: { title, detail, tone },
  })
  switch (order.status) {
    case 'delivered':
      return say('delivered', 'Готово', 'Текст ниже. Его можно скопировать или скачать.', 'good')
    case 'closed':
      return say('closed', 'Заказ закрыт', 'Владелец закрыл заказ без выдачи текста.')
    case 'expired':
      return say('expired', 'Срок оплаты истёк', 'Оформите заказ заново, это займёт минуту.')
    case 'manual_review':
      if (paid && ['PAID_ORDERS_LIMIT', 'BUDGET_BLOCKED'].includes(order.payment_error))
        return say(
          'needs_attention',
          'Оплата получена, но сегодня не успеем',
          'На сегодня мы набрали заказов больше, чем можем сделать. Владелец посмотрит ваш заказ вручную.',
        )
      if (!paid && order.payment_error === 'TX_ALREADY_USED')
        return say(
          'needs_attention',
          'Проверяем перевод вручную',
          'Этот перевод указали и в другом заказе. Владелец разберётся сам.',
        )
      return paid
        ? say(
            'needs_attention',
            'Текст не прошёл нашу проверку',
            'Владелец посмотрит заказ вручную.',
          )
        : say(
            'needs_attention',
            'Проверяем перевод вручную',
            'Перевод не подтвердился вовремя. Владелец посмотрит его сам.',
          )
    case 'awaiting_payment': {
      if (!order.tx_hash) {
        if (new Date(order.expires_at) <= now)
          return say('awaiting_payment', 'Срок оплаты истёк', 'Оформите заказ заново.')
        return order.payment_mode === 'sepolia'
          ? say(
              'awaiting_payment',
              'Ждём перевод',
              'Переведите точную сумму. Перевод мы найдём сами.',
            )
          : say('awaiting_payment', 'Ждём оплату', 'После оплаты сразу начнём писать текст.')
      }
      const problem = publicPaymentText(order.payment_error)
      if (problem) return say('checking_payment', 'Перевод не подходит к заказу', problem)
      const required = Number(order.required_confirmations) || 3
      const confirmations = Math.min(Number(order.confirmations) || 0, required)
      return confirmations > 0
        ? say(
            'checking_payment',
            `Перевод найден, ждём подтверждений ${confirmations} из ${required}`,
            'Обычно это 1-2 минуты. Страницу можно закрыть.',
          )
        : say(
            'checking_payment',
            'Перевод отправлен',
            'Ждём, когда сеть его примет. Обычно это меньше минуты.',
          )
    }
    default: {
      const fresh =
        !!state.worker_heartbeat &&
        now.getTime() - new Date(state.worker_heartbeat).getTime() < 90000
      if (written) return say('in_progress', 'Проверяем', 'Текст готов, проверяем его. Ещё минута.')
      if (job?.status === 'queued' && Number(job.attempts) > 0)
        return say('in_progress', 'Пишем текст', 'Не получилось с первого раза, пробуем ещё.')
      if (fresh && order.status === 'paid' && state.mode !== 'emergency_stop')
        return say(
          'in_progress',
          'Оплачено',
          'Пишем текст. Обычно 2-5 минут, страницу можно закрыть.',
          'good',
        )
      if (!fresh || state.mode === 'emergency_stop')
        return say(
          'in_progress',
          'Пишем текст',
          'Немного задерживаемся. Страницу можно закрыть, текст появится здесь.',
        )
      return say('in_progress', 'Пишем текст', 'Обычно 2-5 минут. Страницу можно закрыть.')
    }
  }
}
