<script setup lang="ts">
/**
 * Money per UTC day: real revenue and test payments up, model spend down. Kopecks in, the chart
 * only scales them. Test payments are drawn apart (hatched) and never stacked onto revenue.
 */
import { rub } from '~/composables/office/format'

const props = defineProps<{
  days: { day: string; realKopecks: number; testKopecks: number; spendKopecks: number }[]
}>()
const W = 600
const H = 160
const top = computed(() =>
  Math.max(1, ...props.days.map((d) => Math.max(d.realKopecks, d.testKopecks))),
)
const bottom = computed(() => Math.max(1, ...props.days.map((d) => d.spendKopecks)))
/** Share of height above the axis, by the larger side, between 35% and 80%. */
const split = computed(() => {
  const share = top.value / (top.value + bottom.value)
  return Math.min(0.8, Math.max(0.35, share))
})
const axis = computed(() => H * split.value)
const slot = computed(() => W / Math.max(1, props.days.length))
const bars = computed(() =>
  props.days.map((d, i) => {
    const x = i * slot.value
    const w = slot.value * 0.36
    const up = (v: number) => (v / top.value) * axis.value
    const down = (v: number) => (v / bottom.value) * (H - axis.value)
    return {
      ...d,
      real: { x: x + slot.value * 0.12, w, h: up(d.realKopecks) },
      test: { x: x + slot.value * 0.12 + w, w, h: up(d.testKopecks) },
      spend: { x: x + slot.value * 0.12, w: w * 2, h: down(d.spendKopecks) },
      title: `${d.day}: доход ${rub(d.realKopecks)}, тестовые оплаты ${rub(d.testKopecks)}, расходы ${rub(d.spendKopecks)}`,
    }
  }),
)
const label = (key?: string) => {
  if (!key) return ''
  const [, m, d] = key.split('-')
  return `${Number(d)}.${m}`
}
const hasTop = computed(() => props.days.some((d) => d.realKopecks || d.testKopecks))
const hasBottom = computed(() => props.days.some((d) => d.spendKopecks))
const empty = computed(() =>
  props.days.every((d) => !d.realKopecks && !d.testKopecks && !d.spendKopecks),
)
</script>
<template>
  <figure class="db">
    <div class="db-plot">
      <span v-if="hasTop" class="db-y db-y-top">{{ rub(top) }}</span>
      <span v-if="hasBottom" class="db-y db-y-bottom">−{{ rub(bottom) }}</span>
      <svg
        :viewBox="`0 0 ${W} ${H}`"
        preserveAspectRatio="none"
        role="img"
        aria-label="Деньги по дням"
      >
        <defs>
          <pattern
            id="db-hatch"
            width="4"
            height="4"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="4" height="4" class="db-hatch-bg" />
            <line x1="0" y1="0" x2="0" y2="4" class="db-hatch-line" />
          </pattern>
        </defs>
        <line class="db-axis" x1="0" :x2="W" :y1="axis" :y2="axis" />
        <g v-for="b in bars" :key="b.day">
          <title>{{ b.title }}</title>
          <rect class="db-hit" :x="b.real.x - 2" y="0" :width="b.spend.w + 4" :height="H" />
          <rect
            v-if="b.real.h"
            class="db-real"
            :x="b.real.x"
            :y="axis - b.real.h"
            :width="b.real.w"
            :height="b.real.h"
          />
          <rect
            v-if="b.test.h"
            class="db-test"
            :x="b.test.x"
            :y="axis - b.test.h"
            :width="b.test.w"
            :height="b.test.h"
          />
          <rect
            v-if="b.spend.h"
            class="db-spend"
            :x="b.spend.x"
            :y="axis"
            :width="b.spend.w"
            :height="b.spend.h"
          />
        </g>
      </svg>
      <p v-if="empty" class="db-empty small muted">
        За 30 дней не было ни оплат, ни платных вызовов модели.
      </p>
    </div>
    <div class="db-x">
      <span>{{ label(days[0]?.day) }}</span
      ><span>сегодня</span>
    </div>
    <figcaption class="db-legend">
      <span><i class="k-real" />Реальный доход</span>
      <span><i class="k-test" />Тестовые оплаты, не выручка</span>
      <span><i class="k-spend" />Расходы на модели</span>
    </figcaption>
  </figure>
</template>
<style scoped>
.db {
  margin: 0;
}
.db-plot {
  position: relative;
  height: 160px;
  border-bottom: 1px solid var(--line);
}
.db-plot svg {
  display: block;
  width: 100%;
  height: 100%;
}
.db-axis {
  stroke: var(--line-strong);
  vector-effect: non-scaling-stroke;
}
.db-hit {
  fill: transparent;
}
.db-real,
.k-real {
  fill: var(--brand);
  background: var(--brand);
}
.db-test {
  fill: url(#db-hatch);
}
.db-hatch-bg {
  fill: var(--st-test-soft);
}
.db-hatch-line {
  stroke: var(--st-test);
  stroke-width: 2;
}
.k-test {
  background: repeating-linear-gradient(45deg, var(--st-test) 0 2px, var(--st-test-soft) 2px 4px);
}
.db-spend,
.k-spend {
  fill: var(--clay);
  background: var(--clay);
}
.db-y {
  position: absolute;
  left: 0;
  font: 500 var(--text-xs) / 1 var(--font-mono);
  color: var(--muted);
  pointer-events: none;
}
.db-y-top {
  top: 0;
}
.db-y-bottom {
  bottom: 2px;
}
.db-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  text-align: center;
  padding: 0 var(--s-6);
  margin: 0;
}
.db-x {
  display: flex;
  justify-content: space-between;
  font: 500 var(--text-xs) / 1 var(--font-mono);
  color: var(--muted);
  margin-top: 6px;
}
.db-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  margin-top: var(--s-3);
  font-size: var(--text-sm);
  color: var(--ink-2);
}
.db-legend span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.db-legend i {
  width: 10px;
  height: 10px;
  border-radius: 3px;
}
</style>
