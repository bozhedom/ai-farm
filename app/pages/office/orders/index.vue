<script setup lang="ts">
import { useOfficeOrders } from '~/composables/office/data'
import { orderNumber, rub, when, withCount } from '~/composables/office/format'
import { orderBadge } from '~/composables/office/labels'

useHead({ title: 'Заказы' })
const { data, status, pending, refresh, more } = useOfficeOrders()
type Filter = 'attention' | 'all' | 'active' | 'done'
const filter = ref<Filter>('all')
const all = computed(() => data.value?.items || [])
const attention = computed(() =>
  all.value.filter((o) => o.attention || o.status === 'manual_review'),
)
// The first time data arrives, open «Нужна проверка» if something waits for the owner.
let picked = false
watch(
  data,
  (value) => {
    if (picked || !value) return
    picked = true
    if (attention.value.length) filter.value = 'attention'
  },
  { immediate: true },
)
const active = ['awaiting_payment', 'paid', 'running']
const items = computed(() =>
  filter.value === 'attention'
    ? attention.value
    : filter.value === 'active'
      ? all.value.filter((o) => active.includes(o.status))
      : filter.value === 'done'
        ? all.value.filter((o) => o.status === 'delivered')
        : all.value,
)
const emptyText = computed(
  () =>
    ({
      attention: { title: 'Проверять нечего', text: 'Все заказы идут сами.' },
      active: { title: 'В работе ничего нет', text: 'Все заказы выполнены.' },
      done: { title: 'Готовых пока нет', text: 'Готовые заказы появятся здесь.' },
      all: { title: 'Заказов пока нет', text: undefined },
    })[filter.value],
)
const subtitle = computed(() => {
  if (!data.value) return 'Заказы с сайта и тестовые заказы из кабинета.'
  if (!data.value.total) return 'Заказов пока нет.'
  return attention.value.length
    ? `${withCount(attention.value.length, ['заказ ждёт', 'заказа ждут', 'заказов ждут'])} вашей проверки.`
    : 'Всё идёт само, проверка не нужна.'
})
</script>
<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Заказы</h1>
        <p>{{ subtitle }}</p>
      </div>
    </div>

    <div v-if="all.length" class="chips filter" aria-label="Показать">
      <button
        type="button"
        class="chip"
        :class="{ 'is-active': filter === 'attention' }"
        @click="filter = 'attention'"
      >
        Нужна проверка <span class="n">{{ attention.length }}</span>
      </button>
      <button
        type="button"
        class="chip"
        :class="{ 'is-active': filter === 'all' }"
        @click="filter = 'all'"
      >
        Все <span class="n">{{ data?.total }}</span>
      </button>
      <button
        type="button"
        class="chip"
        :class="{ 'is-active': filter === 'active' }"
        @click="filter = 'active'"
      >
        В работе
      </button>
      <button
        type="button"
        class="chip"
        :class="{ 'is-active': filter === 'done' }"
        @click="filter = 'done'"
      >
        Готовые
      </button>
    </div>

    <OfficeState v-if="!data" :status="status" :pending="pending" @retry="refresh" />
    <OfficeEmpty
      v-else-if="!data.total"
      icon="list"
      title="Заказов пока нет"
      text="Первый заказ придёт с сайта. Можно сделать тестовый в разделе «Продукты»."
    >
      <NuxtLink class="btn btn-sm" to="/office/products">К продуктам</NuxtLink>
    </OfficeEmpty>
    <OfficeEmpty
      v-else-if="!items.length"
      icon="check"
      :title="emptyText.title"
      :text="emptyText.text"
    />
    <div v-else class="table-wrap">
      <table class="table table-stack orders">
        <thead>
          <tr>
            <th>Заказ</th>
            <th>Продукт</th>
            <th>Сумма</th>
            <th>Откуда</th>
            <th>Статус</th>
            <th>Когда</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="order in items"
            :key="order.id"
            :class="{ 'is-alert': order.attention }"
            @click="navigateTo(`/office/orders/${order.id}`)"
          >
            <td class="mono">
              <NuxtLink :to="`/office/orders/${order.id}`" @click.stop
                >№{{ orderNumber(order) }}</NuxtLink
              >
            </td>
            <td data-full class="product">{{ order.product.name }}</td>
            <td data-l="Сумма">
              <span class="amount">{{ rub(order.priceKopecks) }}</span>
              <span v-if="order.isTestPayment" class="badge badge-test badge-plain">Тест</span>
            </td>
            <td data-l="Откуда">{{ order.source === 'public' ? 'С сайта' : 'Из кабинета' }}</td>
            <td><OfficeBadge :badge="orderBadge(order.status)" /></td>
            <td data-l="Когда" class="muted">{{ when(order.createdAt) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="data?.hasMore" class="more muted small">
      Загружено {{ data.items.length }} из {{ data.total }}.
      <button v-if="data.hasMore" type="button" class="link-btn" @click="more">Показать ещё</button>
    </p>
  </div>
</template>
<style scoped>
.filter {
  margin-bottom: var(--s-4);
}
.orders tbody tr {
  cursor: pointer;
}
.orders tr.is-alert td:first-child {
  box-shadow: inset 3px 0 0 var(--st-err);
}
.orders td,
.orders th {
  padding-left: var(--s-5);
}
.product {
  font-weight: 600;
}
.amount {
  margin-right: 6px;
  white-space: nowrap;
}
.more {
  margin-top: var(--s-3);
}
.link-btn {
  border: 0;
  background: none;
  padding: 0;
  color: var(--brand);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
@media (max-width: 639px) {
  .table-wrap {
    padding: 0 var(--s-4);
  }
  .orders td,
  .orders th {
    padding-left: 0;
  }
  .orders tr.is-alert td:first-child {
    box-shadow: none;
  }
}
</style>
