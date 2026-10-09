<script setup lang="ts">
import type { OfficeProduct } from '../../../core/contracts/office'
import { officeApi, useOfficeAction } from '~/composables/office/actions'
import { useOfficeOverview, useOfficeProducts } from '~/composables/office/data'
import { day, rub, withCount } from '~/composables/office/format'

useHead({ title: 'Продукты' })
const { data, status, pending, refresh } = useOfficeProducts()
const { data: overview } = useOfficeOverview()
const { busy, run } = useOfficeAction()
const filter = ref<'all' | 'public' | 'private'>('all')
const products = computed(() =>
  (data.value || []).filter((p) => filter.value === 'all' || p.visibility === filter.value),
)
const hasDemo = computed(() => (data.value || []).some((p) => p.isDemo))
const publicCount = computed(
  () => (data.value || []).filter((p) => p.visibility === 'public').length,
)

function toggleVisibility(product: OfficeProduct) {
  const next = product.visibility === 'public' ? 'private' : 'public'
  void run(
    `vis:${product.id}`,
    () => officeApi.setVisibility(product.id, next),
    next === 'public' ? `«${product.name}» снова на сайте.` : `«${product.name}» скрыт с сайта.`,
  )
}

// Owner test order from the office: same server path as before, sandbox or Sepolia test payment.
const ordering = ref<string | null>(null)
const input = ref('')
let requestKey = ''
function startOrder(product: OfficeProduct) {
  ordering.value = ordering.value === product.id ? null : product.id
  input.value = ''
  requestKey = crypto.randomUUID()
}
async function createOrder(product: OfficeProduct) {
  const result = await run('order', () =>
    officeApi.createOrder(product.id, input.value.trim(), requestKey),
  )
  if (result?.id) await navigateTo(`/office/orders/${result.id}`)
}
const canOrder = computed(() => overview.value?.mode === 'running')
</script>
<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Продукты</h1>
        <p>
          {{
            data
              ? `${withCount(publicCount, ['продукт', 'продукта', 'продуктов'])} на сайте из ${data.length}.`
              : 'Что продаётся на сайте и по какой цене.'
          }}
          <span v-if="hasDemo" class="badge badge-plain demo-note">Данные демо-провайдера</span>
        </p>
      </div>
      <a class="btn" href="/" target="_blank" rel="noopener"
        ><OfficeIcon name="external" />Открыть сайт</a
      >
    </div>

    <div v-if="data?.length" class="chips filter" aria-label="Показать">
      <button
        type="button"
        class="chip"
        :class="{ 'is-active': filter === 'all' }"
        @click="filter = 'all'"
      >
        Все <span class="n">{{ data.length }}</span>
      </button>
      <button
        type="button"
        class="chip"
        :class="{ 'is-active': filter === 'public' }"
        @click="filter = 'public'"
      >
        На сайте <span class="n">{{ publicCount }}</span>
      </button>
      <button
        type="button"
        class="chip"
        :class="{ 'is-active': filter === 'private' }"
        @click="filter = 'private'"
      >
        Скрыты <span class="n">{{ data.length - publicCount }}</span>
      </button>
    </div>

    <OfficeState v-if="!data" :status="status" :pending="pending" @retry="refresh" />
    <OfficeEmpty
      v-else-if="!data.length"
      icon="box"
      title="Продуктов пока нет"
      text="Они появятся, когда критик примет идею, а ферма соберёт и проверит пример."
    >
      <NuxtLink class="btn btn-sm" to="/office/ideas">К идеям</NuxtLink>
    </OfficeEmpty>
    <OfficeEmpty v-else-if="!products.length" icon="box" title="Здесь пусто" />
    <div v-else class="grid">
      <article
        v-for="p in products"
        :id="`product-${p.id}`"
        :key="p.id"
        class="card product rise"
        :class="{ 'is-hidden': p.visibility === 'private' }"
      >
        <div class="p-head">
          <span class="badge" :class="p.visibility === 'public' ? 'badge-ok' : 'badge-off'">{{
            p.visibility === 'public' ? 'На сайте' : 'Скрыт'
          }}</span>
          <span v-if="p.needsRefresh" class="badge badge-wait">Нужно обновить</span>
          <span class="price num">{{ rub(p.priceKopecks) }}</span>
        </div>
        <h2>{{ p.name }}</h2>
        <p class="muted small">
          {{
            p.publishedAt && p.visibility === 'public'
              ? `На сайте с ${day(p.publishedAt)}.`
              : p.publishedAt
                ? `Был на сайте с ${day(p.publishedAt)}.`
                : 'На сайт ещё не выходил.'
          }}
        </p>
        <dl class="p-stats">
          <div>
            <dt>Заказов</dt>
            <dd class="num">{{ p.stats.orders }}</dd>
          </div>
          <div>
            <dt>Готово</dt>
            <dd class="num">{{ p.stats.delivered }}</dd>
          </div>
          <div>
            <dt>Запросов клиентов</dt>
            <dd class="num">
              <NuxtLink v-if="p.stats.leads" :to="`/office/leads?product=${p.id}`">{{
                p.stats.leads
              }}</NuxtLink>
              <template v-else>0</template>
            </dd>
          </div>
        </dl>
        <p v-if="p.ideaId" class="small">
          Из идеи:
          <NuxtLink :to="`/office/ideas/${p.ideaId}`">«{{ p.ideaTitle || 'открыть' }}»</NuxtLink>
        </p>
        <div class="p-actions">
          <a
            v-if="p.visibility === 'public'"
            class="btn btn-sm btn-primary"
            :href="p.publicUrl"
            target="_blank"
            rel="noopener"
            ><OfficeIcon name="external" size="sm" />Открыть на сайте</a
          >
          <button type="button" class="btn btn-sm" :disabled="!!busy" @click="toggleVisibility(p)">
            <OfficeIcon :name="p.visibility === 'public' ? 'eyeOff' : 'eye'" size="sm" />{{
              busy === `vis:${p.id}`
                ? 'Сохраняем'
                : p.visibility === 'public'
                  ? 'Скрыть'
                  : 'Показать'
            }}
          </button>
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            :aria-expanded="ordering === p.id"
            :disabled="p.needsRefresh"
            @click="startOrder(p)"
          >
            Тестовый заказ
          </button>
        </div>
        <form v-if="ordering === p.id" class="order-form stack-sm" @submit.prevent="createOrder(p)">
          <label class="small strong" :for="`order-${p.id}`">Исходный текст для заказа</label>
          <textarea
            :id="`order-${p.id}`"
            v-model="input"
            class="textarea"
            rows="4"
            minlength="30"
            maxlength="4000"
            required
            placeholder="Кружка, керамика, 300 мл, белая, можно в посудомойку"
          />
          <div class="row between">
            <span class="xs muted">{{ input.length }} / 4 000</span>
            <button
              class="btn btn-sm btn-primary"
              :disabled="!!busy || input.trim().length < 30 || !canOrder"
              :title="canOrder ? undefined : 'Сначала нажмите «Продолжить»'"
            >
              {{ busy === 'order' ? 'Создаём' : 'Создать заказ' }}
            </button>
          </div>
        </form>
        <OfficeVersionHistory :key="`${p.id}:${p.version}`" :product-id="p.id" class="p-history" />
      </article>
    </div>
  </div>
</template>
<style scoped>
.filter {
  margin-bottom: var(--s-4);
}
.demo-note {
  margin-left: 6px;
  vertical-align: 1px;
}
.product {
  scroll-margin-top: 80px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--s-4);
  align-items: start;
}
.product {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}
.product.is-hidden {
  background: var(--surface-2);
}
.p-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.price {
  margin-left: auto;
  font-size: var(--text-xl);
}
.product h2 {
  font-size: var(--text-lg);
}
.p-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--s-2);
  margin: 0;
}
.p-stats div {
  background: var(--surface-2);
  border-radius: var(--r-md);
  padding: var(--s-2) var(--s-3);
}
.product.is-hidden .p-stats div {
  background: var(--surface);
}
.p-stats dt {
  font-size: var(--text-xs);
  color: var(--muted);
}
.p-stats dd {
  margin: 0;
  font-size: var(--text-lg);
}
.p-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-2);
}
.order-form {
  padding: var(--s-3);
  border-radius: var(--r-md);
  background: var(--surface-2);
}
.p-history {
  padding-top: var(--s-3);
  border-top: 1px solid var(--line);
}
@media (max-width: 639px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
