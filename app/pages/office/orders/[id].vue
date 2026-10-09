<script setup lang="ts">
import { formatEth } from '../../../../core/storefront'
import { copyText, officeApi, useOfficeAction, useOfficeToast } from '~/composables/office/actions'
import { useOwnerOrder } from '~/composables/office/data'
import { orderNumber, rub, when } from '~/composables/office/format'
import { orderBadge } from '~/composables/office/labels'

const route = useRoute()
const id = computed(() => String(route.params.id))
const { data: order, status, pending, refresh } = useOwnerOrder(id)
useHead({
  title: computed(() => (order.value ? `Заказ №${orderNumber(order.value)}` : 'Заказ')),
})
const { busy, run } = useOfficeAction()
const { show } = useOfficeToast()

const reason = ref('')
const hash = ref('')
watch(id, () => {
  reason.value = ''
  hash.value = ''
  relinkAsk.value = false
  buyerLink.value = ''
})

// The buyer's link is stored only as a hash, so it cannot be shown again. The owner can issue a
// new one; the old link stops working at once, so the buyer has to get the new one.
const relinkAsk = ref(false)
const buyerLink = ref('')
async function relink() {
  const done = await run(
    'relink',
    () => officeApi.relinkOrder(id.value),
    'Новая ссылка готова. Старая больше не открывается.',
  )
  if (done) {
    buyerLink.value = new URL(done.url, window.location.origin).toString()
    relinkAsk.value = false
  }
}
async function copyLink() {
  show(
    (await copyText(buyerLink.value)) ? 'Ссылка скопирована.' : 'Не получилось скопировать.',
    'ok',
  )
}

const price = computed(() => (order.value?.price_kopecks ? rub(order.value.price_kopecks) : ''))
const ethAmount = computed(() => {
  try {
    return order.value?.amount_wei ? formatEth(order.value.amount_wei) : ''
  } catch {
    return ''
  }
})
const currentStep = computed(() => order.value?.steps.findIndex((s) => !s.done) ?? -1)
const isTest = computed(() => order.value?.is_test_payment !== false)

