<script setup lang="ts">
import type { PublicOrderCreated, PublicServicePage } from '../../../core/contracts/public'
import { formatRub } from '../../../core/storefront'
import { publicErrorCode, rememberOrder } from '~/utils/public-site'

const route = useRoute()
const slug = computed(() => String(route.params.slug))
const { data, error } = await useFetch<PublicServicePage>(
  () => `/api/public/services/${slug.value}`,
)
const service = computed(() => data.value?.service)
// A missing service is a real 404 for browsers and search engines, with the same friendly page.
if (import.meta.server && (error.value || !data.value)) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, error.value?.statusCode === 404 || !error.value ? 404 : 502)
}
useHead({
  title: () => (service.value ? `${service.value.name}. AI Farm` : 'Услуга не найдена. AI Farm'),
})

// A long control example is folded; the buyer opens it with one button.
const sampleOpen = ref(false)
const sampleLong = computed(() => {
  const output = service.value?.sample?.output || ''
  return output.length > 900 || output.split('\n').length > 16
})

const text = ref('')
const rights = ref(false)
const tried = ref(false)
const sending = ref(false)
const serverError = ref('')
let requestKey = ''
// A retried click with the same text reuses the key, so it never creates a second order.
watch(text, () => {
  requestKey = ''
  serverError.value = ''
})

const limit = computed(() => service.value?.inputLimit || 4000)
const count = computed(() => text.value.length.toLocaleString('ru-RU').replace(/ /g, ' '))
const limitText = computed(() => limit.value.toLocaleString('ru-RU').replace(/ /g, ' '))
const languageLine = /^(?:Язык перевода|Целевой язык|Target language):[ \t]*\p{L}/iu
const fieldError = computed(() => {
  const value = text.value.trim()
  if (value.length < 30) return 'Нужно хотя бы 30 символов'
  if (text.value.length > limit.value) return `Не больше ${limitText.value} символов`
  if (slug.value === 'translation' && !languageLine.test(value))
    return 'Для перевода в первой строке напишите язык: «Язык перевода: английский»'
  return ''
})
const rightsError = computed(() =>
  rights.value ? '' : 'Отметьте, что у вас есть права на этот текст',
)

const messages: Record<string, string> = {
  POLICY_CONTENT_BLOCKED: 'Такие темы мы не берём',
  UNTRUSTED_INSTRUCTION_BLOCKED: 'Такие темы мы не берём',
  INPUT_LENGTH: 'Нужно хотя бы 30 символов',
  INPUT_SOCIAL_LENGTH: 'Для постов пришлите текст до 3 000 символов',
  TRANSLATION_LANGUAGE_REQUIRED:
    'Для перевода в первой строке напишите язык: «Язык перевода: английский»',
  SOURCE_POST_INPUT_INVALID: 'Пришлите связный текст, из которого получатся посты',
  NEW_ORDERS_PAUSED: 'Сейчас заказы не принимаем. Загляните через час',
  PUBLIC_ORDERS_LIMIT: 'На сегодня заказы закончились. Загляните завтра',
  PUBLIC_OPEN_ORDERS_LIMIT:
    'У вас уже есть неоплаченные заказы. Оплатите их или подождите час, пока истечёт срок',
  RATE_LIMITED: 'Слишком много попыток подряд. Подождите немного и попробуйте снова',
  SERVICE_NOT_FOUND: 'Эта услуга сейчас недоступна',
  PRODUCT_NOT_FOUND: 'Эта услуга сейчас недоступна',
  PRODUCT_RECIPE_REFRESH_REQUIRED: 'Эта услуга сейчас недоступна',
  BUDGET_BLOCKED: 'Сейчас заказы не принимаем. Загляните через час',
  ORDER_MODEL_BUDGET_TOO_SMALL:
    'Сейчас заказы не принимаем. Исполнитель проверяет настройки сервиса.',
}

