<script setup lang="ts">
const route = useRoute(),
  order = ref<any>(null),
  hash = ref(''),
  error = ref(''),
  busy = ref(false)
let timer: ReturnType<typeof setInterval>
async function load() {
  try {
    order.value = await $fetch('/api/orders/' + route.params.id)
  } catch (e: any) {
    if (e.statusCode === 401) await navigateTo('/login')
    else error.value = errorText(e)
  }
}
onMounted(() => {
  void load()
  timer = setInterval(() => void load(), 3000)
})
onUnmounted(() => clearInterval(timer))
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
    await load()
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
const amount = computed(() => {
  const value = order.value?.amount_wei || '0'
  return '0.' + String(value).padStart(18, '0')
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
  <FarmShell
    ><NuxtLink class="back-link" to="/?view=orders">← Все заказы</NuxtLink>
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
    <template v-if="order"
      ><div class="two-columns order-columns">
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
          <strong class="payment-amount">{{ amount }}<small> TEST ETH</small></strong
          ><template v-if="order.status === 'awaiting_payment'"
            ><template v-if="order.payment_mode === 'sandbox'"
              ><p>
                Кнопка имитирует успешную оплату. После подтверждения worker подготовит результат
                автоматически.
              </p>
              <button class="button primary" :disabled="busy" @click="pay">
                {{ busy ? 'Подтверждаем…' : 'Подтвердить тестовую оплату' }}
              </button></template
            >
            <form v-else @submit.prevent="pay">
              <p>
                Отправьте точную сумму тестового ETH на адрес ниже в сети Sepolia. Не отправляйте
                реальные средства.
              </p>
              <code class="wallet-address">{{ order.receiver }}</code>
              <p class="muted small-text">
                Счёт действует до {{ dateTime(order.expires_at) }}. Нужно минимум 3 подтверждения.
              </p>
              <label for="txhash">Хеш тестовой транзакции</label
              ><input
                id="txhash"
                v-model="hash"
                required
                pattern="0x[0-9a-fA-F]{64}"
                placeholder="0x…"
              /><button class="button primary" :disabled="busy">Проверять оплату</button>
              <p v-if="order.tx_hash" class="small-text">
                Подтверждений: {{ order.confirmations }}. Сверка продолжается автоматически.
              </p>
              <p v-if="order.payment_error" class="error-text">{{ order.payment_error }}</p>
            </form></template
          >
          <p v-else-if="['paid', 'running'].includes(order.status)" class="notice">
            Оплата подтверждена. Система готовит и проверяет результат; страница обновится
            автоматически.
          </p>
          <p v-else-if="order.status === 'delivered'" class="payment-success">
            ✓ Оплата проверена · результат готов
          </p>
          <p v-else-if="order.status === 'manual_review'" class="error-text">
            Автоматическая обработка остановлена. Причина сохранена в журнале. Это тестовый заказ;
            реального списания не было.
            <span v-if="order.review?.reason">{{ order.review.reason }}</span>
          </p>
          <p v-else class="muted">Срок счёта истёк. Создайте новый заказ в витрине.</p>
        </section>
      </div>
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
      </section></template
    >
  </FarmShell>
</template>
