<script setup lang="ts">
import type { ManagerTaskView } from '../../../core/contracts/manager'
import { managerReason, managerTaskStatus, managerVerdict } from '~/utils/manager'
import { pct, shortTime, strategyName, usdt } from '~/utils/trading'

const props = defineProps<{ task: ManagerTaskView }>()
const tradingPaused = computed(() =>
  [
    'DAILY_LOSS_LIMIT',
    'DRAWDOWN_LIMIT',
    'OWNER_PAUSE',
    'OWNER_STOP',
    'OWNER_EXIT',
    'MANAGER_RISK_PAUSED',
    'MANAGER_PORTFOLIO_PAUSED',
    'TRADING_DAILY_LOCKED',
    'TRADING_DRAWDOWN_LOCKED',
  ].includes(props.task.reason),
)
</script>
<template>
  <article class="manager-task" :aria-label="task.hypothesis">
    <div class="manager-task-heading">
      <span class="manager-task-kind">{{ strategyName[task.kind] }}</span>
      <span class="manager-status" :class="`manager-status-${task.status}`">
        {{ managerTaskStatus[task.status] }}
      </span>
    </div>
    <p class="manager-hypothesis">{{ task.hypothesis }}</p>
    <span v-if="task.demo" class="manager-demo-label">Идея из демонстрационного разбора</span>
    <p v-if="task.reason" class="manager-task-reason">{{ managerReason(task.reason) }}</p>
    <NuxtLink v-if="tradingPaused" class="t-link" to="/office/trading">Открыть торговлю</NuxtLink>
    <div v-if="task.outcome" class="manager-outcome">
      <p>
        <strong>{{ managerVerdict[task.outcome.verdict] }}</strong>
      </p>
      <p v-if="task.outcome.pnlUsdt !== null" class="manager-result">
        <span
          :class="
            Number(task.outcome.pnlUsdt) < 0
              ? 't-negative'
              : Number(task.outcome.pnlUsdt) > 0
                ? 't-positive'
                : ''
          "
        >
          {{ Number(task.outcome.pnlUsdt) > 0 ? '+' : '' }}{{ usdt(task.outcome.pnlUsdt) }} USDT
        </span>
        <span class="t-muted">после торговых комиссий</span>
      </p>
      <p class="manager-caption">
        Закрытых позиций: {{ task.outcome.roundTrips }}. Максимальная просадка:
        {{ pct(task.outcome.drawdownBps) }}.
      </p>
      <p v-if="task.outcome.verdict === 'positive'" class="manager-caption">
        Это ранняя оценка на тренировке. Она не даёт допуска к настоящим деньгам.
      </p>
    </div>
    <p v-else-if="task.status === 'observing'" class="manager-caption">
      Начало {{ task.appliedAt ? shortTime(task.appliedAt) : 'ожидает подтверждения' }}.
      <template v-if="task.evaluateAt"
        >Первая оценка не раньше {{ shortTime(task.evaluateAt) }}.</template
      >
    </p>
    <p v-else-if="task.status === 'queued'" class="manager-caption">
      Ожидание до {{ shortTime(task.expiresAt) }}.
    </p>
    <details class="manager-details">
      <summary>Обоснование и параметры</summary>
      <p>{{ task.rationale }}</p>
      <dl class="manager-facts">
        <div>
          <dt>Свечей для оценки</dt>
          <dd>{{ task.params.lookback }}</dd>
        </div>
        <div>
          <dt>Порог входа</dt>
          <dd>{{ pct(task.params.entryBps) }}</dd>
        </div>
        <div>
          <dt>Фиксация прибыли</dt>
          <dd>{{ pct(task.params.takeProfitBps) }}</dd>
        </div>
        <div>
          <dt>Идея создана</dt>
          <dd>{{ shortTime(task.createdAt) }}</dd>
        </div>
        <div v-if="task.outcome">
          <dt>Торговые комиссии</dt>
          <dd>{{ usdt(task.outcome.feesUsdt) }} USDT</dd>
        </div>
        <div v-if="task.outcome">
          <dt>Оценка получена</dt>
          <dd>{{ shortTime(task.outcome.evaluatedAt) }}</dd>
        </div>
      </dl>
    </details>
  </article>
</template>