async function submit() {
  tried.value = true
  serverError.value = ''
  if (fieldError.value || rightsError.value || !service.value) return
  sending.value = true
  requestKey ||= crypto.randomUUID()
  try {
    const order = await $fetch<PublicOrderCreated>('/api/public/orders', {
      method: 'POST',
      body: { slug: slug.value, input: text.value, requestKey, rightsConfirmed: true },
    })
    rememberOrder({ token: order.token, name: service.value.name, at: new Date().toISOString() })
    await navigateTo(order.url)
  } catch (e) {
    const code = publicErrorCode(e)
    serverError.value =
      (code && messages[code]) ||
      (code?.startsWith('SOURCE_POST')
        ? messages.SOURCE_POST_INPUT_INVALID!
        : 'Не получилось оформить заказ. Попробуйте ещё раз')
  } finally {
    sending.value = false
  }
}
function useExample() {
  if (service.value) text.value = service.value.example
}
</script>

<template>
  <PublicShell :notice="data?.notice" :seller="data?.seller" active="catalog">
    <div class="container">
      <div v-if="error || !service" class="missing">
        <div class="empty">
          <h3>Такой услуги нет</h3>
          <p>Возможно, её сняли с продажи. Посмотрите, что есть сейчас.</p>
          <NuxtLink class="btn btn-primary" to="/storefront">Все услуги</NuxtLink>
        </div>
      </div>
      <template v-else>
        <p class="crumbs"><NuxtLink to="/storefront">Услуги</NuxtLink> / {{ service.category }}</p>
        <div class="service">
          <div class="service-info">
            <h1>{{ service.name }}</h1>
            <p class="lead">
              {{ service.promise }}. Для кого: {{ service.audience.toLowerCase() }}.
            </p>
            <h2 class="gets-title">Что получите</h2>
            <ul class="gets">
              <li v-for="item in service.page.youGet" :key="item">
                <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                <span>{{ item }}</span>
              </li>
            </ul>
            <ul v-if="service.page.limits?.length" class="limits muted small">
              <li v-for="item in service.page.limits" :key="item">{{ item }}</li>
            </ul>
          </div>

          <section class="example">
            <template v-if="service.sample">
              <h2>Пример: вы прислали и мы сделали</h2>
              <p class="muted">Контрольный пример, на котором мы проверили услугу.</p>
              <div class="example-grid">
                <div>
                  <p class="eyebrow">Вы прислали</p>
                  <div class="result-box muted small">{{ service.sample.input }}</div>
                </div>
                <div>
                  <p class="eyebrow">Мы сделали</p>
                  <div
                    id="sample-output"
                    class="result-box small sample-output"
                    :class="{ 'is-folded': sampleLong && !sampleOpen }"
                    v-text="service.sample.output"
                  />
                  <button
                    v-if="sampleLong"
                    type="button"
                    class="link-btn sample-toggle"
                    aria-controls="sample-output"
                    :aria-expanded="sampleOpen"
                    @click="sampleOpen = !sampleOpen"
                  >
                    {{ sampleOpen ? 'Свернуть' : 'Показать полностью' }}
                  </button>
                </div>
              </div>
            </template>
            <template v-else>
              <h2>Что прислать</h2>
              <p class="muted">Пример исходных фактов. Чем их больше, тем точнее текст.</p>
              <div class="result-box muted small">{{ service.example }}</div>
            </template>
          </section>

          <aside class="card card-raised card-pad-lg order-card">
            <div class="row between">
              <span class="price">{{ formatRub(service.priceKopecks) }}</span>
              <span class="badge badge-ok">Готово за 2-5 минут</span>
            </div>
            <form class="order-form" novalidate @submit.prevent="submit">
              <div class="field" :class="{ 'is-error': tried && fieldError }">
                <label for="order-text">{{ service.inputLabel }}</label>
                <textarea
                  id="order-text"
                  v-model="text"
                  class="textarea"
                  rows="7"
                  :maxlength="limit"
                  :placeholder="service.placeholder"
                  :aria-invalid="tried && !!fieldError"
                  aria-describedby="order-text-hint"
                />
                <div id="order-text-hint" class="row between hint-row">
                  <span class="hint">{{
                    tried && fieldError ? fieldError : `${count} / ${limitText}`
                  }}</span>
                  <button type="button" class="link-btn" @click="useExample">
                    Подставить пример
                  </button>
                </div>
              </div>
              <label class="check">
                <input v-model="rights" type="checkbox" />
                <span>У меня есть права на этот текст, в нём нет чужих личных данных.</span>
              </label>
              <p v-if="tried && rightsError" class="form-error">{{ rightsError }}</p>
              <p v-if="data && !data.acceptingOrders" class="note note-wait" role="status">
                Сейчас заказы не принимаем. Загляните через час.
              </p>
              <p v-if="serverError" class="note note-err" role="alert">{{ serverError }}</p>
              <button
                class="btn btn-primary btn-lg btn-block"
                type="submit"
                :disabled="sending || !data?.acceptingOrders"
              >
                {{
                  sending ? 'Оформляем…' : `Перейти к оплате, ${formatRub(service.priceKopecks)}`
                }}
              </button>
            </form>
          </aside>
        </div>
      </template>
    </div>
  </PublicShell>
