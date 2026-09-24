<script setup lang="ts">
const { state: d } = useFarm()
const selected = ref(''),
  input = ref(''),
  busy = ref(false),
  error = ref('')
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
  faq: 'Студия ремонтирует велосипеды. Диагностика — один рабочий день. Стоимость ремонта согласуется после диагностики. Доставка не предоставляется.',
  social:
    'Наша мастерская выпустила новую серию керамических кружек. Каждая кружка сделана вручную. Коллекция доступна в белом и синем цветах. Объём — 350 мл.',
}
function choose(p: any) {
  selected.value = p.id
  input.value = ''
  error.value = ''
  requestKey = crypto.randomUUID()
}
async function order() {
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
        <div class="eyebrow">ВИТРИНА ЭКСПЕРИМЕНТА</div>
        <h1>Маленькие сервисы.<br />Конкретная польза.</h1>
        <p>Продукты, собранные лабораторией из разрешённых шаблонов.</p>
      </div>
      <span class="status-pill warn">Только тестовые заказы</span>
    </div>
    <div class="test-banner">
      <span class="banner-symbol">◎</span>
      <div>
        <strong>Пройдите путь покупателя</strong
        ><span
          >Используйте обезличенные примеры.
          {{
            d?.config?.paymentMode === 'sepolia'
              ? 'Переводы идут в Sepolia. Используйте только тестовый ETH.'
              : 'Sandbox имитирует оплату без перевода денег.'
          }}
          Качество демотекстов не отражает качество подключённой модели.</span
        >
      </div>
    </div>
    <div v-if="!d?.products?.length" class="panel empty large">
      Сервисы появятся после первого исследования.<br /><NuxtLink to="/"
        >Вернуться в лабораторию →</NuxtLink
      >
    </div>
    <div class="product-grid">
      <article v-for="(p, i) in d?.products || []" :key="p.id" class="product-card">
        <div class="product-art" :class="'art-' + i">
          <span>{{ p.template === 'description' ? 'Aa' : p.template === 'faq' ? '?' : '≋' }}</span
          ><small>{{ labels[p.template] }}</small
          ><i /><i />
        </div>
        <div class="product-body">
          <div class="eyebrow">
            {{ p.is_demo ? 'ДЕМО-КОНФИГУРАЦИЯ' : 'СОБРАНО ИЗ ГИПОТЕЗЫ' }} · V{{ p.version }}
          </div>
          <h2>{{ p.spec.name }}</h2>
          <p>{{ p.spec.promise }}</p>
          <span class="product-audience">{{ p.spec.audience }}</span>
          <details v-if="p.checks?.sample" class="product-preview">
            <summary>Посмотреть контрольный результат</summary>
            <p>
              Проверка качества: {{ labels[p.checks.normal] }} · {{ dateTime(p.checks.checkedAt) }}
            </p>
            <pre>{{ p.checks.sample }}</pre>
            <NuxtLink to="/?view=hypotheses">Гипотезы и источники ↗</NuxtLink>
          </details>
          <div class="product-bottom">
            <div>
              <strong>≈ 0,0001 <small>TEST ETH</small></strong
              ><span>Учебная сумма · не деньги</span>
            </div>
            <button class="button secondary small" @click="choose(p)">Попробовать →</button>
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
        maxlength="4000"
        rows="7"
        placeholder="Только сведения, которые можно использовать. Без персональных данных и секретов."
        @input="renewRequest"
      />
      <div class="form-helper">
        <button type="button" class="quiet" @click="fillSample">Подставить пример</button
        ><span>{{ input.length }} / 4 000</span>
      </div>
      <p class="muted small-text">
        Нажимая кнопку, вы подтверждаете право использовать исходный материал. Результат этого
        стенда предназначен для тестирования.
      </p>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <button class="button primary" :disabled="busy">
        {{ busy ? 'Создаём…' : 'Создать тестовый заказ →' }}
      </button>
    </form>
  </FarmShell>
</template>
