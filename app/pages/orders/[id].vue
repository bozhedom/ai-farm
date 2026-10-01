<script setup lang="ts">
const route = useRoute()
const order = ref<any>(null),
  hash = ref(''),
  error = ref(''),
  connectionError = ref(''),
  busy = ref(false)
let loading = false,
  stopped = false
let timer: ReturnType<typeof setInterval>
async function load() {
  if (loading || stopped) return
  loading = true
  const id = route.params.id
  try {
    const result = await $fetch('/api/orders/' + id, { timeout: 10000 })
    if (!stopped && id === route.params.id) {
      order.value = result
      connectionError.value = ''
    }
  } catch (e: any) {
    if (e.statusCode === 401) await navigateTo('/login')
    else connectionError.value = 'Не удалось обновить заказ. Ниже — последние полученные данные.'
  } finally {
    loading = false
  }
}
onMounted(() => {
  void load()
  timer = setInterval(() => void load(), 3000)
})
onUnmounted(() => {
  stopped = true
  clearInterval(timer)
})
watch(
  () => route.params.id,
  () => {
    order.value = null
    hash.value = ''
    error.value = ''
    void load()
  },
)
async function pay() {
  busy.value = true
  error.value = ''
  try {
    await $fetch('/api/orders/' + route.params.id + '/pay', {
      method: 'POST',
      body:
        order.value.payment_mode === 'sandbox'
          ? { mode: 'sandbox' }
          : { mode: 'sepolia', hash: hash.value },
    })
    hash.value = ''
    await load()
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
const amount = computed(() => {
  const value = BigInt(order.value?.amount_wei || '0'),
    unit = 10n ** 18n
  return `${value / unit}.${String(value % unit).padStart(18, '0')}`
})
function download() {
  const blob = new Blob([order.value.result], { type: 'text/plain;charset=utf-8' }),
    url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `ai-farm-${order.value.id.slice(0, 8)}.txt`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>
<template>
  <FarmShell>
    <NuxtLink class="back-link" to="/?view=orders">← Все заказы</NuxtLink>
    <div class="page-heading">
      <div>
        <div class="eyebrow">ТЕСТОВЫЙ ЗАКАЗ / {{ String(route.params.id).slice(0, 8) }}</div>
        <h1>{{ order?.product_snapshot?.name || 'Загружаем заказ…' }}</h1>
        <p>Оплата и результат относятся к тестовому контуру.</p>
      </div>
      <span
        v-if="order"
        class="status-pill"
        :class="order.status === 'delivered' ? 'good' : 'warn'"
        >{{ labels[order.status] }}</span
      >
    </div>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <p v-if="connectionError" class="notice error" role="alert">{{ connectionError }}</p>
    <template v-if="order">
      <section class="panel" aria-label="Ход заказа">
        <div class="section-heading">
          <h2>{{ order.progress.title }}</h2>
          <span v-if="order.job" class="tag"
            >Попытки {{ order.job.attempts }} / {{ order.job.max_attempts }}</span
          >
        </div>
        <p>{{ order.progress.detail }}</p>
        <p v-if="order.progress.errorCode" class="muted small-text">
          Код причины: <code>{{ order.progress.errorCode }}</code>
        </p>
        <p v-if="order.status === 'manual_review' && order.review?.reason">
          {{ order.review.reason }}
        </p>
        <p v-if="order.job?.status === 'queued' && order.job.error_code" class="muted small-text">
          Повтор разрешён не раньше {{ dateTime(order.job.run_after) }}.
        </p>
        <ol class="order-steps">
          <li
            v-for="(step, index) in order.steps"
            :key="step.label"
            :class="{ complete: step.done }"
          >
            <span class="step-number" aria-hidden="true">{{
              step.done ? '✓' : Number(index) + 1
            }}</span>
            <div>
              <strong>{{ step.label }}</strong
              ><span>{{
                step.at ? dateTime(step.at) : step.done ? 'Время не сохранено' : 'Не выполнено'
              }}</span>
            </div>
          </li>
        </ol>
      </section>
      <div class="two-columns order-columns">
        <section class="panel">
          <div class="section-heading">
            <h2>Исходный материал</h2>
            <span class="tag">Версия {{ order.product_snapshot.version }}</span>
          </div>
          <p class="preserve-text">{{ order.input }}</p>
          <div class="order-meta">
            <span>Стратегия: {{ order.strategy_snapshot.name }}</span
            ><span>Создан {{ dateTime(order.created_at) }}</span>
          </div>
        </section>
        <section class="panel payment-panel">
          <div class="eyebrow">
            {{
              order.payment_mode === 'sandbox'
                ? 'SANDBOX · БЕЗ ПЕРЕВОДА'
                : 'ETHEREUM SEPOLIA · CHAIN 11155111'
            }}
          </div>
          <h2>Тестовая оплата</h2>
          <strong class="payment-amount">{{ amount }}<small> TEST ETH</small></strong>
          <template v-if="order.progress.canSubmit">
            <template v-if="order.payment_mode === 'sandbox'">
              <p>
                Кнопка имитирует успешную оплату. После подтверждения worker подготовит результат
                автоматически.
              </p>
              <button class="button primary" :disabled="busy || !!connectionError" @click="pay">
                {{ busy ? 'Подтверждаем…' : 'Подтвердить тестовую оплату' }}
              </button>
            </template>
            <form v-else @submit.prevent="pay">
              <p>
                Отправьте точную сумму тестового ETH на адрес ниже в сети Sepolia. Не отправляйте
                реальные средства.
              </p>
              <code class="wallet-address">{{ order.receiver }}</code>
              <p class="muted small-text">
                Счёт действует до {{ dateTime(order.expires_at) }}. Нужно
                {{ order.required_confirmations }} подтверждения(ий).
              </p>
              <label for="txhash">{{
                order.tx_hash
                  ? 'Другой хеш, если перевод был указан ошибочно'
                  : 'Хеш тестовой транзакции'
              }}</label>
              <input
                id="txhash"
                v-model="hash"
                required
                pattern="0x[0-9a-fA-F]{64}"
                placeholder="0x…"
                autocomplete="off"
              />
              <button class="button primary" :disabled="busy || !!connectionError">
                {{ busy ? 'Сохраняем…' : order.tx_hash ? 'Заменить хеш' : 'Проверять оплату' }}
              </button>
            </form>
          </template>
          <p v-else-if="order.paid_at" class="payment-success">
            ✓ Тестовая оплата подтверждена {{ dateTime(order.paid_at) }}
          </p>
          <p v-else class="muted">Приём новых платежей по этому счёту закрыт.</p>
          <details v-if="order.payment_proof" class="payment-proof">
            <summary>Сохранённое подтверждение Sepolia</summary>
            <p class="small-text">
              Блок {{ order.payment_proof.blockNumber }} ·
              {{ dateTime(order.payment_proof.blockTime) }} · подтверждений на момент приёма:
              {{ order.payment_proof.confirmations }}
            </p>
            <code class="wallet-address">{{ order.payment_proof.hash }}</code>
          </details>
        </section>
      </div>
      <section v-if="order.paymentAttempts.length" class="panel" aria-label="История переводов">
        <div class="section-heading">
          <h2>История переводов</h2>
          <span class="tag">Sepolia</span>
        </div>
        <p class="muted small-text">
          Последние 20 хешей. Каждый остаётся закреплён за этим заказом после замены.
        </p>
        <div
          v-for="attempt in order.paymentAttempts"
          :key="attempt.tx_hash"
          class="payment-attempt"
        >
          <div class="section-heading">
            <span class="tag">{{
              attempt.confirmed_at ? 'Подтверждён' : attempt.active ? 'Текущий хеш' : 'Заменён'
            }}</span
            ><span class="muted small-text">{{ dateTime(attempt.submitted_at) }}</span>
          </div>
          <code class="wallet-address">{{ attempt.tx_hash }}</code>
          <p>
            {{
              attempt.errorText ||
              (attempt.checked_at
                ? `Подтверждений при последней сверке: ${attempt.confirmations}`
                : 'Сверка ещё не завершена.')
            }}
          </p>
          <p v-if="attempt.checked_at" class="muted small-text">
            Последняя сверка {{ dateTime(attempt.checked_at) }}
          </p>
        </div>
      </section>
      <section v-if="order.status === 'delivered'" class="panel result-panel">
        <div class="section-heading">
          <div>
            <div class="eyebrow">ПРОВЕРКА ПРОЙДЕНА</div>
            <h2>Результат заказа</h2>
          </div>
          <button class="button secondary" @click="download">Скачать TXT ↓</button>
        </div>
        <pre>{{ order.result }}</pre>
        <p class="muted small-text">{{ order.review?.reason }}</p>
      </section>
    </template>
  </FarmShell>
</template>
