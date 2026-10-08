<script setup lang="ts">
const { state: d, failure } = useFarm()
defineProps<{ busy: boolean }>()
const emit = defineEmits<{ control: [action: string] }>()
function changeScope(event: Event) {
  const select = event.target as HTMLSelectElement
  const next = select.value
  select.value = d.value.state.research_scope || 'rotate'
  emit('control', 'research_scope:' + next)
}
</script>

<template>
  <section class="panel" aria-label="Автономная работа">
    <div class="section-heading">
      <h2>Автономная работа</h2>
      <span class="tag">{{
        failure
          ? 'Связь потеряна'
          : d.autonomy.workerAlive
            ? 'Сервер работает'
            : 'Нет сигнала обработчика'
      }}</span>
    </div>
    <p>
      {{
        failure
          ? 'Состояние не обновляется. Показаны последние полученные данные.'
          : d.autonomy.reason
      }}
    </p>
    <div class="two-columns">
      <div>
        <h3>Исследования раз в сутки</h3>
        <p>Разведчики ищут, критик проверяет, лучшее идёт на сайт.</p>
        <label for="research-scope">Что исследовать по расписанию</label>
        <select
          id="research-scope"
          :value="d.state.research_scope || 'rotate'"
          :disabled="busy || !!failure"
          @change="changeScope"
        >
          <option value="rotate">Одно направление, по очереди</option>
          <option value="all">Все направления, последовательно</option>
        </select>
        <p class="muted small-text">
          Влияет на будущие суточные запуски. Полный обход проверяет все
          {{ d.serviceCatalog.length }} направлений в пределах общего бюджета, с приоритетом
          заказов. Выключение расписания приостанавливает ещё не начатые автоматические
          исследования.
        </p>
        <p>
          <strong>Следующий запуск: </strong
          >{{ !failure && d.autonomy.nextAt ? dateTime(d.autonomy.nextAt) : 'Не назначен' }}
        </p>
        <p v-if="d.autonomy.lastScheduledRun">
          <strong>Последний автоматический запуск: </strong
          >{{ dateTime(d.autonomy.lastScheduledRun.created_at) }} ·
          {{ labels[d.autonomy.lastScheduledRun.status]
          }}<span v-if="d.autonomy.lastScheduledRun.error_code">
            ·
            {{
              errorText({ data: { statusMessage: d.autonomy.lastScheduledRun.error_code } })
            }}</span
          >
        </p>
        <p v-else>Автоматических запусков в этой базе ещё не было.</p>
        <button
          class="button secondary small"
          :disabled="busy || !!failure || !d.autonomy.allowed"
          @click="emit('control', d.autonomy.enabled ? 'schedule_off' : 'schedule_on')"
        >
          {{ d.autonomy.enabled ? 'Выключить расписание' : 'Включить расписание' }}
        </button>
        <p v-if="!d.autonomy.allowed" class="muted small-text">
          Автозапуск отключён в настройках сервера по решению владельца. Кнопка «Продолжить»
          разрешает только ручные исследования.
        </p>
      </div>
      <div>
        <h3>Заказы · по мере оплаты</h3>
        <p>{{ d.autonomy.ordersReason }}</p>
        <p>
          Ждут исполнения: <strong>{{ d.autonomy.pendingOrders }}</strong
          >. Требуют проверки владельцем: <strong>{{ d.autonomy.reviewOrders }}</strong
          >.
        </p>
        <NuxtLink v-if="d.autonomy.reviewOrders" to="/office?view=orders"
          >Посмотреть остановленные заказы</NuxtLink
        >
        <p class="muted small-text">
          Недельная оценка не вызывает модель. Без настоящих продаж система ждёт данных. Копии базы
          создаются ежедневно на сервере.
        </p>
        <p class="muted small-text">
          Лимиты общие для всех заданий. Облачный ответ может быть остановлен до запроса, если не
          помещается его максимальный резерв. Внешние уведомления пока не подключены.
        </p>
      </div>
    </div>
  </section>
</template>
