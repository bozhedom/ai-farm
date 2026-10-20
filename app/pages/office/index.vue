<script setup lang="ts">
import type {
  IncomeExchange,
  IncomeMode,
  IncomePeriod,
  IncomeTotals,
} from '../../../core/contracts/overview'
import { useOfficeIncome, useOfficeOverview } from '~/composables/office/data'
import { ago, count, rub, todayTitle, withCount } from '~/composables/office/format'
import {
  amountText,
  chartNumber,
  decimalText,
  exchangeColor,
  exchangeTitle,
  incomeMode,
  isNegative,
  isZeroDecimal,
  resultText,
  rubSigned,
  sourceStatus,
  walletAmountsText,
  walletKeyBadge,
} from '~/composables/office/income'
import { modeBadge } from '~/composables/office/labels'
import { strategyName } from '~/utils/trading'

useHead({ title: 'Как ферма зарабатывает' })
const { data: v, status, pending, refresh } = useOfficeIncome()
// The shell already polls the overview; reusing it keeps the stop button state in sync.
const { data: office } = useOfficeOverview()

const clock = ref(new Date())
let tick: ReturnType<typeof setInterval> | undefined
onMounted(() => (tick = setInterval(() => (clock.value = new Date()), 5000)))
onBeforeUnmount(() => tick && clearInterval(tick))

type PeriodKey = IncomePeriod | 'all'
const periods: { id: PeriodKey; label: string }[] = [
  { id: 'today', label: 'Сегодня' },
  { id: 'week', label: '7 дней' },
  { id: 'month', label: '30 дней' },
  { id: 'all', label: 'Всё время' },
]
const period = ref<PeriodKey>('month')
const t = computed<IncomeTotals | null>(() =>
  v.value ? (period.value === 'all' ? v.value.allTime : v.value.periods[period.value]) : null,
)
// Deposits to the Bybit account: own coin, never added to rubles. "all" is all time.
const w = computed(() => (v.value ? v.value.wallet.periods[period.value] : null))
const realExtra = computed(() => {
  const x = t.value
  if (!x) return []
  return [
    ...(isZeroDecimal(x.liveTradingUsdt)
      ? []
      : [`${decimalText(x.liveTradingUsdt, 2, true)} USDT на биржах`]),
    ...x.liveExecution.filter((a) => !isZeroDecimal(a.amount)).map((a) => amountText(a)),
  ]
})
const testLines = computed(() => {
  const x = t.value
  if (!x) return []
  return [
    { label: 'Тренировка', value: `${decimalText(x.paperTradingUsdt, 2, true)} USDT` },
    { label: 'Тест биржи', value: `${decimalText(x.demoTradingUsdt, 2, true)} USDT` },
    ...x.testExecution.map((a) => ({ label: 'Направления', value: amountText(a) })),
    { label: 'Тестовые оплаты', value: rub(x.testPaymentsKopecks) },
  ]
})

const updated = computed(() =>
  v.value ? ago(v.value.generatedAt, clock.value).replace(/^./, (c) => c.toUpperCase()) : '',
)
const working = computed(
  () => v.value?.sources.filter((s) => s.status === 'autonomous').length ?? 0,
)
const headline = computed(() => {
  const x = v.value
  if (!x) return ''
  if (x.mode === 'emergency_stop') return 'Ферма остановлена владельцем'
  if (!x.workerAlive) return 'Фоновый процесс не отвечает'
  if (x.mode === 'paused') return 'Ферма на паузе'
  return `Сами работают ${working.value} из ${x.sources.length} направлений`
})

