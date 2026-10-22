<script setup lang="ts">
import type { LaunchStepStatus } from '../../../core/contracts/launch'
import { useOfficeLaunch } from '~/composables/office/data'
import { ago, withCount } from '~/composables/office/format'
import type { Badge } from '~/composables/office/labels'
import { linkWords, splitActions, withoutCodes } from '~/composables/office/launch'

useHead({ title: 'Запуск' })
const { data: v, status, pending, refresh } = useOfficeLaunch()

const clock = ref(new Date())
let tick: ReturnType<typeof setInterval> | undefined
onMounted(() => (tick = setInterval(() => (clock.value = new Date()), 5000)))
onBeforeUnmount(() => tick && clearInterval(tick))

const statusBadge: Record<LaunchStepStatus, Badge> = {
  done: { label: 'Готово', tone: 'ok' },
  needed: { label: 'Нужно сделать', tone: 'human' },
  blocked: { label: 'Пока нельзя', tone: 'off' },
  optional: { label: 'По желанию', tone: 'plain' },
}
const percent = computed(() =>
  v.value && v.value.total ? Math.round((v.value.done / v.value.total) * 100) : 0,
)
const headline = computed(() => {
  const x = v.value
  if (!x) return ''
  if (x.done === x.total) return 'Всё обязательное сделано: ферма может зарабатывать сама'
  return `Готовность к заработку: ${x.done} из ${x.total}`
})
const remaining = computed(() =>
  v.value
    ? v.value.groups.flatMap((g) => g.steps).filter((s) => s.required && s.status !== 'done').length
    : 0,
)
</script>
<template>
  <div class="launch">
    <div class="page-head">
      <div>
        <h1>Запуск</h1>
        <p>
          Что ещё сделать, чтобы ферма зарабатывала сама. Проверяется по данным сервера; ключи и
          пароли здесь не показываются.
        </p>
      </div>
    </div>

    <OfficeState v-if="!v" :status="status" :pending="pending" :rows="4" @retry="refresh" />
    <template v-else>
      <section class="card card-raised rise summary" aria-labelledby="launch-title">
        <div class="summary-top">
          <div>
            <span class="eyebrow">Чек-лист владельца</span>
            <h2 id="launch-title">{{ headline }}</h2>
            <p class="small muted">
              <template v-if="remaining"
                >Осталось {{ withCount(remaining, ['шаг', 'шага', 'шагов']) }} из обязательных.
              </template>
              Тренировка, Demo и тестовые оплаты не считаются доходом. Обновлено
              <ClientOnly>{{ ago(v.generatedAt, clock) }}</ClientOnly
              >.
            </p>
          </div>
          <span class="num-lg score" aria-label="Готовность"
            >{{ v.done }}<small>/{{ v.total }}</small></span
          >
        </div>
        <div
          class="bar bar-lg"
          role="progressbar"
          :aria-valuenow="v.done"
          aria-valuemin="0"
          :aria-valuemax="v.total"
          :aria-label="`Готово ${v.done} из ${v.total}`"
        >
          <i :style="{ width: `${percent}%` }" />
        </div>
        <div v-if="v.next" class="next">
          <div>
            <span class="eyebrow">Самый полезный следующий шаг</span>
            <strong>{{ v.next.title }}</strong>
            <span class="small muted">{{ v.next.state }}</span>
          </div>
          <a class="btn btn-primary" :href="`#step-${v.next.id}`">Что сделать</a>
        </div>
      </section>

      <section
        v-for="group in v.groups"
        :key="group.id"
        class="group"
        :aria-labelledby="`group-${group.id}`"
      >
        <div class="group-head">
          <h2 :id="`group-${group.id}`">{{ group.title }}</h2>
          <p class="small muted">{{ group.hint }}</p>
        </div>
        <ol class="steps-list">
          <li
            v-for="step in group.steps"
            :id="`step-${step.id}`"
            :key="step.id"
            class="card rise step"
            :class="`is-${step.status}`"
          >
            <div class="step-head">
              <h3>{{ step.title }}</h3>
              <OfficeBadge :badge="statusBadge[step.status]" />
            </div>
            <p class="state"><b>Сейчас:</b> {{ withoutCodes(step.state) }}</p>
            <p class="why"><b>Зачем:</b> {{ step.why }}</p>
            <details v-if="step.status !== 'done'" :open="step.status === 'needed'">
              <summary>Что сделать</summary>
              <template v-for="part in [splitActions(step.actions)]" :key="step.id">
                <template v-if="part.owner.length">
                  <h4 class="who">Вы</h4>
                  <ol class="actions">
                    <li v-for="action in part.owner" :key="action.text">{{ action.text }}</li>
                  </ol>
                </template>
                <template v-if="part.admin.length">
                  <h4 class="who">Администратор сервера</h4>
                  <ol class="actions">
                    <li v-for="action in part.admin" :key="action.text">{{ action.text }}</li>
                  </ol>
                  <details class="tech">
                    <summary>Подробно для администратора</summary>
                    <ul>
                      <li v-for="action in part.admin" :key="action.text">{{ action.tech }}</li>
                    </ul>
                    <p>Ключи и пароли вносятся только на сервере, не через чат.</p>
                  </details>
                </template>
              </template>
            </details>
            <div class="step-foot">
              <NuxtLink v-if="step.link" class="btn btn-sm" :to="step.link">{{
                linkWords(step.link, step.linkLabel)
              }}</NuxtLink>
              <details v-if="step.status !== 'done' && step.codes.length" class="tech">
                <summary>Техническая причина</summary>
                <span class="mono">{{ step.codes.join(', ') }}</span>
              </details>
            </div>
          </li>
        </ol>
      </section>

      <p class="small muted foot">
        Ключи, пароли и адреса вносит администратор прямо на сервере. В чат и в письма их не
        отправляйте.
      </p>
    </template>
  </div>
