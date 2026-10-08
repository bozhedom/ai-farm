<script setup lang="ts">
import type { ResourceStatus } from '~/composables/office/resource'

/** First load of a section: skeleton while waiting, a clear problem with a retry if it fails. */
defineProps<{ status: ResourceStatus; pending: boolean; rows?: number }>()
const emit = defineEmits<{ retry: [] }>()
</script>
<template>
  <div v-if="pending || status.loading" class="skeleton" role="status" aria-label="Загружаем">
    <div v-for="i in rows || 3" :key="i" class="sk" />
  </div>
  <OfficeEmpty
    v-else-if="status.missing"
    icon="search"
    title="Здесь ничего нет"
    text="Возможно, ссылка устарела."
  >
    <slot name="missing" />
  </OfficeEmpty>
  <OfficeEmpty
    v-else
    icon="wifi"
    title="Нет связи"
    :text="status.error || 'Не удалось загрузить данные.'"
  >
    <button type="button" class="btn btn-sm" @click="emit('retry')">Повторить</button>
  </OfficeEmpty>
</template>
<style scoped>
.skeleton {
  display: grid;
  gap: var(--s-4);
}
.sk {
  height: 96px;
  border-radius: var(--r-lg);
  background: linear-gradient(90deg, var(--canvas-deep), var(--surface-2), var(--canvas-deep));
  background-size: 200% 100%;
}
.sk:first-child {
  height: 180px;
}
@media (prefers-reduced-motion: no-preference) {
  .sk {
    animation: sk 1.4s linear infinite;
  }
}
@keyframes sk {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}
</style>