// ---- trading analytics -----------------------------------------------------------------
const chartModes: { id: IncomeMode; label: string }[] = [
  { id: 'paper', label: 'Тренировка' },
  { id: 'demo', label: 'Тест биржи' },
  { id: 'live', label: 'Реальные' },
]
const chartMode = ref<IncomeMode | null>(null)
const modesWithData = computed(
  () => new Set((v.value?.equity ?? []).filter((s) => s.points.length).map((s) => s.mode)),
)
const activeChartMode = computed<IncomeMode>(
  () =>
    chartMode.value ??
    (modesWithData.value.has('live')
      ? 'live'
      : modesWithData.value.has('paper') || !modesWithData.value.has('demo')
        ? 'paper'
        : 'demo'),
)
const days = computed(() => v.value?.daily.map((d) => d.day) ?? [])
const equitySeries = computed(() =>
  (v.value?.equity ?? [])
    .filter((s) => s.mode === activeChartMode.value && s.points.length)
    .map((s) => {
      const first = chartNumber(s.points[0]!.equity)
      return {
        id: `${s.exchange}:${s.mode}`,
        label: exchangeTitle[s.exchange],
        color: exchangeColor[s.exchange],
        points: s.points.map((p) => ({
          x: p.day,
          y: Math.round((chartNumber(p.equity) - first) * 100) / 100,
        })),
      }
    }),
)
const tradingRows = computed(() =>
  (v.value?.trading ?? []).filter(
    (r) =>
      r.status !== 'idle' || r.trades30d > 0 || !isZeroDecimal(r.realized) || r.activeAgents > 0,
  ),
)
const tradeTotals = computed(() => {
  const rows = v.value?.trading ?? []
  const trades = rows.reduce((n, r) => n + r.trades30d, 0)
  const wins = rows.reduce((n, r) => n + r.wins30d, 0)
  return { trades, wins, rate: trades ? Math.round((wins / trades) * 100) : null }
})
const winRate = (wins: number, trades: number) =>
  trades ? `${Math.round((wins / trades) * 100)}%` : '—'
const tradingStatus: Record<string, string> = {
  idle: 'Не запущена',
  running: 'Работает',
  paused: 'Пауза',
  stopped: 'Остановлена',
}

// ---- money and spend -----------------------------------------------------------------------
const categoryName: Record<string, string> = {
  research: 'Сборка продуктов',
  order: 'Выполнение заказов',
  scout: 'Разведка идей',
  lead: 'Поиск клиентов',
  report: 'Отчёты руководителя',
  trading_manager: 'ИИ-менеджер торговли',
  computer_use: 'Компьютер ИИ',
}
const spendTotal = computed(() => v.value?.spendByCategory.reduce((n, c) => n + c.kopecks, 0) ?? 0)

// ---- funnel ---------------------------------------------------------------------------------
const funnel = computed(() => {
  const f = v.value?.funnel
  if (!f) return []
  const steps = [
    { label: 'Идей найдено', n: f.ideas },
    { label: 'Критик принял', n: f.accepted },
    { label: 'Стали продуктом', n: f.productized },
    { label: 'В продаже', n: f.publicProducts },
    { label: 'Заказов', n: f.orders },
    { label: 'Выдано', n: f.delivered },
    { label: 'Оплачено деньгами', n: f.paidReal },
  ]
  const top = Math.max(1, steps[0]!.n)
  return steps.map((s) => ({ ...s, width: s.n ? Math.max(3, Math.round((s.n / top) * 100)) : 0 }))
})

