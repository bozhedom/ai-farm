<script setup lang="ts">
const { state: d, failure, refresh } = useFarm()
const { services, service, serviceLabel } = useServiceCatalog()
const route = useRoute()
const selected = ref(''),
  input = ref(''),
  busy = ref(false),
  error = ref('')
const query = ref(''),
  template = ref('')
const selectedProduct = computed(() => d.value?.products.find((p: any) => p.id === selected.value))
const products = computed(() =>
  (d.value?.products || []).filter(
    (p: any) =>
      (!template.value || p.template === template.value) &&
      `${p.spec.name} ${serviceLabel(p.template)} ${p.spec.audience} ${p.delivery}`
        .toLocaleLowerCase('ru')
        .includes(query.value.trim().toLocaleLowerCase('ru')),
  ),
)
const availableDirections = computed(() =>
  services.value.filter((item) => d.value?.products.some((p: any) => p.template === item.id)),
)
function resetFilters() {
  query.value = ''
  template.value = ''
}
const canOrder = computed(
  () =>
    selectedProduct.value?.status === 'sandbox' &&
    !selectedProduct.value.needsRefresh &&
    d.value?.state.mode === 'running' &&
    !failure.value,
)
let requestKey = ''
let linkedProduct = ''
function renewRequest() {
  requestKey = crypto.randomUUID()
}
function fillSample() {
  input.value = service(selectedProduct.value.template)?.example || ''
  renewRequest()
}
async function choose(p: any, focus = true) {
  if (selected.value !== p.id) {
    selected.value = p.id
    input.value = ''
    error.value = ''
    renewRequest()
  }
  if (focus) {
    await nextTick()
    document.getElementById('material')?.focus()
  }
}
watch(
  () => [route.query.product, d.value?.products],
  () => {
    if (typeof route.query.product !== 'string' || linkedProduct === route.query.product) return
    const product = d.value?.products.find((p: any) => p.id === route.query.product)
    if (product) {
      linkedProduct = product.id
      void choose(product, false)
    }
  },
  { immediate: true },
)
async function resume() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await $fetch('/api/control', { method: 'POST', body: { action: 'running' } })
    await refresh()
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
async function order() {
  if (busy.value || !canOrder.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await $fetch<{ id: string }>('/api/orders', {
      method: 'POST',
      body: { productId: selected.value, input: input.value, requestKey },
    })
    await navigateTo('/orders/' + result.id)
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <FarmShell>
    <div class="page-heading">
      <div>
        <h1>Готовые услуги</h1>
        <p>Выберите задачу и проверьте результат на своём материале.</p>
      </div>
      <span class="status-pill warn">Только тестовые заказы</span>
    </div>
    <p class="catalog-note">
      {{
        d?.config?.paymentMode === 'sepolia'
          ? 'Тестовые переводы в Sepolia. Используйте только тестовый ETH.'
          : 'Оплата заказа подтверждается кнопкой, денежного перевода нет.'
      }}
      Материалы и результаты доступны только владельцу.
    </p>
    <div v-if="!d" class="panel empty large" role="status">
      <template v-if="failure"
        >Не удалось загрузить услуги.
        <button class="quiet" @click="refresh">Повторить загрузку</button></template
      ><template v-else>Загружаем услуги…</template>
    </div>
    <template v-else>
      <div v-if="d.state.mode !== 'running'" class="notice">
        <strong>{{
          d.state.mode === 'emergency_stop'
            ? 'Работа остановлена.'
            : 'Приём новых заказов на паузе.'
        }}</strong>
        Продолжите работу, чтобы попробовать услугу.
        <button class="button secondary small" :disabled="busy || !!failure" @click="resume">
          Продолжить работу
        </button>
      </div>
      <div v-if="!d.autonomy.workerAlive" class="notice">
        Обработчик не на связи. Созданный заказ сохранится, а после оплаты будет ждать запуска
        обработчика. <NuxtLink to="/?view=settings">Проверить состояние</NuxtLink>
      </div>
      <p v-if="error" class="notice error" role="alert">{{ error }}</p>
      <div v-if="!d.products.length" class="panel empty large">
        Услуги появятся после успешной проверки идеи.<br /><NuxtLink to="/?view=directions"
          >Выбрать и исследовать направления →</NuxtLink
        >
      </div>
      <template v-else>
        <div class="catalog-filters">
          <div>
            <label for="service-search">Найти услугу</label
            ><input
              id="service-search"
              v-model="query"
              type="search"
              placeholder="Название, задача или аудитория"
            />
          </div>
          <div>
            <label for="service-type">Направление</label
            ><select id="service-type" v-model="template">
              <option value="">Все направления</option>
              <option v-for="item in availableDirections" :key="item.id" :value="item.id">
                {{ item.label }}
              </option>
            </select>
          </div>
          <span class="muted small-text" role="status"
            >Услуг: {{ products.length }} из {{ d.products.length }}</span
          >
        </div>
        <form v-if="selectedProduct" class="panel order-form" @submit.prevent="order">
          <div class="section-heading">
            <div>
              <span class="eyebrow">НОВЫЙ ТЕСТОВЫЙ ЗАКАЗ</span>
              <h2>{{ selectedProduct.spec.name }}</h2>
            </div>
            <button type="button" class="quiet" @click="selected = ''">Закрыть ×</button>
          </div>
          <p class="muted small-text">{{ selectedProduct.delivery }}</p>
          <label for="material">{{
            selectedProduct.spec.inputLabel || service(selectedProduct.template)?.inputLabel
          }}</label>
          <textarea
            id="material"
            v-model="input"
            required
            minlength="30"
            :maxlength="selectedProduct.inputLimit || 4000"
            rows="7"
            placeholder="Только сведения, которые можно использовать. Без персональных данных и секретов."
            aria-describedby="material-help"
            @input="renewRequest"
          />
          <div class="form-helper">
            <button
              v-if="service(selectedProduct.template)?.example"
              type="button"
              class="quiet"
              @click="fillSample"
            >
              Подставить пример</button
            ><span>{{ input.length }} / {{ selectedProduct.inputLimit || 4000 }}</span>
          </div>
          <p id="material-help" class="muted small-text">
            От 30 символов. Нажимая кнопку, вы подтверждаете право использовать исходный материал.
            Результат предназначен для тестирования.
          </p>
          <p v-if="!canOrder" class="muted small-text">
            {{
              selectedProduct.needsRefresh
                ? 'Сначала обновите услугу новым исследованием.'
                : d.state.mode !== 'running'
                  ? 'Продолжите работу с помощью кнопки выше.'
                  : 'Эта услуга пока не принимает заказы.'
            }}
          </p>
          <button class="button primary" :disabled="busy || !canOrder">
            {{ busy ? 'Создаём…' : 'Создать тестовый заказ' }}
          </button>
        </form>
        <div v-if="!products.length" class="panel empty">
          Услуги не найдены.
          <button class="quiet" @click="resetFilters">Сбросить фильтры</button>
        </div>
        <div class="product-grid">
          <article
            v-for="(p, i) in products"
            :key="p.id"
            class="product-card"
            :class="{ 'product-selected': selected === p.id }"
          >
            <div class="product-art" :class="'art-' + (Number(i) % 3)">
              <span aria-hidden="true">{{ serviceLabel(p.template).slice(0, 1) }}</span
              ><small>{{ serviceLabel(p.template) }}</small>
            </div>
            <div class="product-body">
              <div class="eyebrow">
                {{ p.is_demo ? 'ДЕМО' : 'ПРОВЕРЕН ПРИМЕР' }} · V{{ p.version }}
              </div>
              <h2>{{ p.spec.name }}</h2>
              <p>{{ p.delivery }}</p>
              <span class="product-audience">{{ p.spec.audience }}</span>
              <details v-if="p.checks?.sample" class="product-preview">
                <summary>Пример результата</summary>
                <p>
                  Проверка качества: {{ labels[p.checks.normal] }} ·
                  {{ dateTime(p.checks.checkedAt) }}
                </p>
                <p v-if="p.checks.input">Исходный материал: {{ p.checks.input }}</p>
                <pre>{{ p.checks.sample }}</pre>
                <p v-if="p.checks.reason">{{ p.checks.reason }}</p>
                <NuxtLink to="/?view=hypotheses">Исследования и источники</NuxtLink>
              </details>
              <ProductHistory :key="p.id + ':' + p.version" :product-id="p.id" />
              <p v-if="p.needsRefresh" class="small-text">
                Для локальной модели нужна новая версия услуги.
                <NuxtLink to="/?view=directions">Запустите исследование</NuxtLink>.
              </p>
              <div class="product-bottom">
                <div>
                  <strong>{{
                    d.config.paymentMode === 'sandbox' ? 'Без списания денег' : '≈ 0,0001 TEST ETH'
                  }}</strong
                  ><span>Тестовый заказ</span>
                </div>
                <button
                  class="button secondary small"
                  :disabled="p.status !== 'sandbox' || p.needsRefresh || !!failure || busy"
                  @click="choose(p)"
                >
                  {{
                    p.needsRefresh
                      ? 'Нужно обновить'
                      : p.status === 'archived'
                        ? 'В архиве'
                        : selected === p.id
                          ? 'К форме заказа ↑'
                          : 'Попробовать'
                  }}
                </button>
              </div>
            </div>
          </article>
        </div>
      </template>
    </template>
  </FarmShell>
</template>
