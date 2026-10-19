<script setup lang="ts">
/**
 * Small multi-series line chart. The SVG stretches to the card; labels are HTML so they stay
 * readable at any width. Values are display numbers only.
 */
type Series = { id: string; label: string; color: string; points: { x: string; y: number }[] }
const props = defineProps<{
  series: Series[]
  /** Every x key in order (UTC days). */
  xs: string[]
  unit: string
  height?: number
  format?: (value: number) => string
}>()

const W = 600
const H = computed(() => props.height ?? 180)
const range = computed(() => {
  const ys = props.series.flatMap((s) => s.points.map((p) => p.y))
  let min = Math.min(0, ...ys)
  let max = Math.max(0, ...ys)
  if (min === max) {
    min -= 1
    max += 1
  }
  const pad = (max - min) * 0.08
  return { min: min - pad, max: max + pad }
})
const x = (key: string) => {
  const i = props.xs.indexOf(key)
  return props.xs.length > 1 ? (i / (props.xs.length - 1)) * W : W / 2
}
const y = (value: number) =>
  H.value - ((value - range.value.min) / (range.value.max - range.value.min)) * H.value
const paths = computed(() =>
  props.series.map((s) => {
    const pts = s.points.filter((p) => props.xs.includes(p.x))
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`)
    const last = pts.at(-1)
    return {
      ...s,
      d: d.join(' '),
      single: pts.length === 1,
      last: last ? { cx: x(last.x), cy: y(last.y), y: last.y } : null,
    }
  }),
)
const zero = computed(() => y(0))
const fmt = (v: number) =>
  props.format ? props.format(v) : v.toLocaleString('ru-RU', { maximumFractionDigits: 2 })
const dayLabel = (key?: string) => {
  if (!key) return ''
  const [, m, d] = key.split('-')
  return `${Number(d)}.${m}`
}
</script>
<template>
  <figure class="lc">
    <div class="lc-plot" :style="{ height: `${H}px` }">
      <span class="lc-y lc-y-top">{{ fmt(range.max) }} {{ unit }}</span>
      <span class="lc-y lc-y-bottom">{{ fmt(range.min) }} {{ unit }}</span>
      <svg
        :viewBox="`0 0 ${W} ${H}`"
        preserveAspectRatio="none"
        role="img"
        :aria-label="
          series.map((s) => `${s.label}: ${fmt(s.points.at(-1)?.y ?? 0)} ${unit}`).join('; ')
        "
      >
        <line class="lc-zero" x1="0" :x2="W" :y1="zero" :y2="zero" />
        <template v-for="p in paths" :key="p.id">
          <path :d="p.d" :style="{ stroke: p.color }" class="lc-line" />
          <line
            v-if="p.single && p.last"
            :x1="0"
            :x2="W"
            :y1="p.last.cy"
            :y2="p.last.cy"
            :style="{ stroke: p.color }"
            class="lc-line lc-dash"
          />
        </template>
      </svg>
      <i
        v-for="p in paths.filter((s) => s.last)"
        :key="`dot-${p.id}`"
        class="lc-dot"
        :style="{
          left: `${(p.last!.cx / W) * 100}%`,
          top: `${(p.last!.cy / H) * 100}%`,
          background: p.color,
        }"
      />
    </div>
    <div class="lc-x">
      <span>{{ dayLabel(xs[0]) }}</span
      ><span>{{ dayLabel(xs.at(-1)) }}</span>
    </div>
    <figcaption class="lc-legend">
      <span v-for="s in paths" :key="s.id"
        ><i :style="{ background: s.color }" />{{ s.label }}
        <b v-if="s.last">{{ fmt(s.last.y) }} {{ unit }}</b></span
      >
    </figcaption>
  </figure>
</template>
<style scoped>
.lc {
  margin: 0;
}
.lc-plot {
  position: relative;
  border-left: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  margin-left: 2px;
}
.lc-plot svg {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.lc-line {
  fill: none;
  stroke-width: 2.25;
  vector-effect: non-scaling-stroke;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.lc-dash {
  stroke-dasharray: 4 4;
  opacity: 0.6;
}
.lc-zero {
  stroke: var(--line-strong);
  stroke-dasharray: 3 4;
  vector-effect: non-scaling-stroke;
}
.lc-dot {
  position: absolute;
  width: 8px;
  height: 8px;
  margin: -4px 0 0 -4px;
  border-radius: 50%;
  box-shadow: 0 0 0 2px var(--surface);
}
.lc-y {
  position: absolute;
  left: 8px;
  font: 500 var(--text-xs) / 1 var(--font-mono);
  color: var(--muted);
  background: color-mix(in srgb, var(--surface) 80%, transparent);
  padding: 2px 4px;
  border-radius: 4px;
  pointer-events: none;
}
.lc-y-top {
  top: 4px;
}
.lc-y-bottom {
  bottom: 4px;
}
.lc-x {
  display: flex;
  justify-content: space-between;
  font: 500 var(--text-xs) / 1 var(--font-mono);
  color: var(--muted);
  margin-top: 6px;
}
.lc-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  margin-top: var(--s-3);
  font-size: var(--text-sm);
  color: var(--ink-2);
}
.lc-legend span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.lc-legend i {
  width: 10px;
  height: 10px;
  border-radius: 3px;
}
.lc-legend b {
  font-family: var(--font-mono);
  font-weight: 600;
}
</style>
