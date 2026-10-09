<script setup lang="ts">
import type { PublicCatalog, PublicOrderView } from '../../../core/contracts/public'
import { formatRub } from '../../../core/storefront'
import { orderTokenPattern, publicErrorCode, publicWhen, rememberOrder } from '~/utils/public-site'

const route = useRoute()
const token = String(route.params.token)
// Only a well-formed token ever reaches a URL: anything else (`..%2F`, slashes) is no order.
const valid = orderTokenPattern.test(token)
const [{ data: first, error: firstError }, { data: shop }] = await Promise.all([
  valid
    ? useFetch<PublicOrderView>(`/api/public/orders/${token}`, { key: `order-${token}` })
    : { data: ref<PublicOrderView | null>(null), error: ref(null) },
  useFetch<Pick<PublicCatalog, 'notice' | 'seller'>>('/api/public/catalog', {
    key: 'shop-frame',
    pick: ['notice', 'seller'],
  }),
])
const order = ref<PublicOrderView | null>(first.value || null)
const missing = ref(
  !valid || (!first.value && publicErrorCode(firstError.value) === 'ORDER_NOT_FOUND'),
)
const offline = ref(!first.value && !missing.value)
if (import.meta.server && missing.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}
const number = computed(() =>
  order.value
    ? order.value.number
      ? `№${order.value.number}`
      : order.value.id.replace(/-/g, '').slice(0, 6).toUpperCase()
    : '',
)
useHead({ title: () => (order.value ? `Заказ ${number.value}. AI Farm` : 'Заказ. AI Farm') })
function remember() {
  if (order.value)
    rememberOrder({
      token,
      name: order.value.service.name,
      at: order.value.createdAt,
      status: order.value.status,
    })
}
const link = `${useRequestURL().origin}/order/${token}`
const final = ['delivered', 'expired', 'closed']
const tone: Record<string, string> = {
  awaiting_payment: 'badge-wait',
  checking_payment: 'badge-wait',
  in_progress: 'badge-wait',
  delivered: 'badge-ok',
  needs_attention: 'badge-human',
  expired: 'badge-off',
  closed: 'badge-off',
}
const statusLabel: Record<string, string> = {
  awaiting_payment: 'Ждём оплату',
  checking_payment: 'Проверяем перевод',
  in_progress: 'В работе',
  delivered: 'Готово',
  needs_attention: 'Нужен человек',
  expired: 'Срок истёк',
  closed: 'Закрыт',
}
const paying = computed(
  () => !!order.value && ['awaiting_payment', 'checking_payment'].includes(order.value.status),
)

async function load() {
  if (!valid) return
  try {
    order.value = await $fetch<PublicOrderView>(`/api/public/orders/${token}`)
    offline.value = false
    missing.value = false
    remember()
  } catch (e) {
    if (publicErrorCode(e) === 'ORDER_NOT_FOUND') {
      missing.value = true
      order.value = null
    } else offline.value = true
  }
}

// Poll while something can still change; stop on a final status.
let timer: ReturnType<typeof setTimeout> | undefined
function schedule() {
  clearTimeout(timer)
  const status = order.value?.status
  if (missing.value || (status && final.includes(status))) return
  timer = setTimeout(
    async () => {
      if (document.visibilityState !== 'hidden') await load()
      schedule()
    },
    status === 'needs_attention' ? 30000 : 4000,
  )
}
onMounted(() => {
  remember()
  schedule()
})
onBeforeUnmount(() => clearTimeout(timer))
async function changed() {
  await load()
  schedule()
}

const sandboxBusy = ref(false)
const sandboxError = ref('')
const stale = ref(false)
async function paySandbox() {
  if (!valid) return
  sandboxBusy.value = true
  sandboxError.value = ''
  try {
    await $fetch(`/api/public/orders/${token}/pay`, { method: 'POST', body: { mode: 'sandbox' } })
    await changed()
  } catch (e) {
    const code = publicErrorCode(e)
    stale.value = code === 'INVOICE_EXPIRED' || code === 'ORDER_NOT_PAYABLE'
    sandboxError.value = stale.value
      ? 'Ссылка на оплату устарела. Оформите заказ заново.'
      : code === 'PUBLIC_CAPACITY_REACHED'
        ? 'На сегодня заказов больше, чем мы успеем сделать. Загляните завтра.'
        : code === 'SANDBOX_PAY_DISABLED'
          ? 'Оплату этого заказа подтверждает продавец.'
          : 'Оплата не прошла. Попробуйте ещё раз.'
  } finally {
    sandboxBusy.value = false
  }
}

const mounted = ref(false)
onMounted(() => (mounted.value = true))
</script>

