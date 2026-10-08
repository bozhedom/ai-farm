<script setup lang="ts">
import type { operationsStatus } from '../../../core/operations'
const props = defineProps<{ operations: Awaited<ReturnType<typeof operationsStatus>> }>()
const services = {
  database: 'База данных',
  worker: 'Обработчик заказов',
  payments: 'Сверка платежей',
  backup: 'Резервная копия',
}
const providers = { model: 'Модель', search: 'Поиск' }
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
    <h3>Инфраструктура</h3>
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
    <h3>Модель и поиск · предварительная проверка</h3>
    <p v-if="!operations.providers.fresh" class="notice error" role="status">
      Нет свежей проверки модели и поиска от обработчика. Готовность к автономной работе не
      подтверждена.
    </p>
    <p v-else-if="operations.providers.status !== 'ok'" class="notice error" role="status">
      Модель или поиск недоступны. Даже при исправной инфраструктуре исследования ждут
      восстановления этих служб.
    </p>
    <div class="two-columns">
      <div v-for="(name, key) in providers" :key="key">
        <strong>{{ name }} · {{ operations.providers[key].provider }}</strong>
        <p v-if="!operations.providers.fresh">Нет свежего подтверждения от обработчика.</p>
        <p v-else-if="!operations.providers[key].preflightReady">
          Предварительная проверка не пройдена. Проверьте подключение и состояние службы.
        </p>
        <p v-else-if="operations.providers[key].verification === 'local_probe'">
          Локальная служба прошла проверку доступности. Выполнение задания этим не проверяется.
        </p>
        <p v-else-if="operations.providers[key].verification === 'demo'">
          Демонстрационный режим. Настоящие модельные ответы и поиск не проверяются.
        </p>
        <p v-else>
          Внешний API не проверяется контрольным запросом. Предварительная проверка не подтверждает
          успешное выполнение запроса.
        </p>
      </div>
    </div>
    <p class="muted small-text">
      Готовность локальной модели и поиска берётся из последней проверки обработчика. Для облака
      проверяются настройки и доступность используемых локальных служб; вызов внешнего API и
      генерация текста в эту проверку не входят.
    </p>
    <div class="two-columns">
      <div>
        <h3>
          {{
            observation.complete
              ? '48 часов предварительных проверок подтверждены'
              : 'Инфраструктура и зависимости · 48 часов'
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
            проверками инфраструктуры и свежими предварительными проверками модели и поиска.
          </p>
          <progress
            class="observation-progress"
            :value="Math.min(observation.healthySeconds, observation.targetSeconds)"
            :max="observation.targetSeconds"
            aria-label="Непрерывные предварительные проверки из 48 часов"
          />
          <p v-if="!observation.fresh" class="error-text">
            Наблюдатель не прислал свежую проверку. Непрерывная доступность сейчас не подтверждена.
          </p>
          <p class="muted small-text">
            Измерений: {{ observation.samples }} · неуспешных: {{ observation.failedSamples }} ·
            пропусков интервала: {{ observation.gaps }}.
          </p>
          <p v-if="observation.legacySamples" class="muted small-text">
            Старых измерений только инфраструктуры: {{ observation.legacySamples }}. Они сохранены,
            но не входят в эти 48 часов: модель и поиск тогда не проверялись.
          </p>
          <p class="muted small-text">
            Непрерывная доступность одной инфраструктуры по истории:
            {{ hours(observation.infrastructure.healthySeconds) }} ч.
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
          доступности и предварительных проверок, а не подтверждение успешной облачной генерации,
          качества текстов или платного цикла. Внешние оповещения и копия на другом сервере пока не
          подключены.
        </p>
      </div>
    </div>
  </section>
</template>
