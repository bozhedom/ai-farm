<script setup lang="ts">
import type { IdeaStatus } from '../../../../core/contracts/office'
import { officeApi, useOfficeAction } from '~/composables/office/actions'
import { useOfficeIdea } from '~/composables/office/data'
import { reasonText } from '~/composables/office/errors'
import { when } from '~/composables/office/format'
import {
  ideaStatus,
  launchBadge,
  takenBadge,
  templateLabel,
  verdict,
} from '~/composables/office/labels'

const route = useRoute()
const id = computed(() => String(route.params.id))
const { data: idea, status, pending, refresh } = useOfficeIdea(id)
useHead({ title: computed(() => idea.value?.title || 'Идея') })

const note = ref('')
const noteDirty = ref(false)
watch(
  () => idea.value?.ownerNote,
  (value) => {
    if (!noteDirty.value) note.value = value || ''
  },
  { immediate: true },
)
const { busy, run } = useOfficeAction()
async function saveNote() {
  const done = await run(
    'note',
    () => officeApi.saveIdea(id.value, { ownerNote: note.value.trim() }),
    'Заметка сохранена.',
  )
  if (done !== undefined) noteDirty.value = false
}
function setStatus(next: IdeaStatus, text: string) {
  void run('status', () => officeApi.saveIdea(id.value, { status: next }), text)
}
function setTaken(taken: boolean) {
  void run(
    'take',
    () => officeApi.saveIdea(id.value, { ownerStatus: taken ? 'taken' : null }),
    taken ? 'Идея в работе у вас. Она в фильтре «В работе у меня».' : 'Идея вернулась в рейтинг.',
  )
}
function hideProduct() {
  const product = idea.value?.product
  if (!product) return
  void run(
    'hide',
    () => officeApi.setVisibility(product.id, 'private'),
    'Продукт снят с продажи. Вернуть можно в разделе «Продукты».',
  )
}
const verdictCard = computed(() => (idea.value ? verdict[idea.value.critique.verdict] : null))
const checkStatus: Record<string, string> = {
  accepted: 'Прошла проверку',
  running: 'Делаем',
  queued: 'В очереди',
  backlog: 'Отложена',
  rejected: 'Не прошла',
  failed: 'Сбой',
}
</script>
<template>
  <div>
    <NuxtLink class="back" to="/office/ideas"
      ><OfficeIcon name="back" size="sm" />Все идеи</NuxtLink
    >
    <OfficeState v-if="!idea" :status="status" :pending="pending" @retry="refresh">
      <template #missing>
        <NuxtLink class="btn btn-sm" to="/office/ideas">К списку идей</NuxtLink>
      </template>
    </OfficeState>
    <template v-else>
      <div class="page-head">
        <div class="head-main">
          <h1>{{ idea.title }}</h1>
          <p>
            {{ idea.category }}. {{ idea.topic }}. Нашёл {{ idea.agent.name }},
            {{ when(idea.createdAt) }}.
          </p>
          <div class="row badges">
            <OfficeBadge :badge="ideaStatus[idea.status]" />
            <OfficeBadge :badge="launchBadge(idea)" :dot="!idea.farmExecutable" />
            <OfficeBadge v-if="idea.ownerStatus === 'taken'" :badge="takenBadge" />
            <span v-if="idea.duplicateOf" class="badge badge-off">Повтор старой идеи</span>
            <span v-if="idea.isDemo" class="badge badge-plain">Данные демо-провайдера</span>
          </div>
        </div>
        <div class="big-score" :aria-label="`Балл ${idea.rankScore} из 100`">
          <span class="num num-xl">{{ idea.rankScore }}</span>
          <span class="muted small">балл из 100</span>
        </div>
      </div>

      <section
        class="card verdict-card rise"
        :class="`is-${verdictCard?.tone}`"
        aria-label="Вердикт критика"
      >
        <strong>{{ verdictCard?.title }}</strong>
        <p>{{ idea.critique.reason }}</p>
      </section>

      <OfficeIdeaFacts :idea="idea" full class="facts-block" />

      <div class="cols">
        <section v-if="idea.farmExecutable" class="card rise">
          <h2>Как сделает ферма</h2>
          <p class="lead-text">{{ idea.research.executionNote }}</p>
          <p v-if="idea.suggestedTemplate" class="muted small">
            Тип услуги: {{ templateLabel(idea.suggestedTemplate) }}
          </p>
          <div v-if="idea.product" class="row product-actions">
            <a
              v-if="idea.product.visibility === 'public' && idea.product.status === 'sandbox'"
              class="btn btn-primary btn-sm"
              :href="idea.product.publicUrl"
              target="_blank"
              rel="noopener"
              ><OfficeIcon name="external" size="sm" />Открыть на сайте</a
            >
            <NuxtLink class="btn btn-sm" :to="`/office/leads?product=${idea.product.id}`"
              >Запросы клиентов</NuxtLink
            >
            <NuxtLink
              class="btn btn-ghost btn-sm"
              :to="`/office/products#product-${idea.product.id}`"
              >Открыть продукт</NuxtLink
            >
            <button
              v-if="idea.product.visibility === 'public'"
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="!!busy"
              @click="hideProduct"
            >
              Снять с продажи
            </button>
          </div>
          <h3 class="sub">Проверка примера</h3>
          <ul v-if="idea.checks.length" class="checks">
            <li v-for="check in idea.checks" :key="check.hypothesisId">
              <span
                class="badge"
                :class="
                  check.status === 'accepted'
                    ? 'badge-ok'
                    : check.status === 'rejected' || check.status === 'failed'
                      ? 'badge-err'
                      : 'badge-wait'
                "
                >{{ checkStatus[check.status] || check.status }}</span
              >
              <div>
                <p>{{ reasonText(check.critique) }}</p>
                <NuxtLink
                  v-if="check.productId"
                  :to="`/office/products#product-${check.productId}`"
                  class="small"
                  >Открыть продукт</NuxtLink
                >
              </div>
            </li>
          </ul>
          <p v-else class="muted">Ещё не собирали. Руководитель решит после дневного отчёта.</p>
        </section>
        <section v-else class="card card-tint-clay rise">
          <h2>План запуска</h2>
          <p v-if="idea.ownerStatus === 'taken'" class="small">
            Идея в работе у вас. Ферма не запускает её сама, план ниже.
          </p>
          <p v-else class="small">Ферма это не сделает: нужны люди. Вот с чего начать самому.</p>
          <ol v-if="idea.research.launchPlanForHuman.length" class="plan">
            <li v-for="(step, i) in idea.research.launchPlanForHuman" :key="i">{{ step }}</li>
          </ol>
          <p v-else class="muted">План ещё не готов.</p>
          <div class="row actions">
            <button
              v-if="idea.status === 'needs_human' && idea.ownerStatus !== 'taken'"
              type="button"
              class="btn btn-primary btn-sm"
              :disabled="!!busy"
              @click="setTaken(true)"
            >
              {{ busy === 'take' ? 'Берём' : 'Взять в работу' }}
            </button>
            <button
              v-if="idea.ownerStatus === 'taken'"
              type="button"
              class="btn btn-sm"
              :disabled="!!busy"
              @click="setTaken(false)"
            >
              Вернуть в рейтинг
            </button>
            <button
              v-if="idea.status === 'needs_human'"
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="!!busy"
              @click="setStatus('rejected', 'Идея убрана из рейтинга.')"
            >
              Не беру
            </button>
            <button
              v-else-if="idea.status === 'rejected'"
              type="button"
              class="btn btn-sm"
              :disabled="!!busy"
              @click="setStatus('needs_human', 'Идея вернулась в рейтинг.')"
            >
              Вернуть в рейтинг
            </button>
          </div>
        </section>

        <section class="card rise">
          <h2>Ваша заметка</h2>
          <form class="stack-sm" @submit.prevent="saveNote">
            <label class="sr-only" for="owner-note">Заметка</label>
            <textarea
              id="owner-note"
              v-model="note"
              class="textarea"
              rows="5"
              maxlength="2000"
              placeholder="Например: проверить цену у конкурентов"
              @input="noteDirty = true"
            />
            <div class="row">
              <button class="btn btn-sm" :disabled="!!busy || !noteDirty">
                {{ busy === 'note' ? 'Сохраняем' : 'Сохранить заметку' }}
              </button>
            </div>
          </form>
        </section>
      </div>
    </template>
  </div>
