<script setup lang="ts">
// Public buyer site frame: one test-mode line, own header and footer, nothing from the office.
import { savedOrders } from '~/utils/public-site'

const props = defineProps<{
  notice?: string | null
  seller?: { name: string; contact: string; termsUrl: string | null } | null
  active?: 'catalog' | 'order'
}>()
useHead({ htmlAttrs: { class: 'ds' } })
// With exactly one order saved on this device, «Мой заказ» opens it; otherwise the list.
const myOrder = ref('/storefront#orders')
onMounted(() => {
  const saved = savedOrders()
  if (saved.length === 1) myOrder.value = `/order/${saved[0]!.token}`
})
</script>

<template>
  <div class="public">
    <p v-if="props.notice" class="test-strip" role="note">{{ props.notice }}</p>
    <header class="site-head">
      <div class="container">
        <NuxtLink class="brand" to="/storefront">
          <span class="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" class="icon" style="stroke: #fff">
              <path
                d="M12 21v-8M12 13c-4.5 0-7-3-7-8 4.5 0 7 3 7 8zM12 13c4.5 0 7-3 7-8-4.5 0-7 3-7 8z"
              />
            </svg>
          </span>
          <span>AI Farm</span>
        </NuxtLink>
        <nav class="site-nav" aria-label="Разделы">
          <NuxtLink to="/storefront#catalog" :class="{ strong: props.active === 'catalog' }"
            >Услуги</NuxtLink
          >
          <NuxtLink to="/storefront#how" class="hide-sm">Как это работает</NuxtLink>
          <NuxtLink :to="myOrder" :class="{ strong: props.active === 'order' }">Мой заказ</NuxtLink>
        </nav>
      </div>
    </header>
    <main class="public-main">
      <slot />
    </main>
    <footer class="site-foot">
      <div class="container">
        <span class="strong foot-brand">AI Farm</span>
        <span v-if="props.seller">{{ props.seller.name }}, {{ props.seller.contact }}</span>
        <NuxtLink to="/terms">Условия</NuxtLink>
        <NuxtLink to="/office/login" class="foot-office">Кабинет владельца</NuxtLink>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.public {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}
.public-main {
  flex: 1 0 auto;
}
.test-strip {
  margin: 0;
  padding: 7px var(--gutter);
  background: var(--st-test-soft);
  color: var(--st-test-ink);
  font-size: var(--text-sm);
  text-align: center;
}
.site-nav .strong {
  color: var(--ink);
}
.foot-brand {
  color: var(--ink);
}
.foot-office {
  margin-left: auto;
}
</style>
