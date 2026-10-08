<script setup lang="ts">
import type { PublicService } from '../../../core/contracts/public'
import { formatRub } from '../../../core/storefront'

const props = defineProps<{ service: PublicService; shelfColor: string }>()
</script>

<template>
  <NuxtLink class="card card-link product" :to="`/services/${props.service.slug}`">
    <span class="kind"
      ><i :style="{ background: props.shelfColor }" />{{ props.service.category }}</span
    >
    <h3>{{ props.service.name }}</h3>
    <p class="for">{{ props.service.promise }}</p>
    <div class="price-row">
      <span class="price">{{ formatRub(props.service.priceKopecks) }}</span>
      <span class="time">Готово за 2-5 минут</span>
    </div>
    <span class="btn btn-primary btn-block order-btn">Заказать</span>
  </NuxtLink>
</template>

<style scoped>
.product {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  min-height: 250px;
  color: inherit;
}
.product:hover {
  text-decoration: none;
}
.kind {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font: 600 var(--text-xs) / 1 var(--font-body);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-2);
}
.kind i {
  width: 10px;
  height: 10px;
  border-radius: 3px;
}
h3 {
  font-size: var(--text-xl);
}
.for {
  color: var(--ink-2);
}
.price-row {
  margin-top: auto;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--s-3);
  padding-top: var(--s-4);
  border-top: 1px solid var(--line);
}
.price {
  font: 800 var(--text-2xl) / 1 var(--font-display);
  letter-spacing: -0.02em;
}
.time {
  color: var(--muted);
  font-size: var(--text-sm);
}
.order-btn {
  pointer-events: none;
}
</style>