// ---- strategies ------------------------------------------------------------------------------
const strategyGroups = computed(() => {
  const groups = new Map<string, { exchange: IncomeExchange; mode: IncomeMode; kinds: string[] }>()
  for (const s of v.value?.strategies ?? []) {
    const key = `${s.exchange}:${s.mode}`
    if (!groups.has(key)) groups.set(key, { exchange: s.exchange, mode: s.mode, kinds: [] })
    const name = strategyName[s.kind as keyof typeof strategyName] ?? s.kind
    groups.get(key)!.kinds.push(s.count > 1 ? `${name} ×${s.count}` : name)
  }
  return [...groups.values()]
})
const priceText = (kopecks: number) => rub(kopecks)
</script>
<template>
  <div class="income">
    <div class="page-head">
      <div>
        <h1>Как ферма зарабатывает</h1>
        <p>
          <ClientOnly>{{ todayTitle(clock) }}.</ClientOnly>
          <span v-if="v" class="live updated"><i class="live-dot" />{{ updated }}</span>
        </p>
      </div>
      <div class="row head-actions">
        <OfficeModeControls :mode="office?.mode ?? v?.mode" />
      </div>
    </div>

    <OfficeState v-if="!v" :status="status" :pending="pending" :rows="5" @retry="refresh" />
    <template v-else>
      <!-- Headline and period -->
      <section class="summary rise" aria-label="Итог">
        <div class="summary-line">
          <OfficeBadge :badge="modeBadge[v.mode]" />
          <strong>{{ headline }}</strong>
          <span class="muted small">Реальные деньги и тесты считаются раздельно.</span>
        </div>
        <div class="chips period" role="group" aria-label="Период">
          <button
            v-for="p in periods"
            :key="p.id"
            type="button"
            class="chip"
            :class="{ 'is-active': period === p.id }"
            :aria-pressed="period === p.id"
            @click="period = p.id"
          >
            {{ p.label }}
          </button>
        </div>
      </section>

      <section v-if="t" class="stat-grid kpis" aria-label="Деньги за период">
        <div class="stat is-money rise">
          <span class="stat-label">Реальный доход</span>
          <span class="num">{{ rub(t.realOrdersKopecks) }}</span>
          <span v-for="line in realExtra" :key="line" class="kpi-extra">{{ line }}</span>
          <span class="stat-note">{{
            t.realOrdersKopecks || realExtra.length
              ? 'оплаченные заказы и реальная торговля'
              : 'настоящих денег пока нет: торговля не в Live, оплаты тестовые'
          }}</span>
        </div>
        <div class="stat rise">
          <span class="stat-label">Расходы на модели</span>
          <span class="num">{{ rub(t.spendKopecks) }}</span>
          <span class="stat-note">OpenRouter, Astra, поиск: по журналу вызовов</span>
        </div>
        <div class="stat rise" :class="{ 'is-loss': t.netKopecks < 0 }">
          <span class="stat-label">Итог в рублях</span>
          <span class="num">{{ rubSigned(t.netKopecks) }}</span>
          <span class="stat-note">доход минус расходы; USDT не пересчитываем в рубли</span>
        </div>
        <div class="stat is-test rise">
          <span class="stat-label"
            >Тренировка и тесты <span class="badge badge-test">Не выручка</span></span
          >
          <dl class="test-lines">
            <div v-for="line in testLines" :key="line.label + line.value">
              <dt>{{ line.label }}</dt>
              <dd>{{ line.value }}</dd>
            </div>
          </dl>
        </div>
      </section>

      <!-- Bybit wallet deposits -->
      <section v-if="w" class="card rise wallet" aria-labelledby="wallet-title">
        <div class="card-head wrap">
          <div>
            <h2 id="wallet-title">Поступления на кошелёк</h2>
            <p class="small muted">
              Оплата криптой на Bybit, только от зарубежных клиентов. В рубли не пересчитываем.
            </p>
          </div>
          <span class="row wallet-head">
            <OfficeBadge :badge="walletKeyBadge[v.wallet.keyStatus]" />
            <NuxtLink class="btn btn-ghost btn-sm" to="/office/money#wallet">Адрес и ключ</NuxtLink>
          </span>
        </div>
        <dl class="wallet-totals">
          <div class="is-income">
            <dt>Доход</dt>
            <dd class="mono">{{ walletAmountsText(w.income) }}</dd>
            <small>только отмеченное «доход»</small>
          </div>
          <div class="is-open">
            <dt>Не разобрано</dt>
            <dd class="mono">{{ walletAmountsText(w.unclassified) }}</dd>
            <small>ждёт вашей отметки, в доход не входит</small>
          </div>
          <div>
            <dt>Не доход</dt>
            <dd class="mono">{{ walletAmountsText(w.notIncome) }}</dd>
            <small>переводы себе со своих счетов</small>
          </div>
        </dl>
        <p class="small muted wallet-hint">
          Перевод со своей биржи или кошелька тоже приходит как поступление. Отметьте его «не
          доход», чтобы он не попал в выручку.
        </p>
        <OfficeWalletDeposits :deposits="v.wallet.recent" :limit="5" />
      </section>

      <div class="grid-main">
        <!-- Sources -->
        <section class="card rise" aria-labelledby="sources-title">
          <div class="card-head">
            <h2 id="sources-title">Источники заработка</h2>
            <NuxtLink class="btn btn-ghost btn-sm" to="/office/earnings">Все направления</NuxtLink>
          </div>
          <ul class="sources">
            <li v-for="s in v.sources" :key="s.id" :class="`is-${s.status}`">
              <NuxtLink :to="s.link" class="source">
                <span class="source-main">
                  <span class="source-title">{{ s.title }}</span>
                  <span class="source-detail">{{ s.detail }}</span>
                </span>
                <span class="source-badges">
                  <OfficeBadge :badge="sourceStatus[s.status]" />
                  <OfficeBadge v-if="s.mode" :badge="incomeMode[s.mode]" :dot="false" />
                </span>
                <span class="source-result">
                  <b
                    :class="{
                      'is-neg': s.result && isNegative(s.result.value),
                      'is-test': s.result?.test,
                    }"
                    >{{ resultText(s.result) }}</b
                  >
                  <small v-if="s.result">{{ s.result.label }}</small>
                  <small v-if="s.lastAt" class="source-when">{{ ago(s.lastAt, clock) }}</small>
                </span>
              </NuxtLink>
            </li>
          </ul>
        </section>

        <!-- Live feed -->
        <section class="card rise feed-card" aria-labelledby="feed-title">
          <div class="card-head">
            <h2 id="feed-title">Что сейчас делают агенты</h2>
            <span class="live small on-air"><i class="live-dot" />в эфире</span>
          </div>
          <OfficeFeed v-if="v.feed.length" :items="v.feed" :limit="14" />
          <p v-else class="muted">Пока тихо. События появятся, как только агенты начнут работу.</p>
          <div class="card-foot">
            <span class="small muted">Обновляется каждые 10 секунд</span>
            <NuxtLink class="small" to="/office/farm">Ферма идей</NuxtLink>
          </div>
        </section>
      </div>

      <!-- Needs a person -->
      <section
        v-if="v.needsHuman.length"
        class="card card-tint-sun rise needs"
        aria-labelledby="needs-title"
      >
        <div class="card-head">
          <h2 id="needs-title">Нужен человек</h2>
          <span class="small">{{
            withCount(v.needsHuman.length, ['пункт', 'пункта', 'пунктов'])
          }}</span>
        </div>
        <ul class="needs-list">
          <li v-for="n in v.needsHuman" :key="n.id" :class="`is-${n.severity}`">
            <NuxtLink :to="n.link">
              <strong>{{ n.title }}</strong>
              <span>{{ n.detail }}</span>
            </NuxtLink>
          </li>
        </ul>
      </section>

      <!-- Trading analytics -->
      <section class="card rise" aria-labelledby="trading-title">
        <div class="card-head wrap">
          <div>
            <h2 id="trading-title">Торговля по биржам</h2>
            <p class="small muted">
              Изменение капитала за 30 дней, USDT.
              <template v-if="tradeTotals.trades"
                >Сделок {{ count(tradeTotals.trades) }}, в плюс {{ tradeTotals.rate }}%.</template
              >
            </p>
          </div>
          <div class="chips" role="group" aria-label="Режим торговли">
            <button
              v-for="m in chartModes"
              :key="m.id"
              type="button"
              class="chip"
              :class="{ 'is-active': activeChartMode === m.id }"
              :aria-pressed="activeChartMode === m.id"
              @click="chartMode = m.id"
            >
              {{ m.label }}<span v-if="!modesWithData.has(m.id)" class="n">нет данных</span>
            </button>
          </div>
        </div>
        <OfficeLineChart
          v-if="equitySeries.length"
          :series="equitySeries"
          :xs="days"
          unit="USDT"
          :format="(n: number) => decimalText(String(n), 2, true)"
        />
        <p v-else class="empty-chart muted">
          В режиме «{{ chartModes.find((m) => m.id === activeChartMode)?.label }}» за 30 дней нет
          отметок капитала.
        </p>
        <div v-if="tradingRows.length" class="trade-rows" role="table" aria-label="Биржи и режимы">
          <div class="trade-row trade-head" role="row">
            <span role="columnheader">Биржа</span><span role="columnheader">Статус</span
            ><span role="columnheader">Капитал</span><span role="columnheader">Результат</span
            ><span role="columnheader">Зафиксировано</span
            ><span role="columnheader">Сделок, в плюс</span>
          </div>
          <div
            v-for="r in tradingRows"
            :key="`${r.exchange}:${r.mode}`"
            class="trade-row"
            role="row"
          >
            <span role="cell" class="trade-name"
              ><i :style="{ background: exchangeColor[r.exchange] }" />{{
                exchangeTitle[r.exchange]
              }}
              <OfficeBadge :badge="incomeMode[r.mode]" :dot="false"
            /></span>
            <span role="cell" data-label="Статус">{{ tradingStatus[r.status] }}</span>
            <span role="cell" data-label="Капитал" class="mono">{{ decimalText(r.equity) }}</span>
            <span
              role="cell"
              data-label="Результат"
              class="mono"
              :class="{ 'is-neg': isNegative(r.pnl) }"
              >{{ decimalText(r.pnl, 2, true) }}</span
            >
            <span
              role="cell"
              data-label="Зафиксировано"
              class="mono"
              :class="{ 'is-neg': isNegative(r.realized) }"
              >{{ decimalText(r.realized, 2, true) }}</span
            >
            <span role="cell" data-label="Сделок, в плюс" class="mono"
              >{{ r.trades30d }} · {{ winRate(r.wins30d, r.trades30d) }}</span
            >
          </div>
        </div>
        <p v-else class="small muted">Ни одна биржа ещё не запускалась.</p>
      </section>

      <div class="grid-two">
        <section class="card rise" aria-labelledby="money-title">
          <div class="card-head">
            <h2 id="money-title">Доход и расходы по дням</h2>
            <NuxtLink class="btn btn-ghost btn-sm" to="/office/money">Деньги</NuxtLink>
          </div>
          <OfficeDayBars :days="v.daily" />
          <ul v-if="v.spendByCategory.length" class="spend">
            <li v-for="c in v.spendByCategory" :key="c.category">
              <span>{{ categoryName[c.category] ?? c.category }}</span>
              <span class="spend-bar"
                ><i
                  :style="{
                    width: `${spendTotal ? Math.max(2, Math.round((c.kopecks / spendTotal) * 100)) : 0}%`,
                  }"
              /></span>
              <b>{{ rub(c.kopecks) }}</b>
            </li>
          </ul>
          <p v-else class="small muted spend-empty">За 30 дней платных вызовов не было.</p>
        </section>

        <section class="card rise" aria-labelledby="agents-title">
          <div class="card-head">
            <h2 id="agents-title">Лучшие и худшие агенты</h2>
            <NuxtLink class="btn btn-ghost btn-sm" to="/office/trading">Торговля</NuxtLink>
          </div>
          <template v-if="v.agents.best.length || v.agents.worst.length">
            <h3 v-if="v.agents.best.length" class="eyebrow">В плюсе</h3>
            <ol v-if="v.agents.best.length" class="ranks">
              <li v-for="a in v.agents.best" :key="a.id">
                <span class="rank-name"
                  >{{ a.name }}
                  <small
                    >{{ exchangeTitle[a.exchange] }} · {{ incomeMode[a.mode].label }} ·
                    {{ strategyName[a.kind as keyof typeof strategyName] ?? a.kind }} ·
                    {{ a.symbol.replace('-USDT', '') }}</small
                  ></span
                >
                <b class="mono" :class="{ 'is-neg': isNegative(a.realized) }"
                  >{{ decimalText(a.realized, 2, true) }} USDT</b
                >
              </li>
            </ol>
            <template v-if="v.agents.worst.length">
              <h3 class="eyebrow">В минусе</h3>
              <ol class="ranks">
                <li v-for="a in v.agents.worst" :key="a.id">
                  <span class="rank-name"
                    >{{ a.name }}
                    <small
                      >{{ exchangeTitle[a.exchange] }} · {{ incomeMode[a.mode].label }} ·
                      {{ strategyName[a.kind as keyof typeof strategyName] ?? a.kind }}</small
                    ></span
                  >
                  <b class="mono is-neg">{{ decimalText(a.realized, 2, true) }} USDT</b>
                </li>
              </ol>
            </template>
          </template>
          <p v-else class="muted small">Ещё ни один агент не закрыл сделку.</p>
        </section>
      </div>

      <div class="grid-two">
        <section class="card rise" aria-labelledby="funnel-title">
          <div class="card-head">
            <h2 id="funnel-title">Путь идеи до денег</h2>
            <NuxtLink class="btn btn-ghost btn-sm" to="/office/ideas">Идеи</NuxtLink>
          </div>
          <ol class="funnel">
            <li v-for="step in funnel" :key="step.label">
              <span>{{ step.label }}</span>
              <span class="funnel-bar"><i :style="{ width: `${step.width}%` }" /></span>
              <b class="mono">{{ count(step.n) }}</b>
            </li>
          </ol>
        </section>

        <section class="card rise" aria-labelledby="products-title">
          <div class="card-head">
            <h2 id="products-title">Продукты и цены</h2>
            <NuxtLink class="btn btn-ghost btn-sm" to="/office/products">Все продукты</NuxtLink>
          </div>
          <ul v-if="v.products.length" class="products">
            <li v-for="p in v.products" :key="p.id">
              <span class="product-name">{{ p.name }}</span>
              <span class="small muted">заказов {{ p.orders }}, выдано {{ p.delivered }}</span>
              <b class="mono">{{ priceText(p.priceKopecks) }}</b>
            </li>
          </ul>
          <p v-else class="small muted">На сайте пока нет услуг.</p>
          <p class="small muted prices">
            Цены витрины: {{ v.priceList.map(priceText).join(' · ') }}. Оплата тестовая, пока не
            подключён настоящий приём платежей.
          </p>
          <h3 class="eyebrow">Стратегии в работе</h3>
          <ul v-if="strategyGroups.length" class="strategies">
            <li v-for="g in strategyGroups" :key="`${g.exchange}:${g.mode}`">
              <b>{{ exchangeTitle[g.exchange] }}</b>
              <OfficeBadge :badge="incomeMode[g.mode]" :dot="false" />
              <span>{{ g.kinds.join(', ') }}</span>
            </li>
          </ul>
          <p v-else class="small muted">Торговые стратегии не запущены.</p>
        </section>
      </div>
    </template>
  </div>
