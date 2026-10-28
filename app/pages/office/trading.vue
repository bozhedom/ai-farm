<script setup lang="ts">
import type { TradingView, TradingOverview } from '../../../core/contracts/trading'
import { exchanges, type TradingMode, type TradingExchange } from '../../../core/trading/types'
import { exchangeCatalog } from '../../../core/trading/catalog'
import { officeFetch, useOfficeResource } from '~/composables/office/resource'
import { pct, shortTime, connectionState, tradingModes, tradingReason, usdt } from '~/utils/trading'

useHead({ title: 'Мои биржи' })
const mode = ref<TradingMode>('paper')
const exchange = ref<TradingExchange | null>(null)
const venue = computed(() => exchangeCatalog[exchange.value || 'okx'])
const section = ref('overview')
const tabs = [
  { id: 'overview', label: 'Результат' },
  { id: 'market', label: 'Рынок' },
  { id: 'agents', label: 'Стратегии' },
  { id: 'orders', label: 'История' },
  { id: 'connection', label: 'Подключение' },
] as const
const {
  data: v,
  status,
  pending,
  refresh,
} = useOfficeResource<TradingView>(
  () => (exchange.value ? `trading:${exchange.value}:${mode.value}` : null),
  () => officeFetch(`/api/trading?exchange=${exchange.value}&mode=${mode.value}`),
  { interval: 5000 },
)
const {
  data: overview,
  status: overviewStatus,
  pending: overviewPending,
  refresh: refreshOverview,
} = useOfficeResource<TradingOverview>(
  () => `trading-overview:${mode.value}`,
  () => officeFetch(`/api/trading/overview?mode=${mode.value}`),
  { interval: 5000 },
)
const busy = ref('')
const stopping = ref(false)
const error = ref('')
const notice = ref('')
const help = useTemplateRef<HTMLDialogElement>('helpDialog')
const currentMode = computed(() => tradingModes.find((m) => m.id === mode.value)!)
const currentConnection = computed(() =>
  overview.value?.connections.find((c) => c.exchange === exchange.value),
)
const runningCount = computed(
  () => overview.value?.connections.filter((c) => c.status === 'running').length || 0,
)
const allRunning = computed(() => runningCount.value === exchanges.length)
const offline = computed(
  () => overviewStatus.value.offline || (!!exchange.value && status.value.offline),
)
// The autopilot restarts training after a daily loss pause; the status says so only when it is on.
const { data: autonomy } = useOfficeResource<{ autopilotEnabled: boolean }>(
  () => 'office-autonomy',
  () => officeFetch('/api/office/autonomy'),
  { interval: 60_000 },
)
const stateOf = (c: TradingOverview['connections'][number]) =>
  connectionState(c, mode.value, autonomy.value?.autopilotEnabled)
const state = computed(() => (currentConnection.value ? stateOf(currentConnection.value) : null))
const statusSummary = computed(() => {
  const groups = new Map<string, number>()
  for (const c of overview.value?.connections ?? []) {
    const label = stateOf(c).label
    groups.set(label, (groups.get(label) ?? 0) + 1)
  }
  const parts = [...groups].map(([label, n]) => `«${label}» — ${n}`)
  return `Из ${exchanges.length} бирж: ${parts.join(', ')}`
})
const activeAgents = computed(() => v.value?.agents.filter((a) => a.status === 'active') || [])
const positionCount = computed(() => activeAgents.value.filter((a) => Number(a.base) > 0).length)
const activity = computed(() => {
  if (!v.value) return ''
  if (v.value.checkError || v.value.reason)
    return tradingReason(v.value.checkError || v.value.reason)
  if (v.value.status === 'idle')
    return mode.value === 'paper'
      ? 'Можно начинать. Бот сам выберет момент для покупки.'
      : 'Подключите счёт и пройдите проверку перед запуском.'
  if (!v.value.workerAlive)
    return 'Бот не на связи. Если связь не восстановится, обратитесь к администратору.'
  if (state.value?.tone === 'warning')
    return 'Ждём свежие данные биржи. Пока новых сделок не будет.'
  return positionCount.value
    ? 'Бот следит за купленными монетами и ждёт условия для продажи.'
    : 'Бот следит за ценами. Купит, когда выполнятся условия стратегии. Сделки не идут непрерывно.'
})
const startReady = computed(
  () =>
    !!v.value &&
    !status.value.offline &&
    v.value.status !== 'running' &&
    !v.value.unresolvedClientId &&
    (mode.value === 'paper' || v.value.readiness.keys) &&
    (mode.value !== 'live' ||
      (v.value.readiness.allocated && v.value.readiness.liveEnabled)),
)
const dialog = useTemplateRef<HTMLDialogElement>('confirmDialog')
const confirmAction = ref<'start' | 'flatten' | 'resolve'>('start'),
  confirmation = ref('')
