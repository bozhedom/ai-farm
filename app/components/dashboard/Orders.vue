<script setup lang="ts">
const { state: d } = useFarm()
const filter = ref('')
const filtered = computed(() =>
  d.value.orders.filter((o: any) => !filter.value || o.status === filter.value),
)
</script>

<template>
  <section class="panel">
    <div class="section-heading">
      <h2>Тестовые заказы</h2>
      <NuxtLink to="/catalog">Создать заказ ↗</NuxtLink>
    </div>
    <p class="muted">
      {{
        d.config.paymentMode === 'sandbox'
          ? 'Sandbox: оплата имитируется, деньги не переводятся.'
          : 'Sepolia: используются только тестовые ETH.'
      }}
      Реальная выручка не меняется. Показаны до 30 заказов: сначала требующие проверки, затем
      ожидающие исполнения и оплаты.
    </p>
    <div class="order-filter">
      <label for="order-status">Статус заказа</label
      ><select id="order-status" v-model="filter">
        <option value="">Все статусы</option>
        <option
          v-for="status in [
            'manual_review',
            'awaiting_payment',
            'paid',
            'delivered',
            'expired',
            'closed',
          ]"
          :key="status"
          :value="status"
        >
          {{ labels[status] }}
        </option>
      </select>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Заказ</th>
            <th>Сервис</th>
            <th>Стратегия</th>
            <th>Статус</th>
            <th>Создан</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="o in filtered" :key="o.id">
            <td>
              <NuxtLink :to="'/orders/' + o.id">{{ o.id.slice(0, 8) }} ↗</NuxtLink>
            </td>
            <td>{{ o.product_snapshot.name }}</td>
            <td>{{ o.strategy_snapshot.name }}</td>
            <td>
              <span class="tag">{{ labels[o.status] }}</span>
            </td>
            <td>{{ dateTime(o.created_at) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="!d.orders.length" class="empty large">
      Заказов ещё нет.
      <NuxtLink to="/catalog">Выберите услугу и создайте первый тестовый заказ</NuxtLink>.
    </div>
    <div v-else-if="!filtered.length" class="empty">
      Заказов с таким статусом нет. <button class="quiet" @click="filter = ''">Показать все</button>
    </div>
  </section>
</template>
