<script setup lang="ts">
import type { PublicCatalog } from '../../core/contracts/public'
import { formatRub } from '../../core/storefront'

// Temporary storefront: a read-only list until the buyer path replaces this page.
useHead({ htmlAttrs: { class: 'ds' }, title: 'AI Farm: тексты для вашего дела' })
const { data, error, refresh, pending } = await useFetch<PublicCatalog>('/api/public/catalog')
const services = computed(() => data.value?.services || [])
</script>
<template>
  <div class="public-page">
    <header class="site-head">
      <div class="container">
        <NuxtLink class="brand" to="/"
          ><span class="brand-mark" aria-hidden="true"
            ><svg viewBox="0 0 24 24" class="icon" style="stroke: #fff">
              <path
                d="M12 21v-8M12 13c-4.5 0-7-3-7-8 4.5 0 7 3 7 8zM12 13c4.5 0 7-3 7-8-4.5 0-7 3-7 8z"
              /></svg></span
          ><span>AI Farm</span></NuxtLink
        >
      </div>
    </header>
    <main class="section">
      <div class="container stack-lg">
        <div class="stack-sm">
          <h1>Тексты для вашего дела</h1>
          <p class="lead">
            Описания товаров, ответы клиентам, посты и переводы. Цена известна заранее.
          </p>
        </div>
        <p v-if="data?.notice" class="note" role="note">{{ data.notice }}</p>
        <div v-if="error" class="note note-err" role="alert">
          Каталог не загрузился.
          <button class="btn btn-sm" :disabled="pending" @click="() => refresh()">Повторить</button>
        </div>
        <div v-else-if="!services.length" class="empty">
          <h3>Скоро здесь появятся услуги</h3>
          <p>Мы проверяем их на примерах и выставим, когда всё будет готово.</p>
        </div>
        <div v-else class="public-catalog">
          <article v-for="service in services" :key="service.slug" class="card stack-sm">
            <span class="badge badge-plain badge-sun">{{ service.category }}</span>
            <h2>{{ service.name }}</h2>
            <p class="muted">{{ service.page.headline || service.promise }}</p>
            <p class="num">{{ formatRub(service.priceKopecks) }}</p>
          </article>
        </div>
        <p v-if="data && !data.acceptingOrders && services.length" class="muted later">
          Заказы откроются чуть позже.
        </p>
      </div>
    </main>
    <footer class="site-foot">
      <div class="container">
        <span class="strong">AI Farm</span>
        <span v-if="data?.seller">{{ data.seller.name }}, {{ data.seller.contact }}</span>
        <NuxtLink to="/office/login" style="margin-left: auto">Кабинет владельца</NuxtLink>
      </div>
    </footer>
  </div>
</template>
<style scoped>
.public-page {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}
.public-page > main {
  flex: 1 0 auto;
}
.later {
  font-size: var(--text-sm);
}
.public-catalog {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--s-4);
}
.public-catalog .num {
  font-size: var(--text-xl);
}
</style>