</template>
<style scoped>
.back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-bottom: var(--s-4);
  font-weight: 600;
  font-size: var(--text-sm);
}
.head-main {
  min-width: 0;
}
.head-main h1 {
  overflow-wrap: anywhere;
}
.badges {
  margin-top: var(--s-3);
  flex-wrap: wrap;
}
.big-score {
  display: grid;
  justify-items: end;
  flex: none;
}
.verdict-card {
  border-left: 4px solid var(--st-off);
  margin-bottom: var(--s-4);
}
.verdict-card.is-ok {
  border-left-color: var(--st-ok);
}
.verdict-card.is-wait {
  border-left-color: var(--st-wait);
}
.verdict-card.is-err {
  border-left-color: var(--st-err);
}
.verdict-card p {
  margin-top: 4px;
}
.facts-block {
  margin-bottom: var(--s-5);
}
.cols {
  display: grid;
  grid-template-columns: 1.4fr 1fr;
  gap: var(--s-5);
  align-items: start;
}
.cols h2 {
  margin-bottom: var(--s-3);
}
.sub {
  margin: var(--s-5) 0 var(--s-3);
  font-size: var(--text-md);
}
.checks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--s-3);
}
.checks li {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--s-3);
  align-items: start;
}
.product-actions {
  flex-wrap: wrap;
  margin-top: var(--s-4);
}
.plan {
  margin: var(--s-3) 0 0;
  padding-left: 20px;
  line-height: 1.7;
}
.actions {
  margin-top: var(--s-4);
}
@media (max-width: 1023px) {
  .cols {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 639px) {
  .big-score {
    justify-items: start;
    grid-auto-flow: column;
    align-items: baseline;
    gap: 8px;
    justify-content: start;
  }
  .checks li {
    grid-template-columns: 1fr;
  }
}
</style>
