<script setup lang="ts">
import type { DirectionReadiness } from '../../../core/earnings/readiness'
import { officeFetch, useOfficeResource } from '~/composables/office/resource'
const { data, pending, status, refresh } = useOfficeResource<DirectionReadiness[]>(
  () => 'direction-readiness',
  () => officeFetch('/api/office/directions'),
  { interval: 15000 },
)
</script>
<template>
  <section class="card readiness" aria-labelledby="direction-state">
    <h2 id="direction-state">Что подключено сейчас</h2>
    <p class="small muted">
      «Работает» описывает подключение или функцию. «Активно» означает включённый процесс; его режим
      указан рядом. Тренировки и найденные возможности не являются доходом.
    </p>
    <OfficeState v-if="!data" :status="status" :pending="pending" @retry="refresh" />
    <div v-else class="direction-grid">
      <article v-for="item in data" :key="item.id" class="direction-item">
        <NuxtLink :to="item.link"
          ><strong>{{ item.title }}</strong></NuxtLink
        >
        <div class="row badges">
          <span class="badge" :class="item.status === 'работает' ? 'badge-ok' : 'badge-wait'">{{
            item.status
          }}</span
          ><span class="badge" :class="item.active ? 'badge-ok' : 'badge-off'">{{
            item.active ? 'Активно' : 'Не активно'
          }}</span>
        </div>
        <p class="small muted">{{ item.detail }}</p>
      </article>
    </div>
  </section>
</template>
<style scoped>
.readiness {
  margin-bottom: 24px;
}
.readiness > p {
  margin: 8px 0 16px;
}
.direction-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
  gap: 16px;
}
.direction-item {
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 14px;
  min-width: 0;
}
.badges {
  flex-wrap: wrap;
  margin: 8px 0;
}
</style>
