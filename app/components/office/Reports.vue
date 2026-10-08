<script setup lang="ts">
import type { OfficeReport } from '../../../core/contracts/office'
import { useOfficeReports } from '~/composables/office/data'
import { count, day, rub, when } from '~/composables/office/format'
import { ideaStatus } from '~/composables/office/labels'

const { data, status, pending, refresh } = useOfficeReports()
const kind = ref<OfficeReport['kind']>('daily')
const list = computed(() =>
  (data.value || [])
    .filter((report) => report.kind === kind.value)
    .sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1)),
)
const selectedId = ref<string | null>(null)
const report = computed(
  () => list.value.find((r) => r.id === selectedId.value) || list.value[0] || null,
)
watch(kind, () => (selectedId.value = null))

const metricLabels: Record<string, string> = {
  ideas: 'Идей',
  accepted: 'Принято',
  rejected: 'Отклонено',
  products: 'Продуктов',
  orders: 'Заказов',
  leads: 'Клиентов',
  spentKopecks: 'Расходы',
}
const metrics = computed(() =>
  Object.entries(report.value?.metrics || {})
    .filter(([key]) => key in metricLabels)
    .map(([key, value]) => ({
      key,
      label: metricLabels[key]!,
      value: key.endsWith('Kopecks') ? rub(value) : count(value),
    })),
)
const period = (r: OfficeReport) =>
  r.kind === 'daily' ? `за ${day(r.periodStart)}` : `${day(r.periodStart)} - ${day(r.periodEnd)}`
const title = (r: OfficeReport) =>
  r.kind === 'daily'
    ? `Отчёт за ${day(r.periodStart)}`
    : `Отчёт за неделю, ${day(r.periodStart)} - ${day(r.periodEnd)}`
const commentFor = (ideaId: string) =>
  report.value?.narrative?.ideaComments.find((c) => c.ideaId === ideaId)?.comment
const statusLabel = (value: string) => ideaStatus[value as keyof typeof ideaStatus]?.label || value
</script>
<template>
  <div class="reports">
    <div class="toolbar">
      <div class="chips" aria-label="Период">
        <button
          type="button"
          class="chip"
          :class="{ 'is-active': kind === 'daily' }"
          @click="kind = 'daily'"
        >
          За день
        </button>
        <button
          type="button"
          class="chip"
          :class="{ 'is-active': kind === 'weekly' }"
          @click="kind = 'weekly'"
        >
          За неделю
        </button>
      </div>
      <select
        v-if="list.length > 1"
        v-model="selectedId"
        class="select"
        aria-label="Какой отчёт показать"
      >
        <option v-for="r in list" :key="r.id" :value="r.id">{{ period(r) }}</option>
      </select>
    </div>

    <OfficeState v-if="!data" :status="status" :pending="pending" @retry="refresh" />
    <OfficeEmpty
      v-else-if="!report"
      icon="report"
      :title="kind === 'daily' ? 'Дневного отчёта ещё нет' : 'Недельного отчёта ещё нет'"
      text="Руководитель пишет отчёт, когда разведчики закончат дневной поиск."
    />
    <article v-else class="card card-pad-lg report rise">
      <div class="report-head">
        <span class="avatar is-lead">Р</span>
        <div>
          <span class="small muted">{{ title(report) }}</span>
          <h2>{{ report.narrative?.headline || 'Цифры за период' }}</h2>
          <p v-if="report.narrative" class="summary-text">{{ report.narrative.summary }}</p>
          <p v-else class="muted">Руководитель не успел написать текст. Цифры ниже.</p>
        </div>
        <span v-if="report.isDemo" class="badge">Демо</span>
      </div>

      <dl v-if="metrics.length" class="metrics">
        <div v-for="m in metrics" :key="m.key">
          <dt>{{ m.label }}</dt>
          <dd class="num">{{ m.value }}</dd>
        </div>
      </dl>

      <div class="report-cols">
        <section v-if="report.ranking.length">
          <h3>Лучшие идеи</h3>
          <ol class="ranking">
            <li v-for="item in report.ranking" :key="item.ideaId">
              <span class="num">{{ item.rankScore }}</span>
              <div>
                <NuxtLink :to="`/office/ideas/${item.ideaId}`">{{ item.title }}</NuxtLink>
                <span class="badge badge-plain rank-status">{{ statusLabel(item.status) }}</span>
                <p v-if="commentFor(item.ideaId)" class="small">{{ commentFor(item.ideaId) }}</p>
              </div>
            </li>
          </ol>
        </section>
        <div class="stack">
          <section v-if="report.narrative?.nextActions.length">
            <h3>Что дальше</h3>
            <ul>
              <li v-for="(a, i) in report.narrative.nextActions" :key="i">{{ a }}</li>
            </ul>
          </section>
          <section v-if="report.narrative?.needsOwner.length" class="card card-tint-sun owner">
            <h3>Нужно ваше решение</h3>
            <ul>
              <li v-for="(a, i) in report.narrative.needsOwner" :key="i">{{ a }}</li>
            </ul>
          </section>
        </div>
      </div>
      <p class="muted xs">
        Написан {{ when(report.createdAt) }}. Поколение {{ report.generation }}.
      </p>
    </article>
  </div>
</template>
<style scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-3);
  align-items: center;
  margin-bottom: var(--s-4);
}
.toolbar .select {
  width: auto;
  min-width: 200px;
  margin-left: auto;
}
.report-head {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: var(--s-4);
  align-items: start;
}
.report-head h2 {
  margin-top: 4px;
}
.summary-text {
  margin-top: var(--s-2);
  color: var(--ink-2);
  max-width: 70ch;
}
.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: var(--s-3);
  margin: var(--s-6) 0;
}
.metrics div {
  background: var(--surface-2);
  border-radius: var(--r-md);
  padding: var(--s-3) var(--s-4);
}
.metrics dt {
  font-size: var(--text-sm);
  color: var(--muted);
}
.metrics dd {
  margin: 2px 0 0;
  font-size: var(--text-xl);
}
.report-cols {
  display: grid;
  grid-template-columns: 1.3fr 1fr;
  gap: var(--s-6);
  margin-bottom: var(--s-5);
}
.report-cols h3 {
  margin-bottom: var(--s-3);
}
.report-cols ul {
  margin: 0;
  padding-left: 18px;
  line-height: 1.7;
}
.ranking {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--s-3);
}
.ranking li {
  display: grid;
  grid-template-columns: 40px 1fr;
  gap: var(--s-3);
  align-items: start;
}
.rank-status {
  margin-left: 8px;
  padding: 1px 8px;
  vertical-align: 1px;
}
.ranking .num {
  font-size: var(--text-lg);
}
.owner {
  padding: var(--s-4);
}
@media (max-width: 1023px) {
  .report-cols {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 639px) {
  .report-head {
    grid-template-columns: 1fr;
  }
  .report-head .avatar {
    display: none;
  }
  .toolbar .select {
    width: 100%;
    margin-left: 0;
  }
}
</style>
