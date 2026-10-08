<script setup lang="ts">
import type { OfficeMode } from '../../../core/contracts/office'
import { officeApi, useOfficeAction } from '~/composables/office/actions'

const props = defineProps<{ mode: OfficeMode | undefined; ghost?: boolean }>()
const { busy, run } = useOfficeAction()
const blocked = computed(() =>
  props.mode === 'paused'
    ? 'Сначала нажмите «Продолжить»'
    : props.mode === 'emergency_stop'
      ? 'Ферма остановлена'
      : '',
)
function find() {
  void run('scout', () => officeApi.findIdeas(), 'Разведчики вышли на поиск. Идеи появятся здесь.')
}
</script>
<template>
  <button
    type="button"
    class="btn"
    :class="ghost ? '' : 'btn-primary'"
    :disabled="!mode || !!blocked || !!busy"
    :title="blocked || undefined"
    @click="find"
  >
    <OfficeIcon name="search" />{{ busy ? 'Отправляем' : 'Найти идеи сейчас' }}
  </button>
</template>
