<script setup lang="ts">
const { state: d, failure } = useFarm()
defineProps<{ busy: boolean }>()
const emit = defineEmits<{ control: [action: string] }>()
</script>

<template>
  <section class="panel" aria-label="Автономная работа">
    <div class="section-heading">
      <h2>Автономная работа</h2>
      <span class="tag">{{
        failure
          ? 'Связь потеряна'
          : d.autonomy.workerAlive
            ? 'Обработчик на связи'
            : 'Нет сигнала обработчика'
      }}</span>
    </div>
    <p>
      {{
        failure
          ? 'Состояние не обновляется. Ниже — последние полученные данные.'
          : d.autonomy.reason
      }}
    </p>
    <div class="two-columns">
      <div>
        <h3>Исследования · раз в сутки</h3>
        <p>
          Поиск → гипотеза → критик → сборка → контрольный пример. Прошедшая проверку версия
          появляется в витрине автоматически.
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
            · {{ d.autonomy.lastScheduledRun.error_code }}</span
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
        <NuxtLink v-if="d.autonomy.reviewOrders" to="/?view=orders"
          >Посмотреть остановленные заказы ↗</NuxtLink
        >
        <p class="muted small-text">
          Недельная оценка не вызывает модель. Без настоящих продаж — HOLD. Копии базы создаются
          ежедневно на сервере.
        </p>
        <p class="muted small-text">
          Лимиты общие для всех заданий. Облачный ответ может быть остановлен до запроса, если не
          помещается его максимальный резерв. Внешние уведомления пока не подключены.
        </p>
      </div>
    </div>
  </section>
</template>
