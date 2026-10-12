<script setup lang="ts">
import type { TradingOverview } from '../../../core/contracts/trading'
import { exchanges, type TradingExchange } from '../../../core/trading/types'
import { exchangeCatalog } from '../../../core/trading/catalog'
import { officeFetch } from '~/composables/office/resource'
import { tradingReason } from '~/utils/trading'

const props = defineProps<{ overview: TradingOverview; disabled: boolean }>()
const emit = defineEmits<{ busy: [value: boolean]; saved: []; error: [message: string] }>()
const amounts = ref<Record<TradingExchange, number>>({ okx: 0, bybit: 0, binance: 0, bitget: 0 })
const dirty = ref(false)
const saving = ref(false)
watch(
  () => props.overview,
  (value) => {
    if (!dirty.value)
      for (const c of value.connections) amounts.value[c.exchange] = Number(c.liveAllocation)
  },
  { immediate: true },
)
const total = computed(() => exchanges.reduce((sum, e) => sum + Number(amounts.value[e]), 0))
const valid = computed(
  () =>
    exchanges.every(
      (e) =>
        Number.isInteger(amounts.value[e]) &&
        (amounts.value[e] === 0 || amounts.value[e] >= props.overview.minimumAllocation),
    ) && total.value <= props.overview.capitalLimit,
)
async function save() {
  if (props.disabled || saving.value || !valid.value) return
  saving.value = true
  emit('busy', true)
  emit('error', '')
  try {
    await officeFetch('/api/trading/allocation', {
      method: 'POST',
      body: { amounts: amounts.value },
    })
    dirty.value = false
    emit('saved')
  } catch (e) {
    emit(
      'error',
      tradingReason(
        (e as { data?: { statusMessage?: string } }).data?.statusMessage ||
          'TRADING_NETWORK_UNAVAILABLE',
      ),
    )
  } finally {
    saving.value = false
    emit('busy', false)
  }
}
</script>
<template>
  <details class="t-details funding">
    <summary>
      Бюджет на биржи <span>{{ overview.allocated }} из {{ overview.capitalLimit }} USDT</span>
    </summary>
    <form class="t-details-body t-stack" @submit.prevent="save">
      <p>
        Выделите от {{ overview.minimumAllocation }} USDT каждой нужной бирже. Оставьте 0, если пока
        не будете на ней торговать.
      </p>
      <div class="funding-fields">
        <label v-for="c in overview.connections" :key="c.exchange"
          >{{ exchangeCatalog[c.exchange].name
          }}<span
            ><input
              v-model.number="amounts[c.exchange]"
              type="number"
              min="0"
              :max="overview.capitalLimit"
              step="1"
              required
              :disabled="!c.allocationEditable || disabled"
              @input="dirty = true"
            />
            USDT</span
          ><small v-if="!c.allocationEditable">Зафиксирован после запуска</small></label
        >
      </div>
      <p v-if="!valid" class="t-negative" role="alert">
        Укажите 0 или целую сумму от {{ overview.minimumAllocation }} USDT. Общий бюджет не больше
        {{ overview.capitalLimit }} USDT.
      </p>
      <div class="t-actions">
        <button class="t-button t-primary" :disabled="!dirty || !valid || disabled">
          {{ saving ? 'Сохраняем…' : 'Сохранить бюджет' }}</button
        ><span class="t-muted">Итого {{ total }} / {{ overview.capitalLimit }} USDT</span>
      </div>
      <p class="t-muted">
        Это план распределения. Деньги вы вносите на биржи сами; сохранение не запускает торговлю.
        После первого реального запуска бюджет биржи изменить нельзя.
      </p>
    </form>
  </details>
</template>
