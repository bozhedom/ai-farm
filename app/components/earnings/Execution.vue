<script setup lang="ts">
import type { ExecutionView } from '../../../core/contracts/execution'
import type { ExecutionMode, ExecutionTrack } from '../../../core/execution/types'
import { officeFetch, useOfficeResource } from '~/composables/office/resource'
import { shortTime } from '~/utils/trading'
import { executionActions, executionMessage, executionStatuses } from '~/utils/execution'

const props = defineProps<{ track: ExecutionTrack }>()
const mode = ref<ExecutionMode>('paper')
const modes = [
  { id: 'paper', label: 'Тренировка' },
  { id: 'demo', label: 'Тестовый счёт' },
  { id: 'live', label: 'Реальный счёт' },
] as const
const venues = [
  { id: 'okx', name: 'OKX' },
  { id: 'bybit', name: 'Bybit' },
  { id: 'binance', name: 'Binance' },
  { id: 'bitget', name: 'Bitget' },
] as const
const scope = computed(() => `execution:${props.track}:${mode.value}`)
const { data, pending, refresh } = useOfficeResource<ExecutionView>(
  () => scope.value,
  () => officeFetch('/api/execution', { query: { track: props.track, mode: mode.value } }),
  { interval: 5000 },
)
const capital = ref(''),
  buy = ref('okx'),
  sell = ref('bybit'),
  symbols = ref(''),
  edge = ref(20),
  funding = ref(2),
  hold = ref(24),
  ticker = ref(''),
  probability = ref(50),
  outcome = ref<'yes' | 'no'>('yes')
const editing = ref(false),
  busy = ref(false),
  error = ref(''),
  notice = ref('')