</template>
<style scoped>
.head-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}
.updated {
  margin-left: 6px;
  font-size: var(--text-sm);
}
.summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3) var(--s-5);
  margin-bottom: var(--s-4);
}
.summary-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.summary-line strong {
  font: 700 var(--text-lg) / 1.25 var(--font-display);
}
.kpis {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}
.kpis .num {
  overflow-wrap: anywhere;
}
.kpi-extra {
  font: 600 var(--text-sm) / 1.3 var(--font-mono);
  color: var(--brand-ink);
}
.stat.is-loss .num {
  color: var(--st-err-ink);
}
.stat .stat-label .badge {
  margin-left: 4px;
  vertical-align: 1px;
}
.test-lines {
  margin: 4px 0 0;
  display: grid;
  gap: 4px;
}
.test-lines div {
  display: flex;
  justify-content: space-between;
  gap: var(--s-3);
  font-size: var(--text-sm);
}
.test-lines dt {
  color: var(--muted);
}
.test-lines dd {
  margin: 0;
  font: 600 var(--text-sm) / 1.3 var(--font-mono);
  color: var(--st-test-ink);
  text-align: right;
}
.wallet-head {
  gap: 8px;
  flex-wrap: wrap;
}
.wallet-totals {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--s-3);
  margin: var(--s-3) 0;
}
.wallet-totals div {
  display: grid;
  gap: 2px;
  padding: var(--s-3);
  border-radius: var(--r-md);
  background: var(--surface-2);
}
.wallet-totals .is-income {
  background: var(--sun-soft);
}
.wallet-totals .is-open {
  background: var(--st-human-soft);
}
.wallet-totals dt {
  font-size: var(--text-sm);
  color: var(--muted);
}
.wallet-totals dd {
  margin: 0;
  font-weight: 700;
  font-size: var(--text-md);
  overflow-wrap: anywhere;
}
.wallet-totals small {
  color: var(--muted);
}
.wallet-hint {
  margin: 0 0 var(--s-2);
}
.grid-main {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr);
  gap: var(--s-5);
  margin-top: var(--s-5);
  align-items: start;
}
.grid-two {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--s-5);
  margin-top: var(--s-5);
  align-items: start;
}
.income > .card,
.income > section.card {
  margin-top: var(--s-5);
}
.card-head.wrap {
  flex-wrap: wrap;
  align-items: flex-start;
}
.card-head p {
  margin: 4px 0 0;
}

