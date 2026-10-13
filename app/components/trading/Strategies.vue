<script setup lang="ts">
import type { TradingView } from '../../../core/contracts/trading'
import { officeFetch } from '~/composables/office/resource'
import {
  pct,
  shortTime,
  strategyDescription,
  strategyName,
  tradingReason,
  usdt,
} from '~/utils/trading'

const props = defineProps<{ view: TradingView }>()
const emit = defineEmits<{ overview: []; updated: [] }>()
const preset = ref(props.view.strategyPreset.selected)
const saving = ref(false)
const error = ref('')
const notice = ref('')
watch([() => props.view.exchange, () => props.view.strategyPreset.selected], () => {
  preset.value = props.view.strategyPreset.selected
})
async function savePreset() {
  if (saving.value) return
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await officeFetch('/api/trading/strategies', {
          method: 'POST',
          body: { exchange: props.view.exchange, preset: preset.value },
        })
        break
      } catch (e) {
        // A busy lock rejected the command before any change. Network/unknown outcomes are not retried.
        if (
          attempt >= 4 ||
          (e as { data?: { statusMessage?: string } }).data?.statusMessage !== 'TRADING_BUSY'
        )
          throw e
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
    }
    notice.value =
      'Набор сохранён. Открытые позиции продолжат контролироваться. Запуск и лимиты портфеля не изменены.'
    emit('updated')
  } catch (e) {
    error.value = tradingReason(
      (e as { data?: { statusMessage?: string } }).data?.statusMessage ||
        'TRADING_NETWORK_UNAVAILABLE',
    )
  } finally {
    saving.value = false
  }
}
const showArchived = ref(false)
const agents = computed(() =>
  props.view.agents.filter((a) => showArchived.value || a.status === 'active'),
)
</script>
<template>
  <section class="t-stack">
    <section v-if="view.mode === 'paper'" class="strategy-preset">
      <h2>Набор для тренировки</h2>
      <div class="preset-controls">
        <label
          >Стратегии<select v-model="preset" :disabled="saving" aria-label="Набор стратегий">
            <option value="adaptive">По движению цены</option>
            <option value="classic">Сетка и DCA</option>
          </select></label
        >
        <button
          class="t-button"
          :disabled="saving || preset === view.strategyPreset.selected"
          @click="savePreset"
        >
          {{ saving ? 'Сохраняем…' : 'Применить набор' }}
        </button>
      </div>
      <p class="t-muted">
        Второй набор проверяет сетку и покупку частями рядом с двумя контрольными стратегиями.
        Деньги виртуальные. Открытые позиции не прерываются.
      </p>
      <p v-if="view.strategyPreset.pending" class="t-notice">
        Замена части агентов отложена до закрытия позиций или появления подходящих монет.
      </p>
      <p v-if="notice" class="t-notice" role="status">{{ notice }}</p>
      <p v-if="error" class="t-notice t-warning" role="alert">{{ error }}</p>
    </section>
    <div class="section-heading">
      <div>
        <h2>Кто торгует на этой бирже</h2>
        <p class="t-muted">
          Разведчик подбирает монеты, каждый агент ждёт сигнал своей стратегии. Результат включает
          все монеты, которыми агент торговал, и комиссии.
        </p>
      </div>
      <label class="archive-switch"><input v-model="showArchived" type="checkbox" />Архив</label>
    </div>
    <div v-if="!agents.length" class="t-empty">
      <h3>Стратегии появятся после запуска</h3>
      <p>
        Разведчик сначала подберёт монеты. В тренировке работают до четырёх агентов, на биржевом
        счёте один.
      </p>
      <button class="t-button" @click="$emit('overview')">К запуску</button>
    </div>
    <div v-else class="strategy-list">
      <article
        v-for="a in agents"
        :key="a.id"
        class="strategy-row"
        :class="{ 'is-archived': a.status === 'archived' }"
      >
        <div class="strategy-heading">
          <div>
            <h3>
              {{ a.name }} <span>{{ a.symbol.split('-')[0] }}</span>
            </h3>
            <p>{{ strategyName[a.kind] }}</p>
          </div>
          <div class="strategy-profit" :class="Number(a.pnl) < 0 ? 't-negative' : 't-positive'">
            {{ Number(a.pnl) > 0 ? '+' : '' }}{{ usdt(a.pnl) }} <small>USDT</small
            ><span>после комиссий</span>
          </div>
        </div>
        <p class="t-muted">{{ strategyDescription[a.kind] }}</p>
        <p class="strategy-activity">
          {{ a.status === 'archived' ? 'В архиве, больше не торгует' : tradingReason(a.signal) }}
        </p>
        <details class="strategy-details">
          <summary>Результаты и параметры</summary>
          <dl class="t-facts">
            <div>
              <dt>Завершённых покупок с продажей</dt>
              <dd>{{ a.roundTrips }}</dd>
            </div>
            <div>
              <dt>Максимальное снижение баланса</dt>
              <dd>{{ pct(a.drawdownBps) }}</dd>
            </div>
            <div>
              <dt>Монет сейчас</dt>
              <dd>{{ a.base }} {{ a.symbol.split('-')[0] }}</dd>
            </div>
            <div>
              <dt>Поколение</dt>
              <dd>{{ a.generation }}</dd>
            </div>
            <div>
              <dt>Начал работу</dt>
              <dd>{{ shortTime(a.createdAt) }}</dd>
            </div>
            <div>
              <dt>Окно наблюдения</dt>
              <dd>{{ a.params.lookback }} мин.</dd>
            </div>
            <div>
              <dt>Изменение цены для покупки</dt>
              <dd>{{ pct(a.params.entryBps) }}</dd>
            </div>
            <div>
              <dt>Цель после комиссии</dt>
              <dd>{{ pct(a.params.takeProfitBps) }}</dd>
            </div>
          </dl>
          <p class="t-muted">
            {{
              a.eligible
                ? 'Минимальные условия отбора выполнены.'
                : 'Для отбора пока недостаточно результатов.'
            }}
          </p>
          <p v-if="a.parentId" class="record-id">ID исходного агента: {{ a.parentId }}</p>
        </details>
      </article>
    </div>
    <details class="t-details">
      <summary>Когда меняются стратегии</summary>
      <div class="t-details-body">
        <p>{{ tradingReason(view.evolutionReason) }}</p>
        <p class="t-muted">
          {{
            view.mode === 'paper'
              ? `Сравнение начинается после ${view.limits.evaluationDays} дней и ${view.limits.evaluationTrips} завершённых покупок с продажей у каждого агента. Если лидеры показали достаточное преимущество, на их основе создаются новые варианты. История прежних остаётся в архиве.`
              : 'Агент может уступить место более сильной стратегии из тренировки этой же биржи. Смена происходит только после продажи всех купленных монет.'
          }}
        </p>
      </div>
    </details>
  </section>
</template>
<style scoped>
.strategy-preset {
  border-bottom: 1px solid var(--t-line);
  padding-bottom: 24px;
}
.preset-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: end;
  margin: 14px 0;
}
.preset-controls label {
  display: grid;
  gap: 6px;
  font-size: 13px;
}
</style>
