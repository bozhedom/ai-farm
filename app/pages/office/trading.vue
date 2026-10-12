<script setup lang="ts">
import type { TradingView, TradingOverview } from '../../../core/contracts/trading'
import { exchanges, type TradingMode, type TradingExchange } from '../../../core/trading/types'
import { exchangeCatalog } from '../../../core/trading/catalog'
import { officeFetch, useOfficeResource } from '~/composables/office/resource'
import { officeApi } from '~/composables/office/actions'
import {
  orderStatus,
  pct,
  shortTime,
  strategyName,
  tradingModes,
  tradingReason,
  usdt,
} from '~/utils/trading'

useHead({ title: 'Торговая ферма', bodyAttrs: { class: 'trading-body' } })
const mode = ref<TradingMode>('paper')
const exchange = ref<TradingExchange>('okx')
const venue = computed(() => exchangeCatalog[exchange.value])
const section = ref('overview')
const tabs = [
  { id: 'overview', label: 'Обзор', icon: 'home' },
  { id: 'agents', label: 'Агенты', icon: 'agents' },
  { id: 'orders', label: 'Сделки', icon: 'list' },
  { id: 'connection', label: 'Подключение', icon: 'settings' },
] as const
const {
  data: v,
  status,
  pending,
  refresh,
} = useOfficeResource<TradingView>(
  () => `trading:${exchange.value}:${mode.value}`,
  () => officeFetch(`/api/trading?exchange=${exchange.value}&mode=${mode.value}`),
  { interval: 5000 },
)
const {
  data: overview,
  status: overviewStatus,
  refresh: refreshOverview,
} = useOfficeResource<TradingOverview>(
  () => `trading-overview:${mode.value}`,
  () => officeFetch(`/api/trading/overview?mode=${mode.value}`),
  { interval: 5000 },
)
const amounts = ref<Record<TradingExchange, number>>({ okx: 100, bybit: 0, binance: 0, bitget: 0 })
const allocationDirty = ref(false)
watch(overview, (value) => {
  if (value && !allocationDirty.value)
    for (const c of value.connections) amounts.value[c.exchange] = Number(c.liveAllocation)
})
const allocationTotal = computed(() =>
  exchanges.reduce((sum, e) => sum + Number(amounts.value[e]), 0),
)
const allocationValid = computed(
  () =>
    exchanges.every(
      (e) =>
        Number.isInteger(amounts.value[e]) && (amounts.value[e] === 0 || amounts.value[e] >= 20),
    ) && allocationTotal.value <= 100,
)
const envExample = computed(() => {
  const prefix = `${exchange.value.toUpperCase()}_${mode.value === 'demo' ? 'DEMO' : 'LIVE'}`
  return [
    `${prefix}_API_KEY=…`,
    `${prefix}_SECRET=…`,
    ...(venue.value.passphrase ? [`${prefix}_PASSPHRASE=…`] : []),
  ].join('\n')
})
const busy = ref(''),
  error = ref(''),
  notice = ref(''),
  showArchived = ref(false)
