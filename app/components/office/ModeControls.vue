<script setup lang="ts">
import type { OfficeMode } from '../../../core/contracts/office'
import { officeApi, useOfficeAction } from '~/composables/office/actions'

const props = defineProps<{
  mode: OfficeMode | undefined
  disabled?: boolean
  stopLabel?: string
}>()
const { busy, run } = useOfficeAction()
const confirmStop = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

const texts: Record<OfficeMode, string> = {
  running: 'Ферма снова работает.',
  paused: 'Пауза. Начатые заказы доделываем.',
  emergency_stop: 'Всё остановлено. Новые задачи не берём.',
}
function set(mode: OfficeMode) {
  confirmStop.value = false
  void run(mode, () => officeApi.setMode(mode), texts[mode])
}
function stop() {
  if (!confirmStop.value) {
    confirmStop.value = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => (confirmStop.value = false), 4000)
    return
  }
  set('emergency_stop')
}
onBeforeUnmount(() => timer && clearTimeout(timer))
const off = computed(() => props.disabled || !props.mode || !!busy.value)
</script>
<template>
  <div class="row mode-controls">
    <button
      v-if="mode === 'running'"
      type="button"
      class="btn"
      :disabled="off"
      @click="set('paused')"
    >
      <OfficeIcon name="pause" />{{ busy === 'paused' ? 'Ставим паузу' : 'Пауза' }}
    </button>
    <button v-else type="button" class="btn btn-primary" :disabled="off" @click="set('running')">
      <OfficeIcon name="play" />{{ busy === 'running' ? 'Запускаем' : 'Продолжить' }}
    </button>
    <button
      v-if="mode !== 'emergency_stop'"
      type="button"
      class="btn btn-danger"
      :class="{ 'is-confirm': confirmStop }"
      :disabled="off"
      @click="stop"
    >
      <OfficeIcon name="stop" />{{ confirmStop ? 'Точно остановить?' : stopLabel || 'Стоп' }}
    </button>
  </div>
</template>
<style scoped>
.mode-controls {
  flex-wrap: wrap;
}
.is-confirm {
  background: var(--st-err);
  color: #fff;
  border-color: var(--st-err);
}
</style>
