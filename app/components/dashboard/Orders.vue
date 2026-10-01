<script setup lang="ts">
const { state: d } = useFarm()
</script>

<template>
  <section class="panel">
    <div class="section-heading">
      <h2>Тестовые заказы</h2>
      <NuxtLink to="/catalog">Создать заказ ↗</NuxtLink>
    </div>
    <p class="muted">
      Все суммы в тестовом ETH; реальная выручка не меняется. Показаны до 30 заказов: сначала
      требующие проверки, затем ожидающие исполнения и оплаты.
    </p>
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
          <tr v-for="o in d.orders" :key="o.id">
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
      Заказов ещё нет. Пройдите тестовый путь покупателя в витрине.
    </div>
  </section>
</template>
