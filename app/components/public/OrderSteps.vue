<script setup lang="ts">
import type { OrderStep } from '../../../core/contracts/common'
import { publicWhen } from '~/utils/public-site'

const props = defineProps<{ steps: OrderStep[]; active: boolean }>()
// Times use the buyer's clock zone, so they appear after hydration only.
const mounted = ref(false)
onMounted(() => (mounted.value = true))
const now = computed(() => props.steps.findIndex((s) => !s.done))
</script>

<template>
  <ol class="steps">
    <li
      v-for="(step, i) in props.steps"
      :key="step.label"
      :class="{ 'is-done': step.done, 'is-now': props.active && i === now }"
    >
      <strong>{{ step.label }}</strong>
      <span class="when"
        >{{ mounted && step.done && step.at ? publicWhen(step.at) : '' }}&nbsp;</span
      >
    </li>
  </ol>
</template>
