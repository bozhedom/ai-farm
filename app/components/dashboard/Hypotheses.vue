<script setup lang="ts">
const { state: d } = useFarm()
const props = defineProps<{ busy: boolean }>()
const emit = defineEmits<{ control: [action: string] }>()
const sourceHost = (url: string) => new URL(url).hostname
</script>

<template>
  <div class="section-heading">
    <p class="muted">Каждая идея хранит основания, возражения и способ опровержения.</p>
    <button
      class="button primary"
      :disabled="props.busy || d.state.mode !== 'running' || !d.state.research_enabled"
      @click="emit('control', 'research')"
    >
      Запустить исследование
    </button>
  </div>
  <div v-if="!d.hypotheses.length" class="panel empty large">
    Пока нет гипотез. Нажмите «Новое исследование» в пульте лаборатории.
  </div>
  <article v-for="h in d.hypotheses" :key="h.id" class="panel hypothesis">
    <div class="section-heading">
      <div>
        <span class="eyebrow">{{
          h.is_demo ? 'ДЕМО · СПРОС НЕ ПРОВЕРЕН' : 'ИССЛЕДОВАНИЕ · ПОИСКОВЫЕ ФРАГМЕНТЫ'
        }}</span>
        <h2>{{ h.title }}</h2>
      </div>
      <span class="status-pill" :class="h.status === 'accepted' ? 'good' : 'warn'">{{
        labels[h.status]
      }}</span>
    </div>
    <p>{{ h.research.hypothesis }}</p>
    <div class="hypothesis-grid">
      <div>
        <h3>Покупатель и проблема</h3>
        <p>{{ h.research.audience }}. {{ h.research.problem }}</p>
      </div>
      <div>
        <h3>Причина сомневаться</h3>
        <p>{{ h.research.counterargument }}</p>
      </div>
      <div>
        <h3>Как проверить</h3>
        <p>{{ h.research.experiment }}</p>
      </div>
      <div>
        <h3>Оценка прямых расходов</h3>
        <p>
          {{ rub(Math.round(h.research.estimatedCostRub * 100)) }} за заказ. Предварительная оценка
          модели; сервер и привлечение покупателей считаются отдельно.
        </p>
      </div>
      <div>
        <h3>Итоговая проверка · {{ labels[h.critique.verdict] }}</h3>
        <p>{{ h.critique.reason }}</p>
      </div>
    </div>
    <div class="evidence-list">
      <strong>Источники</strong
      ><a
        v-for="e in h.evidence"
        :key="e.url"
        :href="e.url"
        target="_blank"
        rel="noopener noreferrer"
        >{{ e.title }} ↗ <small>{{ sourceHost(e.url) }} · {{ dateTime(e.observedAt) }}</small></a
      >
    </div>
    <p class="muted small-text">{{ h.research.uncertainties.join(' ') }}</p>
  </article>
</template>
