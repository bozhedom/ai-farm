<script setup lang="ts">
const { state: d } = useFarm()
const props = defineProps<{ busy: boolean }>()
const emit = defineEmits<{ control: [action: string] }>()
const activeStrategies = computed(
  () => d.value?.strategies?.filter((s: any) => s.status === 'active') || [],
)
</script>

<template>
  <section class="metrics" aria-label="Показатели">
    <article>
      <span>Активных сервисов</span
      ><strong
        >{{ d.products.filter((p: any) => p.status === 'sandbox').length
        }}<small>/ 3</small></strong
      >
      <p>В пределах конструктора</p>
    </article>
    <article>
      <span>Рабочих стратегий</span><strong>{{ activeStrategies.length }}<small>/ 4</small></strong>
      <p>Поколение {{ d.state.generation }}</p>
    </article>
    <article>
      <span>Расходы API за месяц</span><strong>{{ rub(d.budget.monthSpent) }}</strong>
      <p>Лимит {{ rub(d.config.monthlyLimit) }}</p>
    </article>
    <article>
      <span>Реальная выручка</span><strong>{{ rub(d.realRevenueKopecks) }}</strong>
      <p>Тестовые средства исключены</p>
    </article>
  </section>
  <div class="two-columns">
    <section class="panel">
      <div class="section-heading">
        <h2>Команда стратегий</h2>
        <NuxtLink to="/?view=strategies">Все стратегии ↗</NuxtLink>
      </div>
      <div class="strategy-list">
        <div v-for="(s, i) in activeStrategies" :key="s.id" class="strategy-row">
          <span class="strategy-avatar" :class="'shade-' + i">{{ s.name.slice(0, 1) }}</span>
          <div>
            <strong>{{ s.name }}</strong>
            <p>{{ s.approach }}</p>
          </div>
          <span class="tag">{{ s.test_delivered }} тест.</span>
        </div>
      </div>
    </section>
    <section class="panel">
      <div class="section-heading">
        <h2>Контроль эксперимента</h2>
        <span class="tiny-label">POLICY V1</span>
      </div>
      <div class="budget-line">
        <span>API сегодня</span
        ><strong>{{ rub(d.budget.daySpent) }} / {{ rub(d.config.dailyLimit) }}</strong>
      </div>
      <div class="budget-track">
        <i
          :style="{
            width: Math.min(100, (d.budget.daySpent / d.config.dailyLimit) * 100) + '%',
          }"
        />
      </div>
      <p class="muted small-text">
        В резервах: {{ rub(d.budget.outstanding) }}. Один бюджет на всю команду.
      </p>
      <div class="evaluation-callout">
        <span>Недельная оценка</span
        ><strong>{{
          d.evaluations[0] ? labels[d.evaluations[0].decision] : 'Ожидает первого запуска'
        }}</strong>
        <p>
          {{
            d.evaluations[0]?.reason ||
            'Денежный победитель появится только после достаточных сопоставимых продаж.'
          }}
        </p>
      </div>
      <div class="control-buttons">
        <button
          class="button secondary small"
          :disabled="props.busy"
          @click="emit('control', d.state.mode === 'running' ? 'paused' : 'running')"
        >
          {{ d.state.mode === 'running' ? 'Ⅱ Приостановить' : '▶ Продолжить' }}</button
        ><button
          class="button danger small"
          :disabled="props.busy || d.state.mode === 'emergency_stop'"
          @click="emit('control', 'emergency_stop')"
        >
          Остановить
        </button>
      </div>
      <p class="muted small-text">
        Пауза завершает принятые заказы. Стоп приостанавливает исполнение; история и обязательства
        сохраняются.
      </p>
    </section>
  </div>
  <section class="panel">
    <div class="section-heading">
      <h2>Последние события</h2>
      <NuxtLink to="/?view=audit">Открыть журнал ↗</NuxtLink>
    </div>
    <div v-if="!d.audit.length" class="empty">События появятся после первого запуска worker.</div>
    <div v-for="event in d.audit.slice(0, 5)" :key="event.id" class="event-row">
      <span class="event-dot" /><span>{{ event.message }}</span
      ><time>{{ dateTime(event.created_at) }}</time>
    </div>
  </section>
</template>
