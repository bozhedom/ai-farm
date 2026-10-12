<script setup lang="ts">
import { usdt, shortTime } from '~/utils/trading'
const props = defineProps<{ points: { at: string; value: string }[]; capital: string }>()
const hover = ref<number | null>(null)
const chart = computed(() => {
  const points = props.points.map((p) => ({
    ...p,
    n: Number(p.value),
    t: new Date(p.at).getTime(),
  }))
  if (points.length < 2) return null
  const principal = Number(props.capital)
  const min = Math.min(principal, ...points.map((p) => p.n))
  const max = Math.max(principal, ...points.map((p) => p.n))
  const pad = Math.max((max - min) * 0.15, 0.025)
  const low = min - pad,
    high = max + pad
  const from = points[0]!.t,
    span = Math.max(1, points.at(-1)!.t - from)
  const y = (n: number) => 172 - ((n - low) / (high - low)) * 148
  const dots = points.map((p) => ({ ...p, x: 16 + ((p.t - from) / span) * 668, y: y(p.n) }))
  return {
    dots,
    path: dots.map((p) => `${p.x},${p.y}`).join(' '),
    baseline: y(principal),
    low,
    high,
  }
})
const selected = computed(() => (hover.value !== null ? chart.value?.dots[hover.value] : null))
function move(event: PointerEvent) {
  if (!chart.value) return
  const box = (event.currentTarget as SVGElement).getBoundingClientRect()
  const x = ((event.clientX - box.left) / box.width) * 700
  let index = 0
  for (let i = 1; i < chart.value.dots.length; i++)
    if (Math.abs(chart.value.dots[i]!.x - x) < Math.abs(chart.value.dots[index]!.x - x)) index = i
  hover.value = index
}
</script>
<template>
  <figure class="equity-chart">
    <template v-if="chart">
      <div class="chart-caption">
        <span>{{ selected ? shortTime(selected.at) : 'Стоимость портфеля' }}</span
        ><strong>{{ usdt(selected?.value || points.at(-1)!.value, 4) }} USDT</strong>
      </div>
      <svg
        viewBox="0 0 700 200"
        role="img"
        :aria-label="`Капитал за последние 24 часа: от ${usdt(points[0]!.value)} до ${usdt(points.at(-1)!.value)} USDT`"
        @pointermove="move"
        @pointerleave="hover = null"
      >
        <line
          v-for="y in [25, 74, 123, 172]"
          :key="y"
          x1="16"
          x2="684"
          :y1="y"
          :y2="y"
          class="gridline"
        />
        <line x1="16" x2="684" :y1="chart.baseline" :y2="chart.baseline" class="baseline" />
        <polyline :points="chart.path" class="curve" />
        <template v-if="selected">
          <line :x1="selected.x" :x2="selected.x" y1="20" y2="178" class="cursor" />
          <circle :cx="selected.x" :cy="selected.y" r="4" class="point" />
        </template>
      </svg>
      <figcaption>
        <span>{{ shortTime(points[0]!.at) }}</span
        ><span>Пунктир: стартовые {{ usdt(capital) }} USDT</span
        ><span>{{ shortTime(points.at(-1)!.at) }}</span>
      </figcaption>
    </template>
    <div v-else class="chart-empty">
      <OfficeIcon name="report" /><strong>{{
        points.length ? 'Первая оценка сохранена' : 'Здесь будет история капитала'
      }}</strong
      ><span>{{
        points.length
          ? 'Следующая точка появится в течение пяти минут.'
          : 'Запустите бумажный портфель. График строится только по измеренным результатам.'
      }}</span>
    </div>
  </figure>
</template>
<style scoped>
.equity-chart {
  margin: 0;
  min-width: 0;
}
.chart-caption {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  color: var(--t-muted);
  gap: 12px;
}
.chart-caption strong {
  font-family: var(--font-mono);
  color: var(--t-ink);
  font-weight: 500;
}
svg {
  display: block;
  width: 100%;
  height: auto;
  touch-action: pan-y;
}
.gridline {
  stroke: var(--t-line);
  stroke-width: 0.7;
}
.baseline {
  stroke: #8395a7;
  stroke-dasharray: 4 5;
  stroke-width: 1;
}
.curve {
  stroke: var(--t-blue);
  stroke-width: 2.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  fill: none;
}
.cursor {
  stroke: var(--t-muted);
  stroke-dasharray: 2 4;
}
.point {
  fill: var(--t-blue);
  stroke: white;
  stroke-width: 2;
}
figcaption {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--t-muted);
  font-size: 11px;
}
.chart-empty {
  min-height: 232px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 8px;
  text-align: center;
  color: var(--t-muted);
  padding: 24px;
}
.chart-empty :deep(svg) {
  width: 30px;
  height: 30px;
  stroke: var(--t-blue);
  margin-bottom: 4px;
}
.chart-empty strong {
  font-family: var(--font-display);
  color: var(--t-ink);
  font-size: 17px;
}
.chart-empty span {
  max-width: 370px;
  font-size: 14px;
}
@media (max-width: 639px) {
  figcaption span:nth-child(2) {
    display: none;
  }
  .chart-caption {
    font-size: 11px;
  }
  .chart-empty {
    min-height: 190px;
  }
}
</style>
