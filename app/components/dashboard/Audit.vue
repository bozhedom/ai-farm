<script setup lang="ts">
const { state: d } = useFarm()
const roleNames: Record<string, string> = {
  search: 'Поиск',
  Исследователь: 'Исследователь',
  Критик: 'Критик',
  Архитектор: 'Архитектор',
  Исполнитель: 'Исполнитель',
  Проверяющий: 'Проверяющий',
}
</script>

<template>
  <section class="panel">
    <h2>Очередь заданий</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Задание</th>
            <th>Статус</th>
            <th>Попытка</th>
            <th>Причина остановки</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="j in d.jobs" :key="j.id">
            <td>
              {{ labels[j.kind] }} <small>{{ j.id.slice(0, 8) }}</small>
            </td>
            <td>{{ labels[j.status] }}</td>
            <td>{{ j.attempts }} / 3</td>
            <td>{{ j.error_code || '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
  <section class="panel">
    <h2>Вызовы инструментов</h2>
    <div v-for="(call, i) in d.toolCalls" :key="i" class="event-row">
      <span class="tag">{{ roleNames[call.role] || call.role }}</span
      ><span
        >{{
          call.is_demo
            ? 'Демонстрация'
            : call.status === 'uncertain'
              ? 'Исход неизвестен, резерв учтён'
              : 'API'
        }}
        ·
        {{
          call.provider === 'openai' ? usd(call.charged_microusd) : rub(call.charged_kopecks)
        }}</span
      ><time>{{ dateTime(call.created_at) }}</time>
    </div>
  </section>
  <section class="panel">
    <h2>Журнал решений</h2>
    <div v-for="event in d.audit" :key="event.id" class="event-row">
      <span class="event-dot" /><span>{{ event.message }}</span
      ><time>{{ dateTime(event.created_at) }}</time>
    </div>
  </section>
</template>