/* Sources */
.sources {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
}
.sources li + li {
  border-top: 1px solid var(--line);
}
.source {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto 150px;
  gap: var(--s-3) var(--s-4);
  align-items: center;
  padding: 12px 4px;
  color: inherit;
  border-left: 3px solid transparent;
  padding-left: 10px;
}
.source:hover {
  text-decoration: none;
  background: var(--surface-2);
}
.is-autonomous .source {
  border-left-color: var(--st-ok);
}
.is-needs_human .source {
  border-left-color: var(--st-human);
}
.is-paper_only .source {
  border-left-color: var(--st-test);
}
.is-disabled .source {
  border-left-color: var(--line-strong);
}
.is-disabled .source-title {
  color: var(--ink-2);
}
.source-main {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.source-title {
  font-weight: 600;
}
.source-detail {
  font-size: var(--text-sm);
  color: var(--muted);
}
.source-badges {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}
.source-result {
  display: grid;
  justify-items: end;
  text-align: right;
  gap: 1px;
}
.source-result b {
  font: 700 var(--text-md) / 1.2 var(--font-mono);
  color: var(--brand-ink);
}
.source-result b.is-test {
  color: var(--st-test-ink);
}
.source-result small {
  font-size: var(--text-xs);
  color: var(--muted);
}
.is-neg,
.source-result b.is-neg {
  color: var(--st-err-ink);
}

/* Dark theme: the shared active chip keeps readable text. */
.chip.is-active {
  color: var(--surface);
}

/* Feed */
.on-air {
  white-space: nowrap;
}
.feed-card :deep(.feed) {
  max-height: 560px;
  overflow-y: auto;
}

/* Needs a person */
.needs {
  margin-top: var(--s-5);
}
.needs-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--s-3);
}
.needs-list a {
  display: grid;
  gap: 4px;
  height: 100%;
  padding: 12px 14px;
  border-radius: var(--r-md);
  background: var(--surface);
  color: inherit;
  border-left: 3px solid var(--st-wait);
}
.needs-list .is-block a {
  border-left-color: var(--st-err);
}
.needs-list a:hover {
  text-decoration: none;
  box-shadow: var(--shadow-md);
}
.needs-list span {
  font-size: var(--text-sm);
  color: var(--ink-2);
}

