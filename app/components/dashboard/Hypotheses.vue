<script setup lang="ts">
const { state: d } = useFarm()
const { researchBlockedReason, serviceLabel, productLink } = useServiceCatalog()
const props = defineProps<{ busy: boolean }>()
const emit = defineEmits<{ control: [action: string] }>()
const sourceHost = (url: string) => new URL(url).hostname
</script>

<template>
  <div class="section-heading">
    <p class="muted">
      Здесь хранятся результаты исследований. Принятые идеи выпускают версию текстового сервиса;
      отклонённые сохраняются с причиной.
    </p>
    <button
      class="button primary"
      :disabled="props.busy || !!researchBlockedReason"
      @click="emit('control', 'research')"
    >
      Проверить идею
    </button>
  </div>
  <p v-if="researchBlockedReason" class="muted small-text" role="status">
    {{ researchBlockedReason }}
    <NuxtLink to="/office?view=directions">Направления и управление</NuxtLink>
  </p>
  <div v-if="!d.hypotheses.length" class="panel empty large">
    Исследований пока нет. Нажмите «Проверить идею».
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
    <p class="muted small-text">
      {{ serviceLabel(h.template) }} · {{ dateTime(h.created_at) }} ·
      {{
        h.is_demo ? 'Демопровайдер' : h.generated_by_model || 'Модель в старой записи не сохранена'
      }}
    </p>
    <p v-if="h.released_version" class="notice">
      По этой гипотезе выпущена версия {{ h.released_version }} сервиса.
      <NuxtLink
        :to="h.released_product_id ? productLink(h.released_product_id) : '/office/products'"
        >Открыть услугу</NuxtLink
      >
      Сейчас витрина показывает последнюю версию; прежние заказы сохраняют свою.
    </p>
    <p v-else class="muted small-text">
      Сервис по этой гипотезе не выпущен. Причина указана в итоговой проверке. Новое исследование
      создаст отдельную запись и не удалит эту.
    </p>
    <p><strong>Итог проверки:</strong> {{ h.critique.reason }}</p>
    <details>
      <summary>Аудитория, проверка и источники</summary>
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
            {{ rub(Math.round(h.research.estimatedCostRub * 100)) }} за заказ. Предварительная
            оценка модели; сервер и привлечение покупателей считаются отдельно.
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
          >{{ e.title }} <small>{{ sourceHost(e.url) }}, {{ dateTime(e.observedAt) }}</small></a
        >
      </div>
      <p class="muted small-text">{{ h.research.uncertainties.join(' ') }}</p>
    </details>
  </article>
</template>