function copyForm() {
  if (!data.value) return
  const p = data.value,
    s = p.settings
  capital.value = p.capital === '0' ? '' : p.capital
  buy.value = s.buyExchange
  sell.value = s.sellExchange
  symbols.value = s.symbols.join(', ')
  edge.value = s.minEdgeBps
  funding.value = s.minFundingBps
  hold.value = s.maxHoldHours
  ticker.value = s.predictionTicker
  probability.value = s.probabilityBps / 100
  outcome.value = s.outcome
}
function editSettings() {
  copyForm()
  editing.value = true
}
function cancelSettings() {
  editing.value = false
  copyForm()
}
watch(scope, () => {
  editing.value = false
  error.value = ''
  notice.value = ''
})
watch(data, () => {
  if (!editing.value) copyForm()
})
const needsSettings = computed(
  () => !!data.value && (editing.value || (!data.value.activated && data.value.capital === '0')),
)
const hasPosition = computed(() => data.value?.operations.some((o) => !o.closedAt))
const canEdit = computed(
  () =>
    data.value && (!data.value.activated || (data.value.status === 'paused' && !hasPosition.value)),
)
const canStart = computed(
  () =>
    data.value &&
    !data.value.readiness &&
    !['running', 'stopped', 'attention'].includes(data.value.status) &&
    !needsSettings.value,
)
const money = (value: string) =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 6 }).format(Number(value))
async function act(action: 'save' | 'start' | 'pause' | 'close') {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    if (action === 'save') {
      await officeFetch('/api/execution/configure', {
        method: 'POST',
        body: {
          track: props.track,
          mode: mode.value,
          capital: capital.value.trim().replace(',', '.'),
          settings: {
            buyExchange: buy.value,
            sellExchange: sell.value,
            symbols: symbols.value
              .toUpperCase()
              .split(/[,\s]+/)
              .filter(Boolean)
              .map((s) => (s.endsWith('-USDT') ? s : s + '-USDT')),
            minEdgeBps: edge.value,
            minFundingBps: funding.value,
            maxHoldHours: hold.value,
            predictionTicker: ticker.value.trim().toUpperCase(),
            probabilityBps: Math.round(probability.value * 100),
            outcome: outcome.value,
          },
        },
      })
      editing.value = false
      notice.value = 'Настройки сохранены.'
    } else {
      await officeFetch('/api/execution/control', {
        method: 'POST',
        timeout: 120000,
        body: { track: props.track, mode: mode.value, action },
      })
      notice.value =
        action === 'start'
          ? 'Работа началась.'
          : action === 'pause'
            ? 'Новые сделки приостановлены. Открытый цикл продолжает обрабатываться.'
            : 'Закрытие запрошено. Следите за состоянием позиции.'
    }
    await refresh()
  } catch (e) {
    error.value = executionMessage(
      (e as { data?: { statusMessage?: string } }).data?.statusMessage ||
        'EXECUTION_CONNECTION_FAILED',
    )
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <section class="e-execution" aria-label="Управление операциями">
    <div class="e-mode-tabs" role="group" aria-label="Режим операций">
      <button
        v-for="m in modes"
        :key="m.id"
        :aria-pressed="mode === m.id"
        :disabled="busy"
        @click="mode = m.id"
      >
        {{ m.label }}
      </button>
    </div>
    <p class="t-muted e-caption">
      {{
        mode === 'paper'
          ? 'Виртуальные средства и рыночные данные.'
          : mode === 'demo'
            ? 'Операции на тестовом счёте.'
            : 'Операции со средствами подключённого счёта.'
      }}
    </p>
    <p v-if="pending && !data" role="status">Загружаем счёт…</p>
    <template v-if="data">
      <div class="section-heading">
        <h3>
          {{
            track === 'funding'
              ? 'Фандинг · Bybit'
              : track === 'defi'
                ? 'Вложения · Aave'
                : track === 'prediction'
                  ? 'Контракты · Kalshi'
                  : 'Межбиржевые сделки'
          }}
        </h3>
        <span class="e-stage" role="status">{{ executionStatuses[data.status] }}</span>
      </div>
      <p v-if="data.readiness" class="t-notice">{{ executionMessage(data.readiness) }}</p>
      <div v-if="!needsSettings" class="e-balances">
        <div>
          <span>Выделено</span
          ><strong
            >{{ money(data.capital) }} <small>{{ data.currency }}</small></strong
          >
        </div>
        <div>
          <span>Стоимость счёта</span
          ><strong
            >{{ money(data.equity) }} <small>{{ data.currency }}</small></strong
          >
        </div>
        <div>
          <span>Результат</span
          ><strong
            >{{ money(data.realized) }} <small>{{ data.currency }}</small></strong
          >
        </div>
      </div>
      <form
        v-if="needsSettings"
        class="e-execution-form"
        @focusin="editing = true"
        @submit.prevent="act('save')"
      >
        <label
          >Сумма, {{ data.currency
          }}<input
            v-model="capital"
            :readonly="data.activated"
            inputmode="decimal"
            required
            autocomplete="off"
            placeholder="Сумма"
        /></label>
        <template v-if="track === 'arbitrage'">
          <label
            >Первая биржа<select v-model="buy" :disabled="data.activated">
              <option v-for="v in venues" :key="v.id" :value="v.id">{{ v.name }}</option>
            </select></label
          >
          <label
            >Вторая биржа<select v-model="sell" :disabled="data.activated">
              <option v-for="v in venues" :key="v.id" :value="v.id">{{ v.name }}</option>
            </select></label
          >
        </template>
        <p v-if="data.activated" class="t-muted e-form-note">
          Сумма и подключённые счета закреплены после первого запуска.
        </p>
        <template v-if="track === 'prediction'">
          <label
            >Код рынка Kalshi<input
              v-model="ticker"
              required
              placeholder="Код из карточки события"
              autocomplete="off"
          /></label>
          <label
            >Ваша оценка вероятности «Да», %<input
              v-model.number="probability"
              type="number"
              min="0.01"
              max="99.99"
              step="0.01"
              required
          /></label>
          <label
            >Покупать исход<select v-model="outcome">
              <option value="yes">Да</option>
              <option value="no">Нет</option>
            </select></label
          >
          <p class="t-muted e-form-note">
            Система сравнит вашу оценку с ценой контракта и учтёт комиссии.
          </p>
        </template>
        <details class="e-form-options">
          <summary>Условия работы</summary>
          <div class="e-execution-form">
            <label v-if="track === 'arbitrage' || track === 'funding'"
              >Монеты <span class="t-muted">(необязательно)</span
              ><input v-model="symbols" placeholder="Автоматический отбор" /><small
                >Через запятую. Например, SOL, LINK.</small
              ></label
            >
            <label v-if="track === 'arbitrage' || track === 'prediction'"
              >Минимальная разница, базисных пунктов<input
                v-model.number="edge"
                type="number"
                min="10"
                max="1000"
                required
              /><small>100 пунктов = 1%.</small></label
            >
            <label v-if="track === 'funding'"
              >Минимальный фандинг, базисных пунктов<input
                v-model.number="funding"
                type="number"
                min="1"
                max="100"
                required
            /></label>
            <label v-if="track !== 'arbitrage'"
              >Держать позицию не дольше, часов<input
                v-model.number="hold"
                type="number"
                min="1"
                max="168"
                required
            /></label>
          </div>
        </details>
        <div class="e-actions e-form-note">
          <button class="t-button t-primary" :disabled="busy" type="submit">Сохранить</button
          ><button v-if="editing" class="t-link" type="button" @click="cancelSettings">
            Отмена
          </button>
        </div>
      </form>
      <template v-else>
        <p
          v-if="data.reason"
          :class="[
            't-notice',
            { 't-warning': data.status === 'attention' || data.status === 'stopped' },
          ]"
        >
          {{ executionMessage(data.reason) }}
        </p>
        <p v-if="data.activated && !data.workerAlive" class="t-notice t-warning">
          Обработчик временно недоступен. Новые команды сохраняются в очереди.
        </p>
        <div class="e-actions">
          <button
            v-if="data.status !== 'running'"
            class="t-button t-primary"
            :disabled="busy || !canStart"
            @click="act('start')"
          >
            {{ busy ? 'Проверяем счёт…' : data.activated ? 'Продолжить' : 'Запустить' }}
          </button>
          <button v-else class="t-button" :disabled="busy" @click="act('pause')">Пауза</button>
          <button
            v-if="hasPosition"
            class="t-button"
            :disabled="busy || data.closeRequested"
            @click="act('close')"
          >
            {{ data.closeRequested ? 'Закрытие запрошено' : 'Закрыть позицию' }}
          </button>
          <button v-if="canEdit" class="t-link" :disabled="busy" @click="editSettings">
            Изменить настройки
          </button>
        </div>
        <p v-if="data.heartbeat" class="e-caption t-muted">
          Проверено {{ shortTime(data.heartbeat) }}. Комиссии: {{ money(data.fees) }}
          {{ data.currency
          }}<span v-for="n in data.networkFees" :key="n.asset"
            >. Сеть: {{ money(n.amount) }} {{ n.asset }}</span
          >.
        </p>
        <p v-if="data.networkFees.length" class="e-caption t-muted">
          Расходы сети показаны отдельно в ETH и не вычтены из результата в USDC.
        </p>
      </template>
      <p v-if="notice" class="t-notice" role="status">{{ notice }}</p>
      <p v-if="error" class="t-notice t-warning" role="alert">{{ error }}</p>
      <div v-if="data.operations.length" class="e-table-wrap e-position-list">
        <table class="e-table">
          <caption>
            Позиции и результат
          </caption>
          <thead>
            <tr>
              <th>Актив</th>
              <th>Состояние</th>
              <th>Результат, {{ data.currency }}</th>
              <th>Открытие</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="op in data.operations" :key="op.id">
              <th>{{ op.symbol }}</th>
              <td>{{ executionStatuses[op.status] }}</td>
              <td>{{ money(op.pnl) }}</td>
              <td>{{ shortTime(op.createdAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <details v-if="data.legs.length || data.events.length" class="t-details">
        <summary>Журнал операций</summary>
        <div class="t-details-body">
          <div class="e-table-wrap">
            <table v-if="data.legs.length" class="e-table">
              <thead>
                <tr>
                  <th>Действие</th>
                  <th>Площадка</th>
                  <th>Исполнено</th>
                  <th>Состояние</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="l in data.legs" :key="l.id">
                  <th>{{ executionActions[l.action] }}</th>
                  <td>{{ l.venue }}</td>
                  <td>{{ money(l.filled) }} {{ l.symbol }}</td>
                  <td>{{ executionStatuses[l.state] }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <ul class="e-event-list">
            <li v-for="event in data.events" :key="event.id">
              <time>{{ shortTime(event.at) }}</time
              ><span>{{ executionMessage(event.code) }}</span>
            </li>
          </ul>
        </div>
      </details>
    </template>
    <p v-else-if="!pending" class="t-notice t-warning">
      Не удалось загрузить счёт. <button class="t-link" @click="refresh">Повторить</button>
    </p>
  </section>
</template>
