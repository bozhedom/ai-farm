<script setup lang="ts">
import { copyToClipboard } from '~/utils/public-site'

const props = defineProps<{ text: string; label?: string; small?: boolean; primary?: boolean }>()
const state = ref<'idle' | 'done' | 'failed'>('idle')
let timer: ReturnType<typeof setTimeout> | undefined

async function copy() {
  state.value = (await copyToClipboard(props.text)) ? 'done' : 'failed'
  clearTimeout(timer)
  timer = setTimeout(() => (state.value = 'idle'), 2000)
}
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <button
    type="button"
    class="btn"
    :class="{ 'btn-sm': props.small, 'btn-primary': props.primary }"
    @click="copy"
  >
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path v-if="state === 'done'" d="M20 6 9 17l-5-5" />
      <path v-else d="M8 8h12v12H8zM16 8V4H4v12h4" />
    </svg>
    <span aria-live="polite">{{
      state === 'done'
        ? 'Скопировано'
        : state === 'failed'
          ? 'Не вышло, выделите вручную'
          : props.label || 'Скопировать'
    }}</span>
  </button>
</template>
