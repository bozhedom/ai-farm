<script setup lang="ts">
import type { OfficeIdea } from '../../../core/contracts/office'
import { domain, rub } from '~/composables/office/format'
import { revenueModelLabel } from '~/composables/office/labels'

/** The research behind an idea as short blocks. `full` adds uncertainties and the human plan. */
const props = defineProps<{ idea: OfficeIdea; full?: boolean }>()
const r = computed(() => props.idea.research)
const cost = computed(() => {
  const start = r.value.startupCostRub
  const month = r.value.monthlyCostRub
  if (!start && !month) return 'Стартовых расходов нет'
  const parts = []
  if (start) parts.push(`на старт ${rub(start * 100)}`)
  if (month) parts.push(`${rub(month * 100)} в месяц`)
  return parts.join(', ').replace(/^./, (c) => c.toUpperCase())
})
</script>
<template>
  <div class="facts">
    <div>
      <span class="eyebrow">Кому нужно</span>
      <p>{{ r.audience }}</p>
    </div>
    <div>
      <span class="eyebrow">Проблема</span>
      <p>{{ r.problem }}</p>
    </div>
    <div class="wide-sm">
      <span class="eyebrow">Спрос</span>
      <ul class="signals">
        <li v-for="(signal, i) in r.demandSignals" :key="i">
          {{ signal.claim }}
          <a :href="signal.url" target="_blank" rel="noopener noreferrer nofollow">{{
            domain(signal.url) || 'Источник'
          }}</a>
        </li>
      </ul>
      <p v-if="!r.demandSignals.length" class="muted">Источников нет</p>
    </div>
    <div>
      <span class="eyebrow">Конкуренты</span>
      <ul v-if="r.competitors.length">
        <li v-for="(item, i) in r.competitors" :key="i">{{ item }}</li>
      </ul>
      <p v-else class="muted">Не нашли</p>
    </div>
    <div>
      <span class="eyebrow">Как зарабатывать</span>
      <p>
        <strong v-if="revenueModelLabel(r.revenueModel)"
          >{{ revenueModelLabel(r.revenueModel) }}.</strong
        >
        {{ r.revenueNote }}
      </p>
    </div>
    <div>
      <span class="eyebrow">Расходы</span>
      <p>{{ cost }}</p>
    </div>
    <div>
      <span class="eyebrow">Риски</span>
      <ul v-if="r.risks.length">
        <li v-for="(item, i) in r.risks" :key="i">{{ item }}</li>
      </ul>
      <p v-else class="muted">Не назвали</p>
    </div>
    <div>
      <span class="eyebrow">Быстрая проверка</span>
      <p>{{ r.quickTest }}</p>
    </div>
    <div v-if="full && r.uncertainties.length">
      <span class="eyebrow">Что неясно</span>
      <ul>
        <li v-for="(item, i) in r.uncertainties" :key="i">{{ item }}</li>
      </ul>
    </div>
  </div>
</template>
<style scoped>
.facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--s-3);
}
.facts > div {
  background: var(--surface-2);
  border-radius: var(--r-md);
  padding: var(--s-3) var(--s-4);
  font-size: var(--text-sm);
  min-width: 0;
  overflow-wrap: anywhere;
}
.facts .eyebrow {
  display: block;
  margin-bottom: 6px;
}
.facts ul {
  margin: 0;
  padding-left: 16px;
}
.facts li + li {
  margin-top: 4px;
}
.signals a {
  white-space: nowrap;
}
@media (max-width: 1023px) {
  .facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 639px) {
  .facts {
    grid-template-columns: 1fr;
  }
}
</style>