async function resolve() {
  const done = await run(
    'resolve',
    () => officeApi.resolveOrder(id.value, reason.value.trim()),
    'Заказ закрыт без выдачи. Причина сохранена.',
  )
  if (done !== undefined) reason.value = ''
}
async function pay() {
  if (!order.value) return
  const body =
    order.value.payment_mode === 'sandbox'
      ? ({ mode: 'sandbox' } as const)
      : ({ mode: 'sepolia', hash: hash.value.trim() } as const)
  const done = await run(
    'pay',
    () => officeApi.payOrder(id.value, body),
    'Оплата принята, пишем текст.',
  )
  if (done !== undefined) hash.value = ''
}
async function copyResult() {
  if (!order.value?.result) return
  show(
    (await copyText(order.value.result))
      ? 'Текст скопирован.'
      : 'Не получилось скопировать. Скачайте .txt.',
    'ok',
  )
}
function download() {
  if (!order.value?.result) return
  const blob = new Blob([order.value.result], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `zakaz-${orderNumber(order.value)}.txt`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>
<template>
  <div>
    <NuxtLink class="back" to="/office/orders"
      ><OfficeIcon name="back" size="sm" />Все заказы</NuxtLink
    >
    <OfficeState v-if="!order" :status="status" :pending="pending" @retry="refresh">
      <template #missing>
        <NuxtLink class="btn btn-sm" to="/office/orders">Все заказы</NuxtLink>
      </template>
    </OfficeState>
    <template v-else>
      <div class="page-head">
        <div>
          <h1>Заказ №{{ orderNumber(order) }}</h1>
          <p>
            {{ order.productName || order.product_snapshot.name
            }}<template v-if="price">, {{ price }}</template
            >. {{ order.source === 'public' ? 'С сайта' : 'Из кабинета' }},
            {{ when(order.created_at) }}.
          </p>
        </div>
        <div class="row head-badges">
          <span v-if="isTest" class="badge badge-test">Тестовая оплата</span>
          <OfficeBadge :badge="orderBadge(order.status)" />
        </div>
      </div>

      <section class="card rise progress" aria-label="Ход заказа">
        <div class="card-head">
          <h2>{{ order.progress.title }}</h2>
          <span v-if="order.job" class="badge badge-plain"
            >Попытка {{ order.job.attempts }} из {{ order.job.max_attempts }}</span
          >
        </div>
        <p>{{ order.progress.detail }}</p>
        <p
          v-if="order.status === 'manual_review' && order.review?.reason"
          class="note note-err why"
        >
          {{ order.review.reason }}
        </p>
        <p v-if="order.job?.status === 'queued' && order.job.run_after" class="small muted">
          Повтор не раньше {{ when(order.job.run_after) }}.
        </p>
        <ol class="steps">
          <li
            v-for="(step, i) in order.steps"
            :key="step.label"
            :class="{ 'is-done': step.done, 'is-now': i === currentStep }"
          >
            <strong>{{ step.label }}</strong>
            <span class="when">{{ step.at ? when(step.at) : step.done ? '' : 'ждём' }}</span>
          </li>
        </ol>
        <details v-if="order.progress.errorCode" class="tech">
          <summary>Для техподдержки</summary>
          <code>{{ order.progress.errorCode }}</code>
        </details>
      </section>

      <section
        v-if="order.progress.canResolve"
        class="card card-tint-sun rise"
        aria-labelledby="resolve-title"
      >
        <h2 id="resolve-title">Закрыть без выдачи</h2>
        <p class="small">
          Текст покупателю не уйдёт, выручка не изменится. Исходник и история останутся.
        </p>
        <form class="stack-sm resolve" @submit.prevent="resolve">
          <label class="small strong" for="resolution-reason">Почему закрываете</label>
          <textarea
            id="resolution-reason"
            v-model="reason"
            class="textarea"
            rows="3"
            minlength="10"
            maxlength="1000"
            required
            placeholder="Покупатель прислал не тот текст, договорились заказать заново"
          />
          <div class="row between">
            <span class="xs muted">От 10 символов</span>
            <button class="btn btn-danger" :disabled="!!busy || reason.trim().length < 10">
              {{ busy === 'resolve' ? 'Закрываем' : 'Закрыть без выдачи' }}
            </button>
          </div>
        </form>
      </section>

      <section v-if="order.status === 'closed'" class="card rise">
        <h2>Ваше решение</h2>
        <p class="pre">{{ order.resolution_reason }}</p>
        <p v-if="order.closed_at" class="small muted">
          Закрыт {{ when(order.closed_at) }} без выдачи текста.
        </p>
      </section>

      <section
        v-if="order.status === 'delivered' && order.result"
        class="card rise"
        aria-labelledby="result-title"
      >
        <div class="card-head">
          <h2 id="result-title">Готовый текст</h2>
          <div class="row">
            <button type="button" class="btn btn-sm" @click="copyResult">
              <OfficeIcon name="copy" size="sm" />Скопировать
            </button>
            <button type="button" class="btn btn-sm" @click="download">
              <OfficeIcon name="download" size="sm" />Скачать .txt
            </button>
          </div>
        </div>
        <div class="result-box">{{ order.result }}</div>
        <p v-if="order.review?.reason" class="small muted review-line">
          Проверка: {{ order.review.reason }}
        </p>
      </section>

      <div class="cols">
        <section class="card rise">
          <h2 class="card-title">Что прислал покупатель</h2>
          <p class="pre">{{ order.input }}</p>
          <p v-if="order.agent" class="small muted agent-line">
            Исполнитель:
            <NuxtLink :to="`/office/agents#agent-${order.agent.id}`">{{
              order.agent.name
            }}</NuxtLink>
          </p>
        </section>

        <section class="card rise pay">
          <h2>Оплата</h2>
          <p v-if="order.payment_mode === 'sepolia' && ethAmount" class="eth">
            <span class="num">{{ ethAmount }}</span> тестовых ETH, сеть Sepolia
          </p>
          <template v-if="order.progress.canSubmit">
            <button
              v-if="order.payment_mode === 'sandbox'"
              type="button"
              class="btn btn-primary"
              :disabled="!!busy"
              @click="pay"
            >
              {{
                busy === 'pay'
                  ? 'Оплачиваем'
                  : price
                    ? `Оплатить ${price} (тест)`
                    : 'Оплатить (тест)'
              }}
            </button>
            <form v-else class="stack-sm" @submit.prevent="pay">
              <p class="small">Переведите точную сумму тестовых ETH на адрес:</p>
              <code class="wallet">{{ order.receiver }}</code>
              <p v-if="order.expires_at" class="xs muted">
                Счёт действует до {{ when(order.expires_at) }}. Ждём
                {{ order.required_confirmations }} подтверждения сети.
              </p>
              <label class="small strong" for="txhash">{{
                order.tx_hash ? 'Другой хеш, если указали не тот' : 'Хеш перевода'
              }}</label>
              <input
                id="txhash"
                v-model="hash"
                class="input mono"
                required
                pattern="0x[0-9a-fA-F]{64}"
                placeholder="0x5f2c…"
                autocomplete="off"
              />
              <button class="btn btn-primary" :disabled="!!busy">
                {{
                  busy === 'pay'
                    ? 'Сохраняем'
                    : order.tx_hash
                      ? 'Заменить хеш'
                      : 'Проверить перевод'
                }}
              </button>
            </form>
          </template>
          <p v-else-if="order.paid_at" class="paid">
            <span class="badge badge-ok">Оплачено</span> {{ when(order.paid_at) }}
          </p>
          <p v-else class="muted small">Счёт закрыт.</p>
          <details v-if="order.payment_proof" class="tech">
            <summary>Подтверждение в сети</summary>
            <p class="xs muted">
              Блок {{ order.payment_proof.blockNumber }}, {{ when(order.payment_proof.blockTime) }},
              подтверждений {{ order.payment_proof.confirmations }}
            </p>
            <code class="wallet">{{ order.payment_proof.hash }}</code>
          </details>
        </section>
      </div>

      <section
        v-if="order.paymentAttempts.length"
        class="card rise attempts"
        aria-labelledby="attempts-title"
      >
        <h2 id="attempts-title">История оплаты</h2>
        <ul>
          <li v-for="a in order.paymentAttempts" :key="a.tx_hash">
            <div class="row between">
              <span
                class="badge"
                :class="a.confirmed_at ? 'badge-ok' : a.active ? 'badge-wait' : 'badge-off'"
                >{{ a.confirmed_at ? 'Подтверждён' : a.active ? 'Текущий' : 'Заменён' }}</span
              >
              <span class="xs muted">{{ when(a.submitted_at) }}</span>
            </div>
            <code class="wallet">{{ a.tx_hash }}</code>
            <p class="small">
              {{
                a.errorText ||
                (a.checked_at
                  ? `Подтверждений при последней проверке: ${a.confirmations}`
                  : 'Ещё проверяем')
              }}
            </p>
          </li>
        </ul>
      </section>

      <section
        v-if="order.source === 'public'"
        class="card rise buyer"
        aria-labelledby="buyer-title"
      >
        <h2 id="buyer-title">Как видит покупатель</h2>
        <template v-if="buyerLink">
          <p class="small">
            Новая ссылка заказа. Старая больше не открывается: отправьте эту покупателю.
          </p>
          <code class="wallet">{{ buyerLink }}</code>
          <div class="row buyer-actions">
            <a class="btn btn-primary btn-sm" :href="buyerLink" target="_blank" rel="noopener"
              ><OfficeIcon name="external" size="sm" />Открыть как покупатель</a
            >
            <button type="button" class="btn btn-sm" @click="copyLink">
              <OfficeIcon name="copy" size="sm" />Скопировать
            </button>
          </div>
        </template>
        <template v-else-if="relinkAsk">
          <p class="note note-wait">
            Ссылку покупателя мы храним зашифрованной и показать её не можем. Можно выдать новую, но
            старая сразу перестанет открываться. Покупателю нужно будет отправить новую ссылку.
          </p>
          <div class="row buyer-actions">
            <button type="button" class="btn btn-primary btn-sm" :disabled="!!busy" @click="relink">
              {{ busy === 'relink' ? 'Выдаём' : 'Выдать новую ссылку' }}
            </button>
            <button type="button" class="btn btn-ghost btn-sm" @click="relinkAsk = false">
              Отмена
            </button>
          </div>
        </template>
        <template v-else>
          <p class="small muted">
            Страница заказа открывается по секретной ссылке, которая есть только у покупателя.
          </p>
          <div class="row buyer-actions">
            <button type="button" class="btn btn-sm" @click="relinkAsk = true">
              Открыть как покупатель
            </button>
          </div>
        </template>
      </section>

      <p v-if="['delivered', 'expired', 'closed'].includes(order.status)" class="again">
        <NuxtLink class="btn btn-ghost btn-sm" to="/office/products">Сделать новый заказ</NuxtLink>
      </p>
    </template>
  </div>
</template>
<style scoped>
.back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-bottom: var(--s-4);
  font-weight: 600;
  font-size: var(--text-sm);
}
.head-badges {
  flex-wrap: wrap;
}
.progress,
.card + .card,
.cols {
  margin-top: var(--s-5);
}
.progress {
  margin-top: 0;
}
.why {
  margin-top: var(--s-3);
}
.progress .steps {
  margin-top: var(--s-5);
}
.tech {
  margin-top: var(--s-4);
  font-size: var(--text-sm);
}
.tech summary {
  cursor: pointer;
  color: var(--muted);
}
.resolve {
  margin-top: var(--s-3);
}
.resolve .textarea {
  background: var(--surface);
}
.pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.review-line,
.agent-line {
  margin-top: var(--s-3);
}
.card-title {
  margin-bottom: var(--s-3);
}
.buyer {
  display: grid;
  gap: var(--s-3);
  justify-items: start;
  margin-top: var(--s-5);
}
.buyer .wallet {
  width: 100%;
}
.buyer-actions {
  flex-wrap: wrap;
}
.cols {
  display: grid;
  grid-template-columns: 1.3fr 1fr;
  gap: var(--s-5);
  align-items: start;
}
.cols .card + .card {
  margin-top: 0;
}
.pay h2 {
  margin-bottom: var(--s-3);
}
.eth {
  margin-bottom: var(--s-3);
}
.eth .num {
  font-size: var(--text-xl);
}
.wallet {
  display: block;
  padding: var(--s-2) var(--s-3);
  background: var(--surface-2);
  border-radius: var(--r-sm);
  font: 400 var(--text-xs) / 1.5 var(--font-mono);
  overflow-wrap: anywhere;
}
.attempts ul {
  list-style: none;
  margin: var(--s-3) 0 0;
  padding: 0;
  display: grid;
  gap: var(--s-4);
}
.attempts li {
  display: grid;
  gap: 6px;
}
.again {
  margin-top: var(--s-5);
}
@media (max-width: 1023px) {
  .cols {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 639px) {
  .card-head {
    flex-wrap: wrap;
  }
}
</style>
