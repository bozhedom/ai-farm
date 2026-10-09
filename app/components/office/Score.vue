<script setup lang="ts">
import { scoreTone } from '~/composables/office/labels'
const props = defineProps<{
  value: number | null
  muted?: boolean
  tone?: string
  /** Too few ideas for a fair score: show «мало данных» and a grey bar. */
  lowData?: boolean
}>()
const width = computed(() =>
  props.lowData ? '0%' : `${Math.max(0, Math.min(100, props.value ?? 0))}%`,
)
const barTone = computed(() =>
  props.muted || props.lowData
    ? 'is-off'
    : (props.tone ?? (props.value === null ? '' : scoreTone(props.value))),
)
</script>
<template>
  <div class="score">
    <span v-if="lowData" class="fresh" title="Мало идей для честного балла">мало данных</span>
    <span v-else-if="value === null" class="fresh">новый</span>
    <span v-else class="num" :class="{ muted }">{{ value }}</span>
    <div class="bar" :class="barTone"><i :style="{ width }" /></div>
  </div>
</template>
<style scoped>
.fresh {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--muted);
  white-space: nowrap;
}
</style>