</template>

<style scoped>
.missing {
  padding: var(--s-16) 0;
}
.crumbs {
  font-size: var(--text-sm);
  color: var(--muted);
  padding: var(--s-5) 0 var(--s-2);
}
.crumbs a {
  color: var(--muted);
}
.service {
  display: grid;
  grid-template-columns: 1fr 420px;
  grid-template-areas: 'info form' 'example form';
  grid-template-rows: auto 1fr;
  column-gap: var(--s-10);
  align-items: start;
  padding-bottom: var(--s-16);
}
.service-info {
  grid-area: info;
}
.example {
  grid-area: example;
}
.order-card {
  grid-area: form;
}
.service-info h1 {
  font-size: var(--text-3xl);
  margin-top: var(--s-2);
  max-width: 18ch;
}
.service-info .lead {
  margin-top: var(--s-4);
  max-width: 52ch;
}
.gets-title {
  margin-top: var(--s-8);
  font-size: var(--text-lg);
}
.gets {
  list-style: none;
  padding: 0;
  margin: var(--s-3) 0 0;
  display: grid;
  gap: 10px;
}
.gets li {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.gets .icon {
  color: var(--brand);
  margin-top: 3px;
}
.limits {
  margin-top: var(--s-4);
}
.example {
  margin-top: var(--s-10);
}
.example > .muted {
  margin: 4px 0 var(--s-4);
}
.example .eyebrow {
  margin-bottom: 8px;
}
.example-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--s-4);
}
.sample-output {
  max-height: none;
  overflow: visible;
}
.sample-output.is-folded {
  max-height: 320px;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(to bottom, #000 70%, transparent);
  mask-image: linear-gradient(to bottom, #000 70%, transparent);
}
.sample-toggle {
  margin-top: 8px;
}
.order-card {
  position: sticky;
  top: 84px;
}
.price {
  font: 800 var(--num-lg) / 1 var(--font-display);
  letter-spacing: -0.03em;
}
.order-form {
  display: grid;
  gap: var(--s-4);
  margin-top: var(--s-5);
}
.hint-row {
  gap: var(--s-2);
  align-items: flex-start;
}
.link-btn {
  border: 0;
  background: none;
  padding: 0;
  color: var(--brand);
  font-size: var(--text-sm);
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.link-btn:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.form-error {
  color: var(--st-err-ink);
  font-size: var(--text-sm);
  margin-top: calc(-1 * var(--s-2));
}
@media (max-width: 1023px) {
  .service {
    grid-template-columns: 1fr;
    grid-template-areas: 'info' 'form' 'example';
    grid-template-rows: auto;
    gap: var(--s-6);
  }
  .example {
    margin-top: 0;
  }
  .order-card {
    position: static;
  }
  .example-grid {
    grid-template-columns: 1fr;
  }
}
</style>
