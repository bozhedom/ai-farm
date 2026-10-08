<script setup lang="ts">
import { scoreTone } from '~/composables/office/labels'
const props = defineProps<{ value: number | null; muted?: boolean; tone?: string }>()
const width = computed(() => `${Math.max(0, Math.min(100, props.value ?? 0))}%`)
const barTone = computed(() =>
  props.muted ? 'is-off' : (props.tone ?? (props.value === null ? '' : scoreTone(props.value))),
)
</script>
<template>
  <div class="score">
    <span v-if="value === null" class="fresh">новый</span>
    <span v-else class="num" :class="{ muted }">{{ value }}</span>
    <div class="bar" :class="barTone"><i :style="{ width }" /></div>
  </div>
</template>
<style scoped>
.fresh {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--muted);
}
</style>