</template>
<style scoped>
.summary {
  display: grid;
  gap: var(--s-4);
}
.summary-top {
  display: flex;
  justify-content: space-between;
  gap: var(--s-4);
  align-items: flex-start;
}
.summary-top h2 {
  margin-top: 4px;
}
.summary-top p {
  margin: 6px 0 0;
}
.score {
  flex: none;
  font-weight: 800;
  line-height: 1;
}
.score small {
  font-size: 0.5em;
  color: var(--muted);
  font-weight: 600;
}
.bar > i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--st-ok);
  transition: width var(--dur) var(--ease);
}
.next {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--s-4);
  padding: var(--s-4);
  border-radius: var(--r-md);
  background: var(--st-human-soft);
}
.next > div {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.next strong {
  font-size: var(--text-lg);
}
.next .btn {
  flex: none;
}
.group {
  margin-top: var(--s-8);
}
.group-head p {
  margin: 4px 0 0;
  max-width: 70ch;
}
.steps-list {
  list-style: none;
  margin: var(--s-4) 0 0;
  padding: 0;
  display: grid;
  gap: var(--s-3);
}
.step {
  display: grid;
  gap: var(--s-2);
  border-left: 4px solid var(--st-wait);
}
.step.is-done {
  border-left-color: var(--st-ok);
}
.step.is-needed {
  border-left-color: var(--st-human);
}
.step.is-blocked {
  border-left-color: var(--st-off);
}
.step.is-optional {
  border-left-color: var(--line-strong);
}
.step-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--s-3);
  flex-wrap: wrap;
}
.step p {
  margin: 0;
  overflow-wrap: anywhere;
}
.state {
  color: var(--ink);
}
.why {
  color: var(--ink-2);
  font-size: var(--text-sm);
}
details summary {
  cursor: pointer;
  font-weight: 600;
  color: var(--brand);
}
.actions {
  margin: var(--s-2) 0 0;
  padding-left: 22px;
  display: grid;
  gap: 6px;
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
.who {
  margin: var(--s-3) 0 0;
  font-size: var(--text-xs);
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}
.tech {
  font-size: var(--text-xs);
  color: var(--muted);
  overflow-wrap: anywhere;
}
.tech summary {
  font-weight: 500;
  color: var(--muted);
}
.actions + .tech {
  margin-top: var(--s-2);
}
.tech ul {
  margin: 6px 0;
  padding-left: 18px;
  display: grid;
  gap: 4px;
}
.tech p {
  margin: 0;
}
.step-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--s-3);
  flex-wrap: wrap;
}
.foot {
  margin-top: var(--s-8);
}
@media (max-width: 640px) {
  .summary-top {
    flex-direction: column;
  }
  .next {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