const activeAgents = computed(() => v.value?.agents.filter((a) => a.status === 'active') || [])
const shownAgents = computed(
  () => v.value?.agents.filter((a) => showArchived.value || a.status === 'active') || [],
)
const currentMode = computed(() => tradingModes.find((m) => m.id === mode.value)!)
const stateLabel = computed(() =>
  v.value
    ? {
        idle: mode.value === 'paper' ? 'Готов к запуску' : 'Требуется подключение',
        running: 'Работает',
        paused: 'Входы на паузе',
        stopped: 'Остановлен',
      }[v.value.status]
    : 'Загрузка',
)
const startReady = computed(
  () =>
    !!v.value &&
    !status.value.offline &&
    v.value.status !== 'running' &&
    !v.value.unresolvedClientId &&
    (mode.value === 'paper' || v.value.readiness.keys) &&
    (mode.value !== 'live' ||
      (v.value.readiness.allocated &&
        v.value.readiness.liveEnabled &&
        v.value.readiness.paperQualified &&
        v.value.readiness.demoVerified)),
)
const cashShare = computed(() =>
  v.value
    ? Math.max(
        0,
        Math.min(
          100,
          (Number(v.value.metrics.cash) / Math.max(1, Number(v.value.metrics.equity))) * 100,
        ),
      )
    : 100,
)
const positive = computed(() => Number(v.value?.metrics.pnl || '0') >= 0)
const checklist = computed(() =>
  v.value
    ? [
        {
          label: 'Ключи выбранного аккаунта',
          ok: v.value.readiness.keys,
          detail:
            mode.value === 'paper'
              ? 'Для бумаги ключи не нужны.'
              : 'Отдельный ключ с чтением и торговлей, без вывода.',
        },
        {
          label: 'Подключение и котировки',
          ok: v.value.readiness.connection,
          detail:
            'Свежие цены; для биржи также права, баланс, комиссии и отсутствие сторонних ордеров.',
        },
        ...(mode.value === 'live'
          ? [
              {
                label: 'Выделен бюджет',
                ok: v.value.readiness.allocated,
                detail: `Для ${venue.value.name} выделено ${v.value.metrics.capital} USDT. Минимум 20 USDT.`,
              },
              {
                label: 'Допуск на сервере',
                ok: v.value.readiness.liveEnabled,
                detail: 'TRADING_LIVE_ENABLED=true после проверок.',
              },
              {
                label: 'Проверка демо-счёта',
                ok: v.value.readiness.demoVerified,
                detail: 'Успешная покупка, продажа и недавняя сверка.',
              },
              {
                label: 'Бумажный агент прошёл отбор',
                ok: v.value.readiness.paperQualified,
                detail:
                  'От 7 дней и 20 закрытых позиций, положительный результат и просадка до 8%.',
              },
            ]
          : []),
      ]
    : [],
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
  const selectedMode = mode.value
  busy.value = action
  error.value = ''
  notice.value = ''
  try {
    await officeFetch('/api/trading/control', {
      method: 'POST',
      timeout: 90_000,
      body: {
        exchange: exchange.value,
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
          : action === 'stop_all'
            ? 'Все торговые портфели остановлены. Открытые активы остаются на бирже.'
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
async function saveAllocation() {
  busy.value = 'allocation'
  error.value = ''
  notice.value = ''
  try {
    await officeFetch('/api/trading/allocation', {
      method: 'POST',
      body: { amounts: amounts.value },
    })
    allocationDirty.value = false
    await Promise.all([refresh(), refreshOverview()])
    notice.value = 'Распределение сохранено. Пополните выбранные торговые счета самостоятельно.'
  } catch (e) {
    error.value = tradingReason(
      (e as { data?: { statusMessage?: string } }).data?.statusMessage ||
        'TRADING_NETWORK_UNAVAILABLE',
    )
  } finally {
    busy.value = ''
  }
}
async function startAllPaper() {
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
  notice.value = `Бумажные портфели запущены: ${results.length - failures.length} из ${results.length}.`
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
async function logout() {
  await officeApi.logout()
  await navigateTo('/office/login')
}
function exportOrders() {
  if (!v.value) return
  const rows = [
    [
      'time',
      'mode',
      'exchange',
      'client_id',
      'symbol',
      'side',
      'status',
      'filled_qty',
      'quote_usdt',
      'fee_base',
      'fee_usdt',
    ],
    ...v.value.orders.map((o) => [
      o.createdAt,
      mode.value,
      exchange.value,
      o.clientId,
      o.symbol,
      o.side,
      o.status,
      o.filledQty,
      o.quote,
      o.feeBase,
      o.feeQuote,
    ]),
  ]
  const blob = new Blob(
    [
      '\uFEFF' +
        rows.map((r) => r.map((s) => '"' + s.replaceAll('"', '""') + '"').join(',')).join('\r\n'),
    ],
    { type: 'text/csv;charset=utf-8' },
  )
  const url = URL.createObjectURL(blob),
    a = document.createElement('a')
  a.href = url
  a.download = `ai-farm-${exchange.value}-${mode.value}-orders.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>
<template>
  <div class="trading-workspace">
    <a class="sr-only skip-trading" href="#trading-main">К торговому портфелю</a>
    <header class="trading-header">
      <NuxtLink to="/office/trading" class="trading-brand"
        ><span class="trading-mark"><OfficeIcon name="leaf" /></span
        ><span>AI Farm<small>Торговая ферма</small></span></NuxtLink
      >
      <div class="server-state">
        <i :class="{ 'is-alive': v?.workerAlive && !status.offline }" /><span>{{
          status.offline
            ? 'Нет связи с приложением'
            : v?.workerAlive
              ? 'Обработчик на связи'
              : 'Ожидание обработчика'
        }}</span>
      </div>
      <button
        class="t-button t-danger header-stop"
        type="button"
        :disabled="busy === 'stop_all'"
        @click="act('stop_all')"
      >
        <OfficeIcon name="stop" />Стоп всем
      </button>
      <button class="logout-button" type="button" aria-label="Выйти из кабинета" @click="logout">
        <OfficeIcon name="logout" />
      </button>
    </header>
    <div class="trading-layout">
      <aside class="trading-nav" aria-label="Торговый кабинет">
        <p class="nav-caption">Ваш портфель</p>
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          :class="{ selected: section === tab.id }"
          :aria-current="section === tab.id ? 'page' : undefined"
          @click="section = tab.id"
        >
          <OfficeIcon :name="tab.icon" />{{ tab.label
          }}<span v-if="tab.id === 'orders' && v?.unresolvedClientId" class="nav-alert">!</span>
        </button>
        <div class="nav-bottom">
          <span class="nav-caption">Сохранённая история</span
          ><NuxtLink to="/office"><OfficeIcon name="box" />Студия текстов</NuxtLink>
          <p>Прежние продукты и заказы сохранены отдельно.</p>
          <a :href="venue.docs" target="_blank" rel="noopener noreferrer"
            >API {{ venue.name }} <OfficeIcon name="external"
          /></a>
        </div>
      </aside>
      <main id="trading-main" class="trading-main">
        <div class="workspace-heading">
          <div>
            <p class="t-eyebrow">ЕДИНЫЙ КАБИНЕТ / СПОТ / USDT</p>
            <h1>
              {{
                tabs.find((t) => t.id === section)?.label === 'Обзор'
                  ? 'Капитал под наблюдением'
                  : tabs.find((t) => t.id === section)?.label
              }}
            </h1>
            <p class="t-muted">Четыре биржи. Отдельные портфели. Общее управление.</p>
          </div>
          <span class="version-label">BTC + ETH <OfficeIcon name="check" /></span>
        </div>
        <div class="mode-picker" role="group" aria-label="Режим торгового портфеля">
          <button
            v-for="m in tradingModes"
            :key="m.id"
            type="button"
            :class="{ selected: mode === m.id, 'live-mode': m.id === 'live' }"
            :aria-pressed="mode === m.id"
            :disabled="!!busy"
            @click="mode = m.id"
          >
            <span>{{ m.label }}</span
            ><small>{{ m.detail }}</small>
          </button>
        </div>
        <section v-if="overview" class="exchange-hub" aria-label="Биржевые подключения">
          <div class="hub-heading">
            <div>
              <span class="t-eyebrow">{{
                mode === 'live' ? 'РЕАЛЬНЫЕ ПОРТФЕЛИ' : 'ВИРТУАЛЬНЫЕ ПОРТФЕЛИ'
              }}</span>
              <p>
                <strong>{{ usdt(overview.equity) }} USDT</strong
                ><span class="t-muted">всего · результат {{ usdt(overview.pnl, 4) }} USDT</span>
              </p>
            </div>
            <button
              v-if="mode === 'paper'"
              class="t-button"
              :disabled="!!busy || overviewStatus.offline"
              @click="startAllPaper"
            >
              {{ busy === 'paper_all' ? 'Проверяем биржи…' : 'Запустить все на бумаге' }}
            </button>
            <button v-else-if="mode === 'live'" class="text-button" @click="section = 'connection'">
              Бюджет {{ overview.allocated }} / {{ overview.capitalLimit }} USDT
            </button>
          </div>
          <div class="exchange-picker" role="group" aria-label="Выбор биржи">
            <button
              v-for="c in overview.connections"
              :key="c.exchange"
              type="button"
              class="exchange-card"
              :class="{ selected: exchange === c.exchange }"
              :aria-pressed="exchange === c.exchange"
              :disabled="!!busy"
              @click="exchange = c.exchange"
            >
              <span class="exchange-card-heading"
                ><strong>{{ exchangeCatalog[c.exchange].name }}</strong
                ><i
                  :class="{
                    'is-alive': c.status === 'running' && c.fresh,
                    'is-error': !!c.error && c.error.startsWith('TRADING_'),
                  }"
              /></span>
              <span class="exchange-card-value">{{ usdt(c.equity) }} <small>USDT</small></span>
              <span class="exchange-card-state"
                >{{
                  c.error.startsWith('TRADING_')
                    ? 'Нужна проверка'
                    : !c.keys
                      ? 'Нужны ключи'
                      : c.status === 'running'
                        ? c.fresh
                          ? 'Работает'
                          : 'Ждёт котировки'
                        : c.status === 'paused'
                          ? 'Пауза'
                          : c.status === 'stopped'
                            ? 'Остановлен'
                            : 'Готов к запуску'
                }}
                · {{ c.activeAgents }} аг.</span
              >
            </button>
          </div>
          <p class="fine-print">
            {{
              mode === 'live'
                ? 'Бюджет распределяется между биржами. Переводы выполняет владелец; лимит не означает наличие средств на счетах.'
                : 'По 100 виртуальных USDT на биржу. Результаты этого режима не входят в реальный капитал.'
            }}
          </p>
        </section>
        <p v-if="overviewStatus.offline" class="trading-notice is-error" role="status">
          Сводка бирж временно недоступна. Показаны последние полученные данные.
        </p>
        <p v-if="error" class="trading-notice is-error" role="alert">{{ error }}</p>
        <p v-if="notice" class="trading-notice" role="status">{{ notice }}</p>
        <p v-if="status.offline" class="trading-notice is-error" role="status">
          Нет связи. Цифры ниже могут быть устаревшими. Повторяем запрос автоматически.
        </p>
        <div v-if="pending" class="t-panel loading-panel" role="status">
          Загружаем торговый портфель…
        </div>
        <div v-else-if="!v" class="t-panel loading-panel">
          <p>{{ status.error || 'Портфель недоступен.' }}</p>
          <button class="t-button" @click="refresh">Повторить</button>
        </div>
        <template v-else>
          <div class="portfolio-bar">
            <strong class="selected-venue"
              >{{ venue.name }}
              <small>{{ mode === 'demo' ? venue.demoName : currentMode.label }}</small></strong
            >
            <span class="status-pill" :class="v.status"><i />{{ stateLabel }}</span
            ><span>{{ mode === 'live' ? 'Реальный счёт' : 'Тестовый результат, не доход' }}</span
            ><span class="portfolio-timestamp">{{
              v.checkedAt ? `Проверка ${shortTime(v.checkedAt)}` : 'Подключение ещё не проверено'
            }}</span>
          </div>
          <p
            v-if="v.checkError || v.reason"
            class="trading-notice"
            :class="{ 'is-error': !!v.checkError || v.status === 'stopped' }"
            role="status"
          >
            {{ tradingReason(v.checkError || v.reason) }}
          </p>

          <template v-if="section === 'overview'">
            <div class="overview-grid">
              <section class="t-panel capital-panel" aria-labelledby="capital-title">
                <div class="panel-heading">
                  <h2 id="capital-title">
                    {{
                      mode === 'paper'
                        ? 'Бумажный капитал'
                        : mode === 'demo'
                          ? 'Демо-капитал'
                          : 'Капитал в работе'
                    }}
                  </h2>
                  <span class="t-muted">Последние 24 часа</span>
                </div>
                <div class="capital-value">
                  <strong>{{ usdt(v.metrics.equity) }}</strong
                  ><span>USDT</span
                  ><span class="pnl" :class="positive ? 'is-positive' : 'is-negative'"
                    >{{ positive ? '+' : '' }}{{ usdt(v.metrics.pnl, 4)
                    }}<small>с начала</small></span
                  >
                </div>
                <TradingEquityChart :points="v.equity" :capital="v.metrics.capital" />
                <div class="allocation">
                  <div
                    class="allocation-track"
                    :aria-label="`В USDT ${usdt(v.metrics.cash)}, в позициях ${usdt(v.metrics.exposure)}`"
                  >
                    <i :style="{ width: `${cashShare}%` }" />
                  </div>
                  <div class="allocation-labels">
                    <span
                      ><i class="cash-dot" />Свободно
                      <strong>{{ usdt(v.metrics.cash) }} USDT</strong></span
                    ><span
                      ><i class="asset-dot" />В позициях
                      <strong>{{ usdt(v.metrics.exposure) }} USDT</strong></span
                    >
                  </div>
                </div>
                <div class="portfolio-actions">
                  <button
                    class="t-button t-primary"
                    :disabled="!startReady || !!busy"
                    @click="ask('start')"
                  >
                    <OfficeIcon name="play" />{{
                      busy === 'start'
                        ? 'Проверяем и запускаем…'
                        : v.status === 'idle'
                          ? 'Запустить портфель'
                          : 'Продолжить'
                    }}</button
                  ><button
                    class="t-button"
                    :disabled="v.status !== 'running' || !!busy"
                    @click="act('pause')"
                  >
                    <OfficeIcon name="pause" />Пауза входов</button
                  ><button
                    class="t-button t-quiet"
                    :disabled="!Number(v.metrics.exposure) || !!busy"
                    @click="ask('flatten')"
                  >
                    Закрыть позиции</button
                  ><button
                    class="t-button t-quiet"
                    :disabled="!!busy || v.status === 'stopped' || v.status === 'idle'"
                    @click="act('stop')"
                  >
                    Стоп {{ venue.name }}
                  </button>
                </div>
                <p class="fine-print">
                  {{
                    mode === 'paper'
                      ? 'Можно начать без аккаунта. Виртуальные 100 USDT распределяются между четырьмя агентами.'
                      : `Деньги остаются на вашем аккаунте ${venue.name}. Приложение не выполняет ввод и вывод.`
                  }}
                </p>
              </section>
              <aside class="t-panel risk-panel" aria-labelledby="risk-title">
                <div class="panel-heading">
                  <h2 id="risk-title">Границы риска</h2>
                  <OfficeIcon name="check" />
                </div>
                <p class="t-muted">Действуют для каждого ордера</p>
                <div class="risk-rule">
                  <div>
                    <span>Убыток за сутки</span
                    ><strong
                      >{{ pct(v.metrics.dailyLossBps) }}
                      <small>/ {{ pct(v.limits.dailyLossBps) }}</small></strong
                    >
                  </div>
                  <meter
                    :value="v.metrics.dailyLossBps"
                    :max="v.limits.dailyLossBps"
                    min="0"
                    aria-label="Дневной убыток"
                  />
                </div>
                <div class="risk-rule">
                  <div>
                    <span>Просадка от пика</span
                    ><strong
                      >{{ pct(v.metrics.drawdownBps) }}
                      <small>/ {{ pct(v.limits.drawdownBps) }}</small></strong
                    >
                  </div>
                  <meter
                    :value="v.metrics.drawdownBps"
                    :max="v.limits.drawdownBps"
                    min="0"
                    aria-label="Просадка от пика"
                  />
                </div>
                <dl class="risk-list">
                  <div>
                    <dt>Один вход</dt>
                    <dd>до {{ v.limits.orderUsdt }} USDT</dd>
                  </div>
                  <div>
                    <dt>Капитал в позициях</dt>
                    <dd>до {{ pct(v.limits.exposureBps) }}</dd>
                  </div>
                  <div>
                    <dt>Стоп позиции</dt>
                    <dd>{{ pct(v.limits.positionStopBps) }}</dd>
                  </div>
                  <div>
                    <dt>Плечо и вывод</dt>
                    <dd>Запрещены</dd>
                  </div>
                </dl>
                <p class="risk-footnote">
                  Порог запускает защитный выход. При резком движении или недоступности биржи убыток
                  может быть больше.
                </p>
              </aside>
            </div>
            <div class="metric-strip">
              <div>
                <span>Закрытые позиции</span><strong>{{ v.metrics.roundTrips }}</strong>
              </div>
              <div>
                <span>Реализованный результат</span
                ><strong>{{ usdt(v.metrics.realized, 4) }} <small>USDT</small></strong>
              </div>
              <div>
                <span>Комиссии</span
                ><strong>{{ usdt(v.metrics.fees, 4) }} <small>USDT</small></strong>
              </div>
              <div>
                <span>Расходы на модель</span><strong>0 <small>USDT</small></strong>
              </div>
            </div>
            <div class="detail-grid">
              <section class="t-panel">
                <div class="panel-heading">
                  <h2>Рынок сейчас</h2>
                  <button class="text-button" :disabled="!!busy" @click="act('check')">
                    {{ busy === 'check' ? 'Проверяем…' : 'Проверить связь' }}
                  </button>
                </div>
                <div v-for="market in v.markets" :key="market.symbol" class="market-row">
                  <span class="coin-mark">{{ market.symbol.startsWith('BTC') ? 'B' : 'E' }}</span>
                  <div>
                    <strong>{{ market.symbol.replace('-', ' / ') }}</strong
                    ><small>{{ shortTime(market.at) }}</small>
                  </div>
                  <div class="market-price">
                    <strong>{{ usdt(market.bid) }}</strong
                    ><small>покупатель / {{ usdt(market.ask) }} продавец</small>
                  </div>
                </div>
                <p v-if="!v.markets.length" class="empty-copy">
                  Проверьте связь или запустите портфель: здесь появятся реальные цены из стакана
                  {{ venue.name }}.
                </p>
              </section>
              <section class="t-panel">
                <div class="panel-heading">
                  <h2>Отбор стратегий</h2>
                  <span class="generation">Поколение {{ v.generation }}</span>
                </div>
                <p class="evolution-copy">
                  {{
                    mode === 'paper'
                      ? tradingReason(v.evolutionReason)
                      : 'Один агент торгует на бирже. Более сильный бумажный лидер может заменить его после полного закрытия позиции.'
                  }}
                </p>
                <div class="evolution-rule">
                  <span><strong>7</strong> дней наблюдения</span
                  ><span><strong>20</strong> закрытых позиций на агента</span>
                </div>
                <button class="text-button" @click="section = 'agents'">Посмотреть агентов</button>
              </section>
            </div>
          </template>

          <section v-if="section === 'agents'" class="t-panel">
            <div class="panel-heading">
              <div>
                <h2>Команда стратегий</h2>
                <p class="t-muted">
                  {{ activeAgents.length }} активных. Результат после комиссий, оценка открытых
                  активов по цене продажи.
                </p>
              </div>
              <label class="archive-switch"
                ><input v-model="showArchived" type="checkbox" />Показать архив</label
              >
            </div>
            <p class="evolution-copy">
              {{ tradingReason(v.evolutionReason) }}
              {{
                mode === 'paper'
                  ? 'Два доказавших преимущество лидера дают следующее поколение.'
                  : 'На реальном счёте смена лидера возможна только при полностью закрытой позиции.'
              }}
              История и родство сохраняются.
            </p>
            <div class="agent-grid">
              <article
                v-for="a in shownAgents"
                :key="a.id"
                class="agent-card"
                :class="{ archived: a.status === 'archived' }"
              >
                <div class="agent-top">
                  <span class="agent-emblem">{{ a.name.slice(0, 1) }}</span>
                  <div>
                    <h3>{{ a.name }}</h3>
                    <span>{{ a.symbol.replace('-', ' / ') }} · поколение {{ a.generation }}</span>
                  </div>
                  <span v-if="a.status === 'archived'" class="archive-label">Архив</span>
                </div>
                <p class="strategy-label">{{ strategyName[a.kind] }}</p>
                <div
                  class="agent-result"
                  :class="Number(a.pnl) >= 0 ? 'is-positive' : 'is-negative'"
                >
                  {{ Number(a.pnl) >= 0 ? '+' : '' }}{{ usdt(a.pnl, 4) }} <small>USDT</small>
                </div>
                <dl class="agent-metrics">
                  <div>
                    <dt>Закрытые позиции</dt>
                    <dd>{{ a.roundTrips }} / {{ v.limits.evaluationTrips }}</dd>
                  </div>
                  <div>
                    <dt>Максимальная просадка</dt>
                    <dd>{{ pct(a.drawdownBps) }}</dd>
                  </div>
                  <div>
                    <dt>Валюта в позиции</dt>
                    <dd>{{ a.base }} {{ a.symbol.split('-')[0] }}</dd>
                  </div>
                </dl>
                <p class="agent-signal">
                  <i />{{ a.status === 'archived' ? 'История сохранена' : tradingReason(a.signal) }}
                </p>
                <details>
                  <summary>Гипотеза и происхождение</summary>
                  <p>
                    Окно {{ a.params.lookback }} минут, отклонение входа
                    {{ pct(a.params.entryBps) }}, цель {{ pct(a.params.takeProfitBps) }} после
                    комиссии.
                  </p>
                  <p>
                    Наблюдаем с {{ shortTime(a.createdAt) }}.
                    {{
                      a.eligible
                        ? 'Прошёл минимальные условия допуска.'
                        : 'Доказательств для допуска пока недостаточно.'
                    }}
                  </p>
                  <p v-if="a.parentId" class="record-id">Родитель: {{ a.parentId }}</p>
                </details>
              </article>
            </div>
            <div v-if="!shownAgents.length" class="empty-copy">
              <h3>Команда появится при запуске</h3>
              <p>
                На бумаге работают четыре агента, на бирже один. У каждого своя история и выделенный
                капитал.
              </p>
              <button class="t-button" @click="section = 'overview'">К запуску портфеля</button>
            </div>
          </section>

          <template v-if="section === 'orders'">
            <section class="t-panel">
              <div class="panel-heading">
                <div>
                  <h2>Последние 50 ордеров</h2>
                  <p class="t-muted">
                    Один ордер может исполниться несколькими сделками. Отмена может содержать
                    частичное исполнение.
                  </p>
                </div>
                <button class="t-button" :disabled="!v.orders.length" @click="exportOrders">
                  <OfficeIcon name="download" />CSV
                </button>
              </div>
              <div
                v-if="v.orders.length"
                class="orders-scroll"
                tabindex="0"
                aria-label="История ордеров с горизонтальной прокруткой"
              >
                <table class="orders-table">
                  <thead>
                    <tr>
                      <th>Время / агент</th>
                      <th>Пара / действие</th>
                      <th>Исполнено</th>
                      <th>Объём, USDT</th>
                      <th>Состояние</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="o in v.orders" :key="o.id">
                      <td>
                        <strong>{{ shortTime(o.createdAt) }}</strong
                        ><small>{{ o.agentName }}</small>
                      </td>
                      <td>
                        <strong>{{ o.symbol }}</strong
                        ><small :class="o.side === 'buy' ? 'is-positive' : 'is-negative'">{{
                          o.side === 'buy' ? 'Покупка' : 'Продажа'
                        }}</small>
                      </td>
                      <td class="mono">
                        {{ o.filledQty }}<small>из {{ o.qty }}</small>
                      </td>
                      <td class="mono">{{ usdt(o.quote, 4) }}</td>
                      <td>
                        <strong>{{ orderStatus[o.status] }}</strong>
                        <details>
                          <summary>Детали</summary>
                          <p>{{ tradingReason(o.reason) }}</p>
                          <p class="record-id">ID: {{ o.clientId }}</p>
                          <p>
                            Цена не хуже {{ o.price }} USDT. Комиссия: {{ o.feeBase }}
                            {{ o.symbol.split('-')[0] }}, {{ o.feeQuote }} USDT. Минус означает
                            списание.
                          </p>
                        </details>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div v-else class="empty-copy">
                <h3>Ордеров пока нет</h3>
                <p>
                  {{
                    v.status === 'running'
                      ? 'Агенты ждут подходящих условий. Отсутствие сделок при отсутствии сигнала нормально.'
                      : 'Запустите портфель, чтобы начать наблюдение и торговлю.'
                  }}
                </p>
              </div>
              <div v-if="v.unresolvedClientId" class="review-box">
                <h3>Нужна проверка ордера</h3>
                <p>
                  Проверьте историю {{ venue.name }} по ID <code>{{ v.unresolvedClientId }}</code
                  >. Приложение продолжает искать исполнение. Подтверждайте отсутствие только после
                  проверки на бирже.
                </p>
                <button
                  class="t-button"
                  :disabled="!!busy || v.status !== 'stopped'"
                  @click="ask('resolve')"
                >
                  Подтвердить отсутствие на бирже
                </button>
              </div>
            </section>
            <section class="t-panel journal-panel">
              <div class="panel-heading">
                <h2>Журнал решений</h2>
                <span class="t-muted">Последние 40 событий</span>
              </div>
              <ol v-if="v.events.length" class="event-list">
                <li v-for="e in v.events" :key="e.id">
                  <time>{{ shortTime(e.at) }}</time
                  ><span>{{ tradingReason(e.reason) }}</span>
                </li>
              </ol>
              <p v-else class="empty-copy">
                Здесь появятся запуски, исполнения, остановки и смена поколений.
              </p>
            </section>
          </template>

          <div v-if="section === 'connection'" class="connection-grid">
            <section v-if="overview" class="t-panel funding-panel">
              <div class="panel-heading">
                <h2>Распределение реального бюджета</h2>
                <span class="t-muted">До 100 USDT на все биржи</span>
              </div>
              <p class="fine-print">
                Укажите 0 для отключённой биржи или от 20 USDT для торговли. После первого реального
                запуска её бюджет фиксируется вместе с историей риска.
              </p>
              <form @submit.prevent="saveAllocation">
                <div class="funding-fields">
                  <label v-for="c in overview.connections" :key="c.exchange"
                    >{{ exchangeCatalog[c.exchange].name
                    }}<span
                      ><input
                        v-model.number="amounts[c.exchange]"
                        type="number"
                        min="0"
                        max="100"
                        step="1"
                        required
                        :disabled="!c.allocationEditable || !!busy"
                        @input="allocationDirty = true"
                      />
                      USDT</span
                    ><small v-if="!c.allocationEditable">Бюджет зафиксирован</small></label
                  >
                </div>
                <div class="funding-actions">
                  <span :class="{ 'is-negative': !allocationValid }"
                    >Распределено {{ allocationTotal }} / 100 USDT</span
                  ><button
                    class="t-button"
                    :disabled="
                      !allocationDirty || !allocationValid || !!busy || overviewStatus.offline
                    "
                  >
                    Сохранить распределение
                  </button>
                </div>
              </form>
              <p class="fine-print">
                Сохранение бюджета не запускает торговлю и не переводит деньги. Лимиты убытка и
                просадки действуют отдельно для каждого портфеля.
              </p>
            </section>
            <section class="t-panel">
              <div class="panel-heading">
                <h2>Готовность: {{ currentMode.label }}</h2>
                <OfficeIcon name="settings" />
              </div>
              <ul class="readiness-list">
                <li v-for="item in checklist" :key="item.label">
                  <span class="readiness-icon" :class="{ ready: item.ok }"
                    ><OfficeIcon :name="item.ok ? 'check' : 'pause'"
                  /></span>
                  <div>
                    <strong>{{ item.label }}</strong>
                    <p>{{ item.detail }}</p>
                  </div>
                  <span>{{ item.ok ? 'Готово' : 'Нужно' }}</span>
                </li>
              </ul>
              <div class="connection-actions">
                <button
                  class="t-button t-primary"
                  :disabled="!!busy || !v.readiness.keys"
                  @click="act('check')"
                >
                  {{ busy === 'check' ? 'Проверяем…' : 'Проверить подключение' }}</button
                ><button
                  v-if="mode === 'demo'"
                  class="t-button"
                  :disabled="!!busy || !v.readiness.keys || v.status === 'running'"
                  @click="act('demo_probe')"
                >
                  Проверочный демо-цикл
                </button>
              </div>
              <p v-if="mode === 'demo'" class="fine-print">
                Цикл покупает и продаёт до 10 тестовых USDT, сверяет баланс и останавливается.
                Реальные средства не используются.
              </p>
              <button
                v-if="mode === 'live' && startReady"
                class="t-button t-primary live-start"
                @click="ask('start')"
              >
                Перейти к запуску
              </button>
            </section>
            <section class="t-panel setup-guide">
              <h2>
                {{ mode === 'paper' ? 'Как начать без аккаунта' : `Подключение ${venue.name}` }}
              </h2>
              <template v-if="mode === 'paper'"
                ><p>
                  Откройте «Обзор» и запустите портфель. Нужны работающий обработчик и доступ к
                  публичному API {{ venue.name }}.
                </p>
                <p>
                  Четыре агента получат по 25 виртуальных USDT. Они будут принимать решения по
                  реальным ценам и сохранять результат после комиссий.
                </p>
                <p>
                  Переход к реальным средствам отдельный: сначала демо-счёт и накопленные результаты
                  бумаги.
                </p>
                <button class="text-button" @click="section = 'overview'">
                  К бумажному портфелю
                </button></template
              ><template v-else
                ><ol>
                  <li>
                    Создайте отдельный аккаунт или субаккаунт {{ venue.name }} для приложения.
                    {{ venue.account }}. Не торгуйте на нём вручную.
                  </li>
                  <li>
                    Создайте
                    {{ mode === 'demo' ? `ключ ${venue.demoName}` : 'реальный API-ключ' }} с чтением
                    и торговлей, без вывода. Для реального ключа укажите IP сервера.
                  </li>
                  <li>
                    На торговом счёте нужны {{ v.metrics.capital }}
                    {{ mode === 'demo' ? 'тестовых ' : '' }}USDT. Перед первым запуском BTC и ETH
                    должны быть равны нулю.
                  </li>
                  <li>
                    Запишите ключи в окружение сервера и пересоздайте web и worker. Секреты вводятся
                    на сервере.
                  </li>
                </ol>
                <pre class="env-example"><code>{{envExample}}</code></pre>
                <p>
                  Хост API должен соответствовать региону регистрации. Подробная инструкция
                  находится в <code>docs/21-trading.md</code> проекта.
                </p>
                <a
                  class="text-button"
                  :href="
                    mode === 'demo' && exchange === 'binance'
                      ? 'https://testnet.binance.vision/'
                      : venue.apiUrl
                  "
                  target="_blank"
                  rel="noopener noreferrer"
                  >Открыть API {{ venue.name }} <OfficeIcon name="external" /></a
              ></template>
            </section>
          </div>
          <footer class="trading-footer">
            <span>Спот, без плеча. Результат стратегии может быть отрицательным.</span
            ><span>Комиссии включены. Инфраструктура и налоги отдельно.</span>
          </footer>
        </template>
      </main>
    </div>
    <dialog ref="confirmDialog" class="trade-dialog" @close="confirmation = ''">
      <form @submit.prevent="act(confirmAction)">
        <h2>
          {{
            confirmAction === 'start'
              ? 'Запуск реальной торговли'
              : confirmAction === 'flatten'
                ? 'Закрыть открытые позиции?'
                : 'Ордер точно отсутствует?'
          }}
        </h2>
        <p>
          {{
            confirmAction === 'start'
              ? `Разрешаете приложению торговать в пределах ${v?.metrics.capital} USDT на счёте ${venue.name}. Прибыль не гарантирована. Лимиты ограничивают действия, но не исключают потерю капитала.`
              : confirmAction === 'flatten'
                ? 'Покупки прекратятся. Обработчик начнёт продавать имеющиеся активы по ограниченной цене. Полное исполнение зависит от рынка; маленькие остатки могут сохраниться.'
                : 'Подтвердите, что самостоятельно проверили историю ордеров и сделок на бирже. Сервер дополнительно проверит отсутствие ордера и совпадение баланса. История заявки сохранится.'
          }}
        </p>
        <label v-if="confirmPhrase" class="confirm-field"
          >Введите «{{ confirmPhrase }}»<input
            v-model="confirmation"
            autocomplete="off"
            spellcheck="false"
            :placeholder="confirmPhrase"
        /></label>
        <p v-if="error" class="trading-notice is-error" role="alert">{{ error }}</p>
        <div class="dialog-actions">
          <button class="t-button" type="button" @click="dialog?.close()">Отмена</button
          ><button
            class="t-button t-primary"
            :disabled="!!busy || (!!confirmPhrase && confirmation !== confirmPhrase)"
          >
            {{ busy ? 'Проверяем…' : 'Подтвердить' }}
          </button>
        </div>
      </form>
    </dialog>
  </div>
</template>
<style scoped src="../../assets/trading.css"></style>
