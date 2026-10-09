<script setup lang="ts">
import type { BudgetCategory } from '../../../core/contracts/office'
import { useOfficeMoney } from '~/composables/office/data'
import { percent, rub, withCount } from '~/composables/office/format'
import { budgetCategories } from '~/composables/office/labels'

useHead({ title: 'Деньги' })
const { data: m, status, pending, refresh } = useOfficeMoney()
const dayShare = computed(() =>
  m.value ? percent(m.value.daySpentKopecks, m.value.limits.dailyKopecks) : 0,
)
const monthShare = computed(() =>
  m.value ? percent(m.value.monthSpentKopecks, m.value.limits.monthlyKopecks) : 0,
)
const barTone = (share: number) => (share >= 90 ? 'is-err' : share >= 70 ? 'is-wait' : '')
const categories = computed(() => {
  if (!m.value) return []
  const entries = (Object.keys(budgetCategories) as BudgetCategory[]).map((key) => ({
    key,
    label: budgetCategories[key],
    value: m.value!.byCategory[key] || 0,
  }))
  const max = Math.max(1, ...entries.map((e) => e.value))
  return entries
    .sort((a, b) => b.value - a.value)
    .map((e) => ({ ...e, width: `${percent(e.value, max)}%` }))
})
const usd = (micro: number) =>
  `$${(micro / 1000000).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
</script>
<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Деньги</h1>
        <p>Расходы на модели и поиск. Тестовые платежи в выручку не попадают.</p>
      </div>
      <NuxtLink class="btn btn-ghost" to="/office/settings#limits">Где меняются лимиты</NuxtLink>
    </div>

    <OfficeState v-if="!m" :status="status" :pending="pending" @retry="refresh" />
    <template v-else>
      <section class="money-grid" aria-label="Главные цифры">
        <div class="stat rise">
          <span class="stat-label">Расходы сегодня</span
          ><span class="num">{{ rub(m.daySpentKopecks) }}</span>
          <div class="bar" :class="barTone(dayShare)"><i :style="{ width: `${dayShare}%` }" /></div>
          <span class="stat-note">из {{ rub(m.limits.dailyKopecks) }} в день</span>
        </div>
        <div class="stat rise">
          <span class="stat-label">Расходы за месяц</span
          ><span class="num">{{ rub(m.monthSpentKopecks) }}</span>
          <div class="bar" :class="barTone(monthShare)">
            <i :style="{ width: `${monthShare}%` }" />
          </div>
          <span class="stat-note">из {{ rub(m.limits.monthlyKopecks) }} в месяц</span>
        </div>
        <div class="stat rise is-money">
          <span class="stat-label">Реальная выручка</span
          ><span class="num">{{ rub(m.realRevenueKopecks) }}</span
          ><span class="stat-note">{{
            m.realRevenueKopecks ? 'только настоящие оплаты' : 'её даст первый настоящий клиент'
          }}</span>
        </div>
        <div class="stat rise test">
          <span class="stat-label">Тестовые платежи</span
          ><span class="num">{{ rub(m.testPayments.kopecks) }}</span
          ><span class="stat-note test-note"
            ><span class="badge badge-off">Не выручка</span
            ><span>{{
              withCount(m.testPayments.count, ['платёж', 'платежа', 'платежей'])
            }}</span></span
          >
        </div>
      </section>

      <div class="duo">
        <section class="card rise" aria-labelledby="cats">
          <div class="card-head">
            <h2 id="cats">На что ушло за месяц</h2>
            <span class="muted small">{{ rub(m.monthSpentKopecks) }}</span>
          </div>
          <ul class="cats">
            <li v-for="c in categories" :key="c.key">
              <div class="row between">
                <span>{{ c.label }}</span>
                <span class="num">{{ rub(c.value) }}</span>
              </div>
              <div class="bar"><i :style="{ width: c.width }" /></div>
            </li>
          </ul>
        </section>
        <section class="card rise" aria-labelledby="rules">
          <h2 id="rules">Отложено под задачи: {{ rub(m.outstandingKopecks) }}</h2>
          <dl v-if="m.openai" class="lines">
            <div>
              <dt>Платная модель</dt>
              <dd class="num">
                {{ usd(m.openai.spentMicrousd) }} из {{ usd(m.openai.limitMicrousd) }}
              </dd>
            </div>
          </dl>
          <p class="small muted">Деньги откладываются при старте задачи и списываются по факту.</p>
        </section>
      </div>
    </template>
  </div>
</template>
<style scoped>
.money-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--s-4);
  margin-bottom: var(--s-5);
}
.money-grid .bar {
  margin-top: var(--s-2);
}
.stat.test {
  background: var(--surface-2);
}
.test-note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}
.stat.test .num {
  color: var(--st-off-ink);
}
.duo {
  display: grid;
  grid-template-columns: 1.3fr 1fr;
  gap: var(--s-5);
  align-items: start;
}
.cats {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--s-4);
}
.cats li {
  display: grid;
  gap: 6px;
}
.cats .num {
  font-size: var(--text-md);
}
.lines {
  margin: var(--s-3) 0 var(--s-4);
  display: grid;
  gap: var(--s-3);
}
.lines div {
  display: flex;
  justify-content: space-between;
  gap: var(--s-3);
  padding-bottom: var(--s-3);
  border-bottom: 1px solid var(--line);
}
.lines dd {
  margin: 0;
}
@media (max-width: 1023px) {
  .money-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .duo {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 639px) {
  .money-grid {
    gap: 10px;
  }
}
</style>
