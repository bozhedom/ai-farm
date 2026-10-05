<script setup lang="ts">
const { state: d } = useFarm()
const props = defineProps<{ busy: boolean }>()
const emit = defineEmits<{ control: [action: string] }>()
</script>

<template>
  <section class="panel">
    <div class="section-heading">
      <div>
        <span class="eyebrow">ПОКОЛЕНИЕ {{ d.state.generation }}</span>
        <h2>Как сравниваются подходы</h2>
      </div>
      <span class="tag">4 активных места</span>
    </div>
    <p>
      Раз в неделю система оценивает данные. При достаточной выборке две слабые стратегии
      архивируются, а два лидера создают по одной копии. Без реальных продаж система ждёт данных.
    </p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Стратегия</th>
            <th>Подход</th>
            <th>Поколение</th>
            <th>Тестовых выдач</th>
            <th>Статус</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in d.strategies" :key="s.id">
            <td>
              <strong>{{ s.name }}</strong
              ><small v-if="s.parent_id">Копия · {{ s.parent_id.slice(0, 8) }}</small>
            </td>
            <td>{{ s.approach }}</td>
            <td>{{ s.generation }}</td>
            <td>{{ s.test_delivered }}</td>
            <td>
              <span class="tag">{{ labels[s.status] }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
  <section class="panel simulation-panel">
    <div>
      <span class="eyebrow">ОТДЕЛЬНАЯ ДЕМОНСТРАЦИЯ</span>
      <h2>Проверить смену поколения</h2>
      <p>
        Симуляция заменит две стратегии на фиксированных учебных данных. История и заказы
        сохранятся, финансовый журнал не изменится.
      </p>
    </div>
    <button
      class="button secondary"
      :disabled="props.busy || d.state.mode !== 'running'"
      @click="emit('control', 'simulate')"
    >
      Симулировать отбор 50%
    </button>
  </section>
  <section class="panel">
    <h2>История оценок</h2>
    <div v-for="e in d.evaluations" :key="e.id" class="event-row">
      <span class="tag">{{ labels[e.decision] }}</span
      ><span>{{ e.reason }}</span
      ><time>{{ dateTime(e.created_at) }}</time>
    </div>
    <p v-if="!d.evaluations.length" class="empty">
      Первая оценка появится после запуска обработчика.
    </p>
  </section>
</template>
