<script setup lang="ts">
import type { DirectionReadiness } from '../../../core/earnings/readiness'
import { officeFetch, useOfficeResource } from '~/composables/office/resource'
const { data, pending, status, refresh } = useOfficeResource<DirectionReadiness[]>(
  () => 'direction-readiness',
  () => officeFetch('/api/office/directions'),
  { interval: 15000 },
)
const groups = computed(() =>
  [
    {
      id: 'real',
      title: 'Реальные подключения',
      hint: 'Торговые счета и публичные рыночные данные.',
    },
    {
      id: 'test',
      title: 'Тестовые режимы',
      hint: 'Виртуальные средства и тестовые заказы. Это не реальная торговля и не доход.',
    },
    {
      id: 'other',
      title: 'Другие направления и подключения',
      hint: 'Статус запуска и причина ожидания — в каждой карточке.',
    },
  ].map((group) => ({
    ...group,
    items: (data.value || []).filter(
      (item) =>
        (item.group ||
          (item.status === 'тестовый режим'
            ? 'test'
            : item.status === 'работает'
              ? 'real'
              : 'other')) === group.id,
    ),
  })),
)
</script>
<template>
  <section class="card readiness" aria-labelledby="direction-state">
    <h2 id="direction-state">Что работает сейчас</h2>
    <p class="small muted">
      Состояние подключений и процессов обновляется каждые 15 секунд. Включённый переключатель не
      означает, что направление выполняет сделки.
    </p>
    <OfficeState v-if="!data" :status="status" :pending="pending" @retry="refresh" />
    <template v-else>
      <div
        v-for="group in groups.filter((g) => g.items.length)"
        :key="group.id"
        class="direction-group"
        :data-group="group.id"
      >
        <details :open="group.id === 'real'">
          <summary>
            <span>{{ group.title }}</span
            ><span class="direction-count">{{ group.items.length }}</span>
          </summary>
          <p class="small muted group-hint">{{ group.hint }}</p>
          <div class="direction-grid">
            <article
              v-for="item in group.items"
              :key="item.id"
              class="direction-item"
              :data-direction="item.id"
            >
              <div class="direction-title">
                <NuxtLink :to="item.link"
                  ><strong>{{ item.title }}</strong></NuxtLink
                >
                <span
                  class="badge"
                  :class="
                    item.active && group.id === 'real'
                      ? 'badge-ok'
                      : group.id === 'test'
                        ? 'badge-wait'
                        : 'badge-off'
                  "
                  >{{ item.status }}</span
                >
              </div>
              <p class="direction-activity">
                {{ item.activity || (item.active ? 'Процесс включён' : 'Не запущено') }}
              </p>
              <p class="small muted">{{ item.detail }}</p>
            </article>
          </div>
        </details>
      </div>
    </template>
  </section>
  <OfficeWorkFocus />
</template>
<style scoped>
.readiness {
  margin-bottom: 24px;
}
.readiness > p {
  margin: 8px 0 24px;
  max-width: 760px;
}
.direction-group + .direction-group {
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid var(--line);
}
summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 16px;
  padding: 6px 0;
}
.direction-count {
  margin-left: 10px;
  color: var(--muted);
  font-weight: 400;
}
.group-hint {
  margin: 8px 0 16px;
}
.direction-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.direction-item {
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 18px;
  min-width: 0;
}
.direction-title {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}
.direction-activity {
  font-size: 14px;
  font-weight: 600;
  margin: 14px 0 8px;
}
.direction-item p {
  overflow-wrap: anywhere;
}
@media (max-width: 700px) {
  .direction-grid {
    grid-template-columns: 1fr;
  }
}
</style>