const confirmPhrase = computed(() =>
  confirmAction.value === 'start'
    ? v.value?.liveConfirmation || ''
    : confirmAction.value === 'resolve'
      ? 'ПРОВЕРЕНО НА БИРЖЕ'
      : '',
)

watch([exchange, mode, section], () => {
  error.value = ''
  notice.value = ''
  confirmation.value = ''
})
async function act(action: string) {
  if (busy.value || stopping.value) return
  const selectedExchange = exchange.value || 'okx'
  const selectedMode = mode.value
  busy.value = action
  error.value = ''
  notice.value = ''
  try {
    await officeFetch('/api/trading/control', {
      method: 'POST',
      timeout: 90_000,
      body: {
        exchange: selectedExchange,
        mode: selectedMode,
        action,
        confirmation: confirmation.value,
        ...(action === 'resolve' ? { clientId: v.value?.unresolvedClientId } : {}),
      },
    })
    notice.value =
      action === 'check'
        ? 'Подключение проверено.'
        : action === 'start'
          ? 'Запуск принят. Первые решения появятся после проверки рынка.'
          : action === 'pause'
            ? 'Новые покупки на паузе. За купленными монетами бот продолжает следить.'
            : action === 'stop'
              ? 'Новые заявки остановлены. Купленные монеты остаются на счёте.'
              : 'Изменение сохранено.'
    dialog.value?.close()
    confirmation.value = ''
    await Promise.all([refresh(), refreshOverview()])
  } catch (e) {
    const err = e as { data?: { statusMessage?: string }; status?: number }
    error.value =
      err.status === 401
        ? 'Сессия завершилась. Войдите снова.'
        : tradingReason(err.data?.statusMessage || 'TRADING_NETWORK_UNAVAILABLE')
  } finally {
    busy.value = ''
  }
}
async function stopAll() {
  if (stopping.value) return
  stopping.value = true
  error.value = ''
  notice.value = ''
  try {
    await officeFetch('/api/trading/control', {
      method: 'POST',
      body: { exchange: exchange.value || 'okx', mode: mode.value, action: 'stop_all' },
    })
    notice.value =
      'Заявки остановлены на всех биржах и во всех режимах. Купленные монеты остаются на счетах.'
    await Promise.all([refresh(), refreshOverview()])
  } catch (e) {
    error.value = tradingReason(
      (e as { data?: { statusMessage?: string } }).data?.statusMessage ||
        'TRADING_NETWORK_UNAVAILABLE',
    )
  } finally {
    stopping.value = false
  }
}
async function startAllPaper() {
  if (busy.value || stopping.value) return
  busy.value = 'paper_all'
  error.value = ''
  notice.value = ''
  const results = await Promise.allSettled(
    exchanges.map((exchange) =>
      officeFetch('/api/trading/control', {
        method: 'POST',
        timeout: 90_000,
        body: { exchange, mode: 'paper', action: 'start' },
      }),
    ),
  )
  const failures = results.flatMap((r, i) =>
    r.status === 'rejected'
      ? [
          `${exchangeCatalog[exchanges[i]!].name}: ${tradingReason(r.reason?.data?.statusMessage || 'TRADING_NETWORK_UNAVAILABLE')}`,
        ]
      : [],
  )
  notice.value = `Тренировка запущена на биржах: ${results.length - failures.length} из ${results.length}.`
  error.value = failures.join(' ')
  await Promise.all([refresh(), refreshOverview()])
  busy.value = ''
}
function ask(action: 'start' | 'flatten' | 'resolve') {
  if (action === 'start' && mode.value !== 'live') {
    void act('start')
    return
  }
  confirmAction.value = action
  confirmation.value = ''
  dialog.value?.showModal()
}
function openExchange(value: TradingExchange, tab = 'overview') {
  if (busy.value) return
  exchange.value = value
  section.value = tab
}
async function allocationSaved() {
  notice.value = 'Бюджет сохранён. Деньги нужно внести на биржи самостоятельно.'
  await Promise.all([refresh(), refreshOverview()])
}
</script>
<template>
  <div class="trading-workspace">
    <div class="trading-main">
      <div class="context-row">
        <button
          v-if="exchange"
          class="t-link back-link"
          :disabled="!!busy"
          @click="exchange = null"
        >
          <OfficeIcon name="back" />Все биржи
        </button>
        <span v-else class="t-muted">OKX, Bybit, Binance и Bitget</span>
        <label class="mode-select"
          >Режим
          <select v-model="mode" :disabled="!!busy" aria-label="Режим торговли">
            <option v-for="m in tradingModes" :key="m.id" :value="m.id">{{ m.label }}</option>
          </select>
        </label>
      </div>

      <div class="page-heading">
        <div>
          <h1>{{ exchange ? venue.name : 'Мои биржи' }}</h1>
          <p class="t-muted">{{ currentMode.detail }}</p>
        </div>
        <div class="heading-actions">
          <button class="t-link" @click="help?.showModal()">Как это работает</button>
          <button
            v-if="!exchange && mode === 'paper' && !allRunning && overview"
            class="t-button t-primary"
            :disabled="!!busy || offline"
            @click="startAllPaper"
          >
            <OfficeIcon name="play" />{{
              busy === 'paper_all' ? 'Запускаем…' : 'Запустить тренировку'
            }}
          </button>
          <button
            class="t-button t-stop"
            :disabled="stopping"
            title="Остановить новые заявки на всех биржах и во всех режимах. Купленные монеты останутся на счетах."
            @click="stopAll"
          >
            <OfficeIcon name="stop" />{{ stopping ? 'Останавливаем…' : 'Остановить всё' }}
          </button>
        </div>
      </div>

      <p v-if="offline" class="t-notice t-warning" role="alert">
        Нет связи с приложением. Ниже последние полученные данные, они могут устареть. Пробуем
        подключиться снова.
      </p>
      <p v-if="error" class="t-notice t-warning" role="alert">{{ error }}</p>
      <p v-if="notice" class="t-notice" role="status">{{ notice }}</p>

      <template v-if="!exchange">
        <p v-if="overviewPending" class="t-empty" role="status">Загружаем биржи…</p>
        <div v-else-if="!overview" class="t-empty">
          <p>Не удалось загрузить биржи.</p>
          <button class="t-button" @click="refreshOverview">Повторить</button>
        </div>
        <template v-else>
          <dl class="home-totals">
            <div>
              <dt>{{ mode === 'live' ? 'Всего в работе' : 'Виртуальный баланс' }}</dt>
              <dd>{{ usdt(overview.equity) }} <small>USDT</small></dd>
            </div>
            <div>
              <dt>Результат с начала <span>· после комиссий</span></dt>
              <dd
                class="total-result"
                :class="Number(overview.pnl) < 0 ? 't-negative' : 't-positive'"
              >
                {{ Number(overview.pnl) > 0 ? '+' : '' }}{{ usdt(overview.pnl) }}
                <small>USDT</small>
              </dd>
            </div>
          </dl>
          <section class="exchange-list" aria-label="Биржи">
            <div class="exchange-list-head">
              <span>Биржа</span><span>Баланс, USDT</span><span>Результат, USDT</span><span />
            </div>
            <button
              v-for="c in overview.connections"
              :key="c.exchange"
              class="exchange-row"
              :disabled="!!busy"
              :aria-label="`Открыть ${exchangeCatalog[c.exchange].name}`"
              @click="openExchange(c.exchange, c.keys ? 'overview' : 'connection')"
            >
              <span class="exchange-name"
                ><span class="venue-mark" :class="c.exchange" aria-hidden="true">{{
                  exchangeCatalog[c.exchange].name.slice(0, 1)
                }}</span
                ><span
                  ><strong>{{ exchangeCatalog[c.exchange].name }}</strong
                  ><span class="connection-state" :class="`state-${stateOf(c).tone}`"
                    ><i />{{ stateOf(c).label }}</span
                  ><small v-if="stateOf(c).next" class="state-next">{{
                    stateOf(c).next
                  }}</small></span
                ></span
              >
              <span class="exchange-money"><small>Баланс</small>{{ usdt(c.equity) }}</span>
              <span
                class="exchange-money"
                :class="
                  Number(c.pnl) < 0 ? 't-negative' : Number(c.pnl) > 0 ? 't-positive' : 't-muted'
                "
                ><small>Результат</small>{{ Number(c.pnl) > 0 ? '+' : '' }}{{ usdt(c.pnl) }}</span
              >
              <OfficeIcon name="back" class="forward-icon" />
            </button>
          </section>
          <div class="list-caption">
            <p>
              {{
                mode === 'paper'
                  ? `${statusSummary}. У каждой биржи свой виртуальный бюджет и свои стратегии.`
                  : 'У каждой биржи свой счёт и свои стратегии. Переводов между счетами нет.'
              }}
            </p>
            <span>Откройте биржу, чтобы посмотреть подробнее</span>
          </div>
          <TradingFunding
            v-if="mode === 'live'"
            :overview="overview"
            :disabled="!!busy || offline"
            @busy="busy = $event ? 'allocation' : ''"
            @saved="allocationSaved"
            @error="error = $event"
          />
          <div class="home-help">
            <div>
              <h2>
                {{
                  mode === 'paper'
                    ? 'Можно просто наблюдать'
                    : mode === 'demo'
                      ? 'Сначала подключите тестовый счёт'
                      : 'Перед первым запуском'
                }}
              </h2>
              <p>
                {{
                  mode === 'paper'
                    ? 'Бот сам покупает, продаёт и сравнивает стратегии. Сервер должен оставаться включённым; эту вкладку можно закрыть.'
                    : mode === 'demo'
                      ? 'Выберите биржу из списка. Внутри написано, что подготовить и как проверить покупку и продажу без настоящих денег.'
                      : 'Откройте нужную биржу: там видны результаты проверок и кнопка запуска. Выбор этого режима сам по себе не начинает торговлю.'
                }}
              </p>
            </div>
            <button class="t-link" @click="help?.showModal()">
              Разобраться за минуту <OfficeIcon name="back" class="forward-icon" />
            </button>
          </div>
        </template>
      </template>

      <template v-else>
        <nav class="trading-tabs" aria-label="Разделы биржи">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            :aria-current="section === tab.id ? 'page' : undefined"
            :disabled="!!busy"
            @click="section = tab.id"
          >
            {{ tab.label
            }}<span
              v-if="tab.id === 'orders' && v?.unresolvedClientId"
              class="attention-dot"
              aria-label="Есть заявка для проверки"
            />
          </button>
        </nav>
        <p v-if="pending" class="t-empty" role="status">Загружаем {{ venue.name }}…</p>
        <div v-else-if="!v" class="t-empty">
          <p>{{ status.error || 'Не удалось загрузить биржу.' }}</p>
          <button class="t-button" @click="refresh">Повторить</button>
        </div>
        <template v-else>
          <div v-if="section === 'overview'" class="t-stack">
            <section
              class="activity-bar"
              :class="{ 'needs-attention': state?.tone === 'warning' || v.status === 'stopped' }"
              aria-label="Состояние торговли"
            >
              <div>
                <strong class="connection-state" :class="`state-${state?.tone || 'muted'}`"
                  ><i />{{ state?.text || 'Проверяем состояние' }}</strong
                >
                <p>{{ activity }}</p>
                <button class="market-shortcut" @click="section = 'market'">
                  Как выбираются монеты
                </button>
              </div>
              <button
                v-if="v.status === 'running'"
                class="t-button"
                :disabled="!!busy || offline"
                @click="act('pause')"
              >
                <OfficeIcon name="pause" />Приостановить покупки
              </button>
              <button
                v-else-if="startReady"
                class="t-button t-primary"
                :disabled="!!busy || offline"
                @click="ask('start')"
              >
                <OfficeIcon name="play" />{{
                  busy === 'start' ? 'Запускаем…' : v.status === 'idle' ? 'Запустить' : 'Продолжить'
                }}
              </button>
              <button
                v-else-if="mode !== 'paper'"
                class="t-button"
                :disabled="!!busy"
                @click="section = 'connection'"
              >
                Подключить счёт
              </button>
            </section>
            <section class="t-panel result-panel" aria-label="Результат торговли">
              <dl class="result-totals">
                <div>
                  <dt>{{ mode === 'live' ? 'На этой бирже' : 'Виртуальный баланс' }}</dt>
                  <dd>{{ usdt(v.metrics.equity) }} <small>USDT</small></dd>
                </div>
                <div>
                  <dt>Результат с начала</dt>
                  <dd :class="Number(v.metrics.pnl) < 0 ? 't-negative' : 't-positive'">
                    {{ Number(v.metrics.pnl) > 0 ? '+' : '' }}{{ usdt(v.metrics.pnl) }}
                    <small>USDT</small>
                  </dd>
                </div>
              </dl>
              <TradingEquityChart :points="v.equity" :capital="v.metrics.capital" />
              <dl class="balance-breakdown">
                <div>
                  <dt>Свободно</dt>
                  <dd>{{ usdt(v.metrics.cash) }} USDT</dd>
                </div>
                <div>
                  <dt>В купленных монетах</dt>
                  <dd>{{ usdt(v.metrics.exposure) }} USDT</dd>
                </div>
                <div>
                  <dt>Покупок с последующей продажей</dt>
                  <dd>{{ v.metrics.roundTrips }}</dd>
                </div>
              </dl>
            </section>
            <details class="t-details">
              <summary>Управление и ограничения</summary>
              <div class="t-details-body t-stack">
                <p class="t-muted">
                  Пауза запрещает новые покупки. Бот продолжает следить за купленными монетами и
                  продавать их по условиям стратегии.
                </p>
                <div class="t-actions">
                  <button
                    class="t-button"
                    :disabled="!Number(v.metrics.exposure) || !!busy || offline"
                    @click="ask('flatten')"
                  >
                    Продать купленные монеты</button
                  ><button
                    class="t-button t-stop"
                    :disabled="!!busy || v.status === 'stopped' || v.status === 'idle'"
                    @click="act('stop')"
                  >
                    Остановить {{ venue.name }}
                  </button>
                </div>
                <p class="t-muted">
                  Остановка запрещает новые покупки и продажи. Монеты остаются на счёте; уже
                  отправленные заявки продолжают проверяться.
                </p>
                <dl class="t-facts">
                  <div>
                    <dt>Покупка за один раз</dt>
                    <dd>до {{ v.limits.orderUsdt }} USDT</dd>
                  </div>
                  <div>
                    <dt>Доля денег в монетах</dt>
                    <dd>до {{ pct(v.limits.exposureBps) }}</dd>
                  </div>
                  <div>
                    <dt>Убыток за день</dt>
                    <dd>{{ pct(v.metrics.dailyLossBps) }} / {{ pct(v.limits.dailyLossBps) }}</dd>
                  </div>
                  <div>
                    <dt>Снижение от максимума</dt>
                    <dd>{{ pct(v.metrics.drawdownBps) }} / {{ pct(v.limits.drawdownBps) }}</dd>
                  </div>
                  <div>
                    <dt>Выход при падении купленной монеты</dt>
                    <dd>{{ pct(v.limits.positionStopBps) }}</dd>
                  </div>
                  <div>
                    <dt>Комиссии за всё время</dt>
                    <dd>{{ usdt(v.metrics.fees, 4) }} USDT</dd>
                  </div>
                  <div>
                    <dt>Результат завершённых покупок и продаж</dt>
                    <dd>{{ usdt(v.metrics.realized, 4) }} USDT</dd>
                  </div>
                </dl>
                <p class="t-muted">
                  Лимиты запускают защитную продажу. При резком падении цены или потере связи убыток
                  может быть больше. Только спот за USDT, без займов; вывод денег недоступен.
                </p>
              </div>
            </details>
            <details class="t-details">
              <summary>Цены и связь с биржей</summary>
              <div class="t-details-body">
                <dl class="t-facts">
                  <div v-for="market in v.markets" :key="market.symbol">
                    <dt>
                      {{ market.symbol.replace('-', ' / ')
                      }}<small>{{ shortTime(market.at) }}</small>
                    </dt>
                    <dd>{{ usdt(market.bid) }} / {{ usdt(market.ask) }} USDT</dd>
                  </div>
                </dl>
                <p class="t-muted">
                  {{
                    v.checkedAt
                      ? `Последняя проверка: ${shortTime(v.checkedAt)}.`
                      : 'Связь ещё не проверена.'
                  }}
                  Цены покупки и продажи могут отличаться.
                </p>
                <button
                  class="t-button"
                  :disabled="!!busy || !v.readiness.keys || offline"
                  @click="act('check')"
                >
                  {{ busy === 'check' ? 'Проверяем…' : 'Проверить связь' }}
                </button>
              </div>
            </details>
          </div>
          <TradingMarket
            v-else-if="section === 'market'"
            :key="`${exchange}:${mode}`"
            :view="v"
            :busy="!!busy"
            :offline="offline"
            @check="act('check')"
          />
          <TradingStrategies
            v-else-if="section === 'agents'"
            :key="`${exchange}:${mode}`"
            :view="v"
            @overview="section = 'overview'"
            @updated="refresh"
          />
          <TradingHistory
            v-else-if="section === 'orders'"
            :view="v"
            :disabled="!!busy || offline"
            @resolve="ask('resolve')"
          />
          <TradingConnection
            v-else
            :view="v"
            :busy="busy"
            :offline="offline"
            :start-ready="startReady"
            @action="act"
            @start="ask('start')"
            @overview="section = 'overview'"
          >
            <TradingFunding
              v-if="mode === 'live' && overview"
              :overview="overview"
              :disabled="!!busy || offline"
              @busy="busy = $event ? 'allocation' : ''"
              @saved="allocationSaved"
              @error="error = $event"
            />
          </TradingConnection>
          <p
            v-if="section !== 'overview' && (v.checkError || v.reason)"
            class="t-notice"
            :class="{ 't-warning': !!v.checkError || v.status === 'stopped' }"
            role="status"
          >
            {{ tradingReason(v.checkError || v.reason) }}
          </p>
        </template>
      </template>
      <footer class="trading-footer">
        <span>{{
          mode === 'live'
            ? 'Прибыль не гарантирована. Комиссии учтены, сервер и налоги отдельно.'
            : 'Это тестовые деньги. Результаты тренировки не означают реальный доход.'
        }}</span>
      </footer>
    </div>

    <dialog
      ref="confirmDialog"
      class="trade-dialog"
      aria-labelledby="confirm-title"
      @close="confirmation = ''"
      @cancel="busy && $event.preventDefault()"
    >
      <form @submit.prevent="act(confirmAction)">
        <h2 id="confirm-title">
          {{
            confirmAction === 'start'
              ? `Начать торговлю на ${venue.name}?`
              : confirmAction === 'flatten'
                ? `Продать монеты на ${venue.name}?`
                : 'Заявки точно нет на бирже?'
          }}
        </h2>
        <p>
          {{
            confirmAction === 'start'
              ? `Бот сможет покупать и продавать в пределах ${v?.metrics.capital} USDT на счёте ${venue.name}. Это настоящие деньги: возможна потеря капитала.`
              : confirmAction === 'flatten'
                ? `Режим: ${currentMode.label}. Новые покупки прекратятся. Бот начнёт продавать монеты по доступной цене в пределах лимита. Маленькие остатки могут остаться непроданными.`
                : `Режим: ${currentMode.label}, биржа ${venue.name}. Сначала проверьте историю заявок и сделок на бирже. Приложение дополнительно сверит отсутствие заявки и баланс.`
          }}
        </p>
        <label v-if="confirmPhrase" class="confirm-field"
          >Введите «{{ confirmPhrase }}»<input
            v-model="confirmation"
            autocomplete="off"
            spellcheck="false"
            :disabled="!!busy"
        /></label>
        <p v-if="error" class="t-notice t-warning" role="alert">{{ error }}</p>
        <div class="t-actions dialog-actions">
          <button class="t-button" type="button" :disabled="!!busy" @click="dialog?.close()">
            Отмена</button
          ><button
            class="t-button t-primary"
            :disabled="!!busy || (!!confirmPhrase && confirmation !== confirmPhrase)"
          >
            {{ busy ? 'Проверяем…' : 'Подтвердить' }}
          </button>
        </div>
      </form>
    </dialog>
    <dialog ref="helpDialog" class="trade-dialog help-dialog" aria-labelledby="help-title">
      <div class="section-heading">
        <h2 id="help-title">Как работает Ферма</h2>
        <button class="t-icon-button" aria-label="Закрыть справку" @click="help?.close()">
          <OfficeIcon name="close" />
        </button>
      </div>
      <p>
        Вы выбираете биржу и запускаете бота. Он следит за ценами монет к USDT, покупает и продаёт
        по заданным правилам. Заработок не гарантирован.
      </p>
      <ol class="setup-steps">
        <li>
          <strong>Тренировка: можно уже сейчас</strong>
          <p>
            На каждой бирже четыре стратегии делят виртуальный бюджет. Сравниваем их результаты с
            учётом комиссий. Аккаунты и пополнение не нужны.
          </p>
        </li>
        <li>
          <strong>Тест биржи: после подключения</strong>
          <p>
            На тестовом счёте проверяем настоящую отправку заявок, покупку, продажу и баланс. Для
            этого нужны отдельные тестовые ключи биржи.
          </p>
        </li>
        <li>
          <strong>Реальная торговля: после проверок</strong>
          <p>
            Вы задаёте бюджет, вносите деньги на выбранные биржи и подтверждаете запуск каждой.
            Нужны успешный тест и прибыльная тренировочная стратегия: от 7 дней и 20 завершённых
            покупок с продажей.
          </p>
        </li>
      </ol>
      <details class="t-details">
        <summary>Как выбираются стратегии</summary>
        <div class="t-details-body">
          <p>
            Каждый агент торгует по своей стратегии, со своим балансом и историей. Когда наблюдений
            достаточно, слабые варианты уходят в архив, а на основе двух лидеров появляются новые.
            Если убедительного преимущества нет, состав остаётся прежним.
          </p>
        </div>
      </details>
      <p class="t-muted">
        Сервер должен работать постоянно. Биржи независимы: бот не переводит между ними деньги.
        Переключение режима в кабинете только меняет то, что вы смотрите.
      </p>
      <button class="t-button t-primary" @click="help?.close()">Понятно</button>
    </dialog>
  </div>
</template>
<style src="../../assets/trading.css"></style>
