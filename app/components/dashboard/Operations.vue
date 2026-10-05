<script setup lang="ts">
import type { operationsStatus } from '../../../core/operations'
const props = defineProps<{ operations: Awaited<ReturnType<typeof operationsStatus>> }>()
const services = {
  database: 'База данных',
  worker: 'Обработчик заказов',
  payments: 'Сверка платежей',
  backup: 'Резервная копия',
}
const observation = computed(() => props.operations.observation)
const hours = (seconds: number) =>
  (seconds / 3600).toLocaleString('ru-RU', { maximumFractionDigits: 1 })
</script>
<template>
  <section class="panel" aria-label="Наблюдение за сервером">
    <div class="section-heading">
      <h2>Наблюдение за сервером</h2>
      <span class="tag">Без вызовов модели</span>
    </div>
    <div class="operations-checks">
      <div v-for="(name, key) in services" :key="key">
        <span class="status-pill" :class="operations.checks[key] ? 'good' : 'warn'"
          >{{ operations.checks[key] ? '✓' : '!' }} {{ name }}</span
        >
        <span class="muted small-text">{{
          operations.checks[key] ? 'В порядке' : 'Нет свежего подтверждения'
        }}</span>
      </div>
    </div>
    <div class="two-columns">
      <div>
        <h3>
          {{
            observation.complete
              ? '48 часов без пропусков подтверждены'
              : 'Проверка доступности · 48 часов'
          }}
        </h3>
        <p v-if="operations.observationError" class="error-text">
          Файл наблюдения повреждён. История сохранена; требуется проверка владельцем.
        </p>
        <p v-else-if="!observation.samples">
          Наблюдение ещё не началось. Служба observer сохраняет результат каждую минуту.
        </p>
        <template v-else>
          <p>
            <strong>{{ hours(observation.healthySeconds) }} / 48 ч</strong> подряд с успешными
            проверками.
          </p>
          <progress
            class="observation-progress"
            :value="Math.min(observation.healthySeconds, observation.targetSeconds)"
            :max="observation.targetSeconds"
            aria-label="Непрерывная доступность из 48 часов"
          />
          <p v-if="!observation.fresh" class="error-text">
            Наблюдатель не прислал свежую проверку. Непрерывная доступность сейчас не подтверждена.
          </p>
          <p class="muted small-text">
            Измерений: {{ observation.samples }} · неуспешных: {{ observation.failedSamples }} ·
            пропусков интервала: {{ observation.gaps }}.
          </p>
          <p class="muted small-text">Последняя проверка {{ dateTime(observation.lastAt!) }}.</p>
        </template>
      </div>
      <div>
        <h3>Сохранность данных</h3>
        <p>
          {{
            operations.backupAt
              ? 'Последняя попытка резервного копирования: ' + dateTime(operations.backupAt) + '.'
              : 'Служба резервного копирования ещё не сообщила о результате.'
          }}
        </p>
        <p class="muted small-text">
          Проверки идут на машине приложения и продолжаются после закрытия браузера. Это наблюдение
          доступности, а не подтверждение качества текстов или платного цикла. Внешние оповещения и
          копия на другом сервере пока не подключены.
        </p>
      </div>
    </div>
  </section>
</template>
