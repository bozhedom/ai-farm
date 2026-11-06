<script setup lang="ts">
import {
  cryptoDirections,
  workDirections,
  type WorkDirection,
} from '../../../core/contracts/work-focus'
import { useWorkFocus } from '~/composables/office/focus'
import { officeFetch } from '~/composables/office/resource'
import { useOfficeAction } from '~/composables/office/actions'
import { when } from '~/composables/office/format'
const { data, pending, status, refresh } = useWorkFocus()
const { busy, run } = useOfficeAction()
const selected = ref<WorkDirection[]>([...cryptoDirections])
const duration = ref<'manual' | 'day'>('day')
const revision = ref(0)
const dirty = ref(false)
watch(
  data,
  (v) => {
    if (!v || dirty.value) return
    selected.value = [...v.selected]
    duration.value = v.until ? 'day' : 'manual'
    revision.value = v.revision
  },
  { immediate: true },
)
async function save(enabled: boolean) {
  await run(
    'focus',
    async () => {
      await officeFetch('/api/office/focus', {
        method: 'POST',
        body: {
          enabled,
          selected: selected.value,
          duration: duration.value,
          revision: revision.value,
        },
      })
      dirty.value = false
      await refresh()
    },
    enabled
      ? 'Новые запуски разрешены только выбранным направлениям.'
      : 'Ограничение снято. Прежние настройки направлений сохранены.',
  )
}
function crypto() {
  selected.value = [...cryptoDirections]
  duration.value = 'day'
  dirty.value = true
}
</script>
<template>
  <section id="work-focus" class="card focus-card" aria-labelledby="focus-title">
    <div class="focus-heading">
      <div>
        <h2 id="focus-title">Выбор направлений</h2>
        <p class="small muted">
          Разрешите новые запуски выбранным группам. Их фактическое состояние показано выше.
        </p>
      </div>
      <button
        class="btn"
        role="switch"
        :aria-checked="data?.active ?? false"
        :disabled="!data || !!busy || !selected.length"
        @click="save(!data?.active)"
      >
        Только выбранные · {{ data?.active ? 'включено' : 'выключено' }}
      </button>
    </div>
    <OfficeState v-if="!data" :status="status" :pending="pending" @retry="refresh" />
    <template v-else>
      <p v-if="data.active" class="note note-wait" role="status">
        Ограничение действует {{ data.until ? `до ${when(data.until)}` : 'до ручного выключения' }}.
        Затем снова действуют прежние настройки направлений.
      </p>
      <div class="focus-actions">
        <button class="btn btn-sm" :disabled="!!busy" @click="crypto">
          Выбрать криптоторговлю на день
        </button>
        <div class="field focus-duration">
          <label for="focus-duration">Срок ограничения</label>
          <select id="focus-duration" v-model="duration" class="select" @change="dirty = true">
            <option value="day">24 часа с момента включения</option>
            <option value="manual">До ручного выключения</option>
          </select>
        </div>
      </div>
      <fieldset class="focus-grid" :disabled="!!busy">
        <legend class="sr-only">Разрешённые направления</legend>
        <label v-for="item in workDirections" :key="item.id" class="focus-choice">
          <input v-model="selected" type="checkbox" :value="item.id" @change="dirty = true" />
          <span
            ><strong>{{ item.name }}</strong
            ><small class="muted">{{ item.detail }}</small></span
          >
        </label>
      </fieldset>
      <button
        v-if="dirty"
        class="btn btn-primary"
        :disabled="!!busy || !selected.length"
        @click="save(true)"
      >
        Применить выбор и включить
      </button>
      <p class="small muted focus-help">
        Галочка разрешает запуск, но не подключает счёт и не снимает остановки. Принятые заказы и
        защита открытых позиций продолжаются.
      </p>
    </template>
  </section>
</template>
<style scoped>
.focus-card {
  margin-bottom: 24px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.focus-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.focus-heading p {
  margin-top: 8px;
  max-width: 620px;
}
.focus-actions {
  display: flex;
  align-items: end;
  gap: 16px 24px;
  flex-wrap: wrap;
}
.focus-duration {
  flex: 1 1 260px;
  max-width: 360px;
}
.focus-actions select {
  width: 100%;
  max-width: 100%;
}
.focus-grid {
  border: 0;
  padding: 0;
  margin: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.focus-choice {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  cursor: pointer;
}
.focus-choice:has(input:checked) {
  background: var(--canvas-deep);
  border-color: var(--ink-2);
}
.focus-choice input {
  flex: 0 0 18px;
  width: 18px;
  height: 18px;
  margin-top: 4px;
  accent-color: var(--brand);
}
.focus-choice span {
  min-width: 0;
}
.focus-choice strong {
  font-size: 14px;
}
.focus-choice small {
  display: block;
  margin-top: 4px;
}
.focus-help {
  padding-top: 16px;
  border-top: 1px solid var(--line);
}
.focus-card > .btn {
  align-self: flex-start;
}
.focus-card .btn {
  white-space: normal;
  text-align: center;
  padding: 10px 16px;
}
@media (max-width: 640px) {
  .focus-grid {
    grid-template-columns: 1fr;
  }
  .focus-heading > .btn,
  .focus-actions > .btn,
  .focus-duration {
    width: 100%;
    max-width: none;
  }
}
</style>