/* Trading */
.empty-chart {
  padding: var(--s-8) 0;
  text-align: center;
}
.trade-rows {
  margin-top: var(--s-5);
  display: grid;
  font-size: var(--text-sm);
}
.trade-row {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) 1fr 1fr 1fr 1fr 1fr;
  gap: var(--s-3);
  align-items: center;
  padding: 10px 4px;
  border-top: 1px solid var(--line);
}
.trade-head {
  border-top: 0;
  font: 600 var(--text-xs) / 1.2 var(--font-body);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}
.trade-row .mono {
  font-family: var(--font-mono);
}
.trade-name {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  font-weight: 600;
}
.trade-name i {
  width: 10px;
  height: 10px;
  border-radius: 3px;
}

/* Spend */
.spend,
.funnel,
.ranks,
.products,
.strategies {
  list-style: none;
  margin: 0;
  padding: 0;
}
.spend {
  margin-top: var(--s-5);
  display: grid;
  gap: 8px;
}
.spend li,
.funnel li {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) auto;
  gap: var(--s-3);
  align-items: center;
  font-size: var(--text-sm);
}
.spend-bar,
.funnel-bar {
  height: 8px;
  border-radius: var(--r-pill);
  background: var(--canvas-deep);
  overflow: hidden;
}
.spend-bar i,
.funnel-bar i {
  display: block;
  height: 100%;
  border-radius: inherit;
}
.spend-bar i {
  background: var(--clay);
}
.funnel-bar i {
  background: var(--brand);
}
.spend b,
.funnel b {
  font-family: var(--font-mono);
  min-width: 64px;
  text-align: right;
}
.spend-empty {
  margin-top: var(--s-4);
}
.funnel {
  display: grid;
  gap: 12px;
}
.funnel li:last-child .funnel-bar i {
  background: var(--sun);
}

