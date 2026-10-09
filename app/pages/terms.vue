<script setup lang="ts">
import type { PublicCatalog } from '../../core/contracts/public'

useHead({ title: 'Условия. AI Farm' })
const { data } = await useFetch<Pick<PublicCatalog, 'notice' | 'seller' | 'payment'>>(
  '/api/public/catalog',
  { key: 'shop-terms', pick: ['notice', 'seller', 'payment'] },
)
</script>

<template>
  <PublicShell :notice="data?.notice" :seller="data?.seller">
    <div class="container">
      <article class="terms">
        <h1>Условия</h1>
        <p v-if="data?.seller?.termsUrl" class="lead">
          Условия продажи и обработки данных:
          <a :href="data.seller.termsUrl" rel="noopener noreferrer" target="_blank"
            >открыть документ продавца</a
          >.
        </p>
        <p v-else class="lead">
          Продавец и контакты появятся здесь после подключения настоящей оплаты.
        </p>

        <h2>Что сейчас работает</h2>
        <ul>
          <li>Это тестовый магазин. Оплата тестовая, настоящие деньги не списываются.</li>
          <li v-if="data?.payment.mode === 'sepolia'">
            Оплата идёт тестовым ETH в сети Sepolia. Он не имеет цены и не считается выручкой.
          </li>
          <li>
            Текст пишет ИИ по фактам из вашего заказа, затем отдельная проверка сверяет его с ними.
          </li>
          <li>
            Результат появляется на странице заказа. Писем мы не отправляем, ссылку храните у себя.
          </li>
        </ul>

        <h2>Ваши данные</h2>
        <ul>
          <li>Мы храним текст заказа, чтобы выполнить его и показать результат по ссылке.</li>
          <li>Не присылайте чужие личные данные, пароли и то, на что у вас нет прав.</li>
          <li>Адрес устройства не храним, только его обезличенный отпечаток от перегрузки.</li>
        </ul>

        <p v-if="data?.seller" class="muted">
          Продавец: {{ data.seller.name }}, {{ data.seller.contact }}
        </p>
        <NuxtLink class="btn btn-primary" to="/">К услугам</NuxtLink>
      </article>
    </div>
  </PublicShell>
</template>

<style scoped>
.terms {
  max-width: 720px;
  padding: var(--s-10) 0 var(--s-16);
  display: grid;
  gap: var(--s-4);
  justify-items: start;
}
.terms h2 {
  margin-top: var(--s-4);
}
.terms ul {
  display: grid;
  gap: 6px;
}
</style>
