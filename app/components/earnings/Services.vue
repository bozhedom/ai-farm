<script setup lang="ts">
import type {
  ServiceCatalogView,
  ServiceJobView,
  ServiceQuoteView,
} from '../../../core/services/types'
import { officeFetch, useOfficeResource } from '~/composables/office/resource'
import { shortTime } from '~/utils/trading'

const { data, pending, refresh } = useOfficeResource<ServiceCatalogView>(
  () => 'earnings-services',
  () => officeFetch('/api/services'),
  { interval: 15_000 },
)
const selected = ref('')
const input = ref('')
const rights = ref(false)
const busy = ref(false)
const error = ref('')
const quote = ref<ServiceQuoteView | null>(null)
const job = ref<ServiceJobView | null>(null)
const requestKey = ref('')
const offer = computed(() => data.value?.services.find((s) => s.template === selected.value))
const price = (n: number) =>
  (n / 100).toLocaleString('ru-RU', { style: 'currency', currency: 'RUB' })
watch([selected, input, rights], () => {
  quote.value = null
  job.value = null
  requestKey.value = ''
  error.value = ''
})
function sample() {
  input.value = offer.value?.example || ''
}
async function act(create: boolean) {
  if (busy.value || !offer.value?.productId) return
  busy.value = true
  error.value = ''
  try {
    if (!create) {
      quote.value = await officeFetch<ServiceQuoteView>('/api/services/quote', {
        method: 'POST',
        body: {
          productId: offer.value.productId,
          input: input.value,
          rightsConfirmed: rights.value,
        },
      })
      requestKey.value = crypto.randomUUID()
    } else if (quote.value) {
      job.value = await officeFetch<ServiceJobView>('/api/services/jobs', {
        method: 'POST',
        body: {
          quote: quote.value.quote,
          input: input.value,
          rightsConfirmed: rights.value,
          requestKey: requestKey.value,
        },
      })
    }
  } catch (e) {
    const code = (e as { data?: { statusMessage?: string } }).data?.statusMessage || ''
    error.value = /EXPIRED/.test(code)
      ? 'Срок оценки закончился. Запросите цену ещё раз.'
      : 'Сейчас заказ создать не удалось. Обновите состояние и проверьте доступность услуги.'
    await refresh()
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <section class="e-service-test">
    <h3>Проверить заказ через API</h3>
    <p class="t-muted">
      Выберите существующую услугу. После создания перейдите к заказу, чтобы отдельно подтвердить
      тестовую оплату.
    </p>
    <p v-if="pending" role="status">Загружаем услуги…</p>
    <p v-else-if="!data" class="t-notice t-warning">
      Каталог недоступен. <button class="t-link" @click="refresh">Повторить</button>
    </p>
    <template v-else>
      <p class="e-caption">
        {{
          data.modelMode === 'demo'
            ? 'Модель работает на готовых примерах.'
            : 'Настроена внешняя или локальная модель. Выполнение заказа может расходовать её бюджет.'
        }}
        Оплата:
        {{ data.paymentMode === 'sandbox' ? 'симуляция без перевода' : 'тестовый ETH Sepolia' }}.
      </p>
      <ul v-if="data.blockers.length" class="e-blockers">
        <li v-for="reason in data.blockers" :key="reason">{{ reason }}</li>
      </ul>
      <label class="e-field"
        >Услуга
        <select v-model="selected" :disabled="busy" aria-label="Услуга">
          <option value="">Выберите услугу</option>
          <option v-for="s in data.services" :key="s.template" :value="s.template">
            {{ s.name }}{{ !s.productId ? ' · ещё не создана' : '' }}
          </option>
        </select>
      </label>
      <template v-if="offer">
        <p>{{ offer.description }}</p>
        <p v-for="reason in offer.blockers" :key="reason" class="t-muted">{{ reason }}</p>
        <template v-if="offer.productId">
          <label class="e-field"
            >{{ offer.inputLabel
            }}<textarea v-model="input" rows="5" maxlength="4000" :disabled="busy" />
          </label>
          <button class="t-link" :disabled="busy" @click="sample">Подставить пример</button>
          <label class="e-rights"
            ><input v-model="rights" type="checkbox" :disabled="busy" />У меня есть права на эти
            материалы</label
          >
          <button
            class="t-button"
            :disabled="busy || !offer.ready || !input.trim() || !rights"
            @click="act(false)"
          >
            {{ busy && !quote ? 'Проверяем…' : 'Узнать цену' }}
          </button>
          <div v-if="quote && !job" class="t-notice e-quote">
            <p>
              <strong>{{ price(quote.priceKopecks) }}</strong> · тестовая цена. Действует до
              {{ shortTime(quote.expiresAt) }}.
            </p>
            <button class="t-button t-primary" :disabled="busy" @click="act(true)">
              {{ busy ? 'Создаём…' : 'Создать тестовый заказ' }}
            </button>
          </div>
          <p v-if="job" class="t-notice" role="status">
            Заказ №{{ job.number }} создан. <NuxtLink :to="job.orderUrl">Открыть заказ</NuxtLink>.
            Исполнение начнётся после отдельного подтверждения тестовой оплаты.
          </p>
        </template>
      </template>
      <p v-if="error" class="t-notice t-warning" role="alert">{{ error }}</p>
      <details class="t-details">
        <summary>Подключение своей программы</summary>
        <div class="t-details-body">
          <p>
            Закрытый API: <code>GET /api/services</code>, <code>POST /api/services/quote</code>,
            <code>POST /api/services/jobs</code>, <code>GET /api/services/jobs/:id</code>.
          </p>
          <p>
            Нужны сессия владельца и разрешённый Origin. Ключ повторного запроса сохраняйте до
            ответа. Доступ для посторонних клиентов и x402 ещё не включены.
          </p>
        </div>
      </details>
    </template>
  </section>
</template>
