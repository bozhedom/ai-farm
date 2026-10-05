<script setup lang="ts">
const { state: d, failure } = useFarm()
const selected = ref(''),
  input = ref(''),
  busy = ref(false),
  error = ref('')
const selectedProduct = computed(() => d.value?.products.find((p: any) => p.id === selected.value))
let requestKey = ''
function renewRequest() {
  requestKey = crypto.randomUUID()
}
function fillSample() {
  input.value = samples[d.value.products.find((p: any) => p.id === selected.value).template] || ''
  renewRequest()
}
const samples: Record<string, string> = {
  description:
    'Керамическая кружка «Утро». Объём 350 мл, матовая белая глазурь. Ручная работа. Подходит для горячих напитков. Мыть вручную.',
  faq: 'Студия ремонтирует велосипеды. Диагностика занимает один рабочий день. Стоимость ремонта согласуется после диагностики. Доставка не предоставляется.',
  social:
    'Наша мастерская выпустила новую серию керамических кружек. Каждая кружка сделана вручную. Коллекция доступна в белом и синем цветах. Объём 350 мл.',
}
async function choose(p: any) {
  selected.value = p.id
  input.value = ''
  error.value = ''
  requestKey = crypto.randomUUID()
  await nextTick()
  document.getElementById('material')?.focus()
}
async function order() {
  if (busy.value) return
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
  <FarmShell
    ><div class="page-heading">
      <div>
        <h1>Готовые услуги</h1>
        <p>Выберите задачу и проверьте результат на своём примере.</p>
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
    <div v-if="!d?.products?.length" class="panel empty large">
      Услуги появятся после успешной проверки идеи.<br /><NuxtLink to="/">Проверить идею</NuxtLink>
    </div>
    <div class="product-grid">
      <article v-for="(p, i) in d?.products || []" :key="p.id" class="product-card">
        <div class="product-art" :class="'art-' + i">
          <span>{{ p.template === 'description' ? 'Aa' : p.template === 'faq' ? '?' : '≋' }}</span
          ><small>{{ labels[p.template] }}</small
          ><i /><i />
        </div>
        <div class="product-body">
          <div class="eyebrow">{{ p.is_demo ? 'ДЕМО' : 'ПРОВЕРЕН ПРИМЕР' }} · V{{ p.version }}</div>
          <h2>{{ p.spec.name }}</h2>
          <p>
            {{ p.delivery }}
          </p>
          <span class="product-audience">{{ p.spec.audience }}</span>
          <details v-if="p.checks?.sample" class="product-preview">
            <summary>Пример результата</summary>
            <p>
              Проверка качества: {{ labels[p.checks.normal] }} · {{ dateTime(p.checks.checkedAt) }}
            </p>
            <p v-if="p.checks.input">Исходный материал: {{ p.checks.input }}</p>
            <pre>{{ p.checks.sample }}</pre>
            <p v-if="p.checks.reason">{{ p.checks.reason }}</p>
            <NuxtLink to="/?view=hypotheses">Исследования и источники</NuxtLink>
          </details>
          <ProductHistory :key="p.id + ':' + p.version" :product-id="p.id" />
          <p v-if="p.needsRefresh" class="small-text">
            Для локальной модели нужна новая версия публикаций.
            <NuxtLink to="/?view=hypotheses">Запустите исследование</NuxtLink>.
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
              :disabled="
                p.status !== 'sandbox' ||
                p.needsRefresh ||
                d.state.mode !== 'running' ||
                !!failure ||
                busy
              "
              @click="choose(p)"
            >
              {{
                p.needsRefresh
                  ? 'Нужно обновить услугу'
                  : p.status === 'archived'
                    ? 'В архиве'
                    : d.state.mode !== 'running'
                      ? 'Приём заказов на паузе'
                      : 'Попробовать'
              }}
            </button>
          </div>
        </div>
      </article>
    </div>
    <form v-if="selected" class="panel order-form" @submit.prevent="order">
      <div class="section-heading">
        <h2>{{ d.products.find((p: any) => p.id === selected)?.spec.name }}</h2>
        <button type="button" class="quiet" @click="selected = ''">Закрыть ×</button>
      </div>
      <label for="material">{{
        d.products.find((p: any) => p.id === selected)?.spec.inputLabel
      }}</label
      ><textarea
        id="material"
        v-model="input"
        required
        minlength="30"
        :maxlength="selectedProduct?.inputLimit || 4000"
        rows="7"
        placeholder="Только сведения, которые можно использовать. Без персональных данных и секретов."
        @input="renewRequest"
      />
      <div class="form-helper">
        <button type="button" class="quiet" @click="fillSample">Подставить пример</button
        ><span>{{ input.length }} / {{ selectedProduct?.inputLimit || 4000 }}</span>
      </div>
      <p class="muted small-text">
        Нажимая кнопку, вы подтверждаете право использовать исходный материал. Результат этого
        стенда предназначен для тестирования.
      </p>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <button class="button primary" :disabled="busy || !!failure">
        {{ busy ? 'Создаём…' : 'Создать тестовый заказ' }}
      </button>
    </form>
  </FarmShell>
</template>