<template>
  <PublicShell :notice="shop?.notice" :seller="shop?.seller" active="order">
    <div class="container">
      <div class="order">
        <div v-if="missing" class="empty">
          <h3>Такого заказа нет</h3>
          <p>Проверьте ссылку: её нужно скопировать целиком.</p>
          <NuxtLink class="btn btn-primary" to="/">Все услуги</NuxtLink>
        </div>
        <div v-else-if="!order" class="empty">
          <h3>Нет связи</h3>
          <p>Не получилось загрузить заказ. Обновите страницу через минуту.</p>
        </div>
        <template v-else>
          <p v-if="offline" class="note note-wait" role="status">
            Нет связи. Показываем последнее состояние.
          </p>
          <div class="order-head">
            <div class="head-text">
              <span class="eyebrow"
                >Заказ <span class="mono order-no">{{ number }}</span></span
              >
              <h1>{{ order.service.name }}</h1>
              <p v-if="order.inputPreview" class="muted preview">{{ order.inputPreview }}</p>
            </div>
            <span class="badge badge-lg" :class="tone[order.status]">{{
              statusLabel[order.status]
            }}</span>
          </div>

          <div class="link-row">
            <PublicCopyButton :text="link" label="Скопировать ссылку" small />
            <span class="muted small">По этой ссылке вы вернётесь к заказу</span>
          </div>

          <section class="card card-pad-lg status-card" aria-live="polite">
            <div class="message">
              <h2>{{ order.message.title }}</h2>
              <p class="muted">{{ order.message.detail }}</p>
              <p
                v-if="order.status === 'needs_attention' || order.status === 'closed'"
                class="small"
              >
                <template v-if="order.contact">Написать продавцу: {{ order.contact }}</template>
              </p>
            </div>
            <PublicOrderSteps
              :steps="order.steps"
              :active="!final.includes(order.status) && !paying"
            />
            <div class="summary">
              <div>
                <span class="eyebrow">Цена</span>
                <b>{{ formatRub(order.price.kopecks) }}</b>
                <span v-if="order.price.test" class="badge badge-test">Тестовая оплата</span>
              </div>
              <div>
                <span class="eyebrow">Оформлен</span>
                <b>{{ mounted ? publicWhen(order.createdAt) : '' }}</b>
              </div>
            </div>
          </section>

          <section v-if="paying" class="card card-pad-lg pay-card">
            <h2>Оплата</h2>
            <template v-if="order.payment.mode === 'sandbox'">
              <p v-if="order.payment.canConfirm" class="muted">
                Деньги не списываются: это тестовая кнопка вместо настоящей оплаты.
              </p>
              <p v-else class="muted">
                Оплата тестовая, деньги не списываются. Её подтверждает продавец, после этого сразу
                начнём писать текст. Страницу можно закрыть, ссылка сохранится.
              </p>
              <button
                v-if="order.payment.canConfirm"
                class="btn btn-primary btn-lg"
                type="button"
                :disabled="sandboxBusy"
                @click="paySandbox"
              >
                {{
                  sandboxBusy ? 'Оплачиваем…' : `Оплатить ${formatRub(order.price.kopecks)} (тест)`
                }}
              </button>
              <p v-if="sandboxError" class="note note-err" role="alert">{{ sandboxError }}</p>
              <NuxtLink v-if="stale" class="btn" :to="`/services/${order.service.slug}`"
                >Оформить заново</NuxtLink
              >
            </template>
            <PublicCryptoPay
              v-else
              :payment="order.payment"
              :token="token"
              :expires-at="order.expiresAt"
              @changed="changed"
            />
          </section>

          <section v-if="order.result" class="card card-pad-lg result-card">
            <div class="card-head">
              <div>
                <h2>Ваш текст</h2>
                <p class="muted small">Прошёл проверку: только факты из вашего текста.</p>
              </div>
            </div>
            <div id="result" class="result-box result-text">{{ order.result.text }}</div>
            <div class="card-foot">
              <div class="result-actions">
                <a class="btn btn-primary" :href="order.result.downloadUrl" download>
                  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 3v12M6 11l6 6 6-6M4 21h16" />
                  </svg>
                  Скачать .txt
                </a>
                <PublicCopyButton :text="order.result.text" />
              </div>
              <NuxtLink class="btn btn-ghost" to="/">Заказать ещё</NuxtLink>
            </div>
          </section>

          <div v-if="order.status === 'expired'" class="again">
            <NuxtLink class="btn btn-primary" :to="`/services/${order.service.slug}`"
              >Оформить заново</NuxtLink
            >
          </div>
        </template>
      </div>
    </div>
  </PublicShell>
</template>

<style scoped>
.order {
  max-width: 860px;
  margin: 0 auto;
  padding: var(--s-8) 0 var(--s-16);
  display: grid;
  gap: var(--s-5);
}
.order-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--s-4);
}
.head-text {
  min-width: 0;
}
.order-head h1 {
  font-size: var(--text-2xl);
  margin-top: 4px;
}
.order-no {
  text-transform: none;
  letter-spacing: 0;
}
.preview {
  white-space: pre-line;
  overflow-wrap: anywhere;
  margin-top: 4px;
}
.link-row {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  flex-wrap: wrap;
  margin-top: calc(-1 * var(--s-2));
}
.status-card {
  display: grid;
  gap: var(--s-6);
}
.message h2 {
  font-size: var(--text-xl);
}
.message .muted {
  margin-top: 4px;
}
.summary {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--s-3);
}
.summary div {
  background: var(--surface-2);
  border-radius: var(--r-md);
  padding: var(--s-3) var(--s-4);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}
.summary .eyebrow {
  flex-basis: 100%;
}
.summary b {
  font-weight: 600;
}
.pay-card {
  display: grid;
  gap: var(--s-4);
  justify-items: start;
}
.pay-card > :deep(.crypto) {
  width: 100%;
}
.result-text {
  font-size: var(--text-md);
}
.result-actions {
  display: flex;
  gap: var(--s-3);
  flex-wrap: wrap;
}
.again {
  display: flex;
}
@media (max-width: 639px) {
  .summary {
    grid-template-columns: 1fr;
  }
  .order-head {
    flex-direction: column;
  }
  .result-actions .btn,
  .result-actions :deep(.btn) {
    flex: 1 1 auto;
  }
}
</style>