/* Ranks */
.eyebrow {
  margin: var(--s-4) 0 var(--s-2);
}
.card-head + .eyebrow {
  margin-top: 0;
}
.ranks {
  display: grid;
}
.ranks li,
.products li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px var(--s-3);
  align-items: center;
  padding: 8px 0;
  border-top: 1px solid var(--line);
}
.ranks li:first-child,
.products li:first-child {
  border-top: 0;
}
.rank-name {
  display: grid;
  font-weight: 600;
}
.rank-name small {
  font-weight: 400;
  font-size: var(--text-xs);
  color: var(--muted);
}
.ranks b {
  color: var(--brand-ink);
}
.ranks b.is-neg {
  color: var(--st-err-ink);
}

/* Products */
.products li {
  grid-template-columns: minmax(0, 1fr) auto auto;
}
.product-name {
  font-weight: 600;
}
.prices {
  margin-top: var(--s-3);
}
.strategies {
  display: grid;
  gap: 8px;
}
.strategies li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  font-size: var(--text-sm);
}

@media (max-width: 1279px) {
  .kpis {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 1023px) {
  .grid-main,
  .grid-two {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 760px) {
  .wallet-totals {
    grid-template-columns: minmax(0, 1fr);
  }
  .source {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .source-badges {
    grid-column: 1 / -1;
    grid-row: 2;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
  }
  .source-result {
    grid-column: 2;
    grid-row: 1;
  }
  .trade-head {
    display: none;
  }
  .trade-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px var(--s-3);
  }
  .trade-name {
    grid-column: 1 / -1;
  }
  .trade-row [data-label]::before {
    content: attr(data-label) ': ';
    font-family: var(--font-body);
    color: var(--muted);
  }
  .products li {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .products li .small {
    grid-column: 1;
    grid-row: 2;
  }
}
@media (max-width: 639px) {
  .head-actions {
    justify-content: flex-start;
  }
  .kpis {
    grid-template-columns: minmax(0, 1fr);
  }
  .kpis .num {
    font-size: var(--text-2xl);
  }
  .spend li,
  .funnel li {
    grid-template-columns: minmax(0, 1fr) 70px auto;
  }
}
</style>
