<script setup lang="ts">
import type { OfficeLead } from '../../../core/contracts/office'
import { copyText, officeApi, useOfficeAction, useOfficeToast } from '~/composables/office/actions'
import { useAutoProposals, useOfficeLeads } from '~/composables/office/data'
import { leadSkipCodes, lowerFirst, reasonText } from '~/composables/office/errors'
import { ago, domain, withCount } from '~/composables/office/format'
import { leadBadge, templateLabel } from '~/composables/office/labels'

useHead({ title: 'Клиенты' })
const auto = useAutoProposals()
const { data, status, pending, refresh, more } = useOfficeLeads()
const { busy, run } = useOfficeAction()
const { show } = useOfficeToast()

type Filter = 'new' | 'contacted' | 'dismissed' | 'all'
const filter = ref<Filter>('new')
// `?product=<id>` comes from the idea and product pages.
const route = useRoute()
const product = ref(typeof route.query.product === 'string' ? route.query.product : '')
const hasDemo = computed(() => all.value.some((lead) => lead.isDemo))
function searchMore() {
  void run('search', () => officeApi.searchLeads(), 'Ищем новые запросы. Они появятся здесь.')
}
const all = computed(() => data.value?.items || [])
const isNew = (lead: OfficeLead) => lead.stage === 'new' || lead.stage === 'saved'
const counts = computed(() => ({
  new: all.value.filter(isNew).length,
  contacted: all.value.filter((l) => l.stage === 'contacted' || l.stage === 'won').length,
  dismissed: all.value.filter((l) => l.stage === 'dismissed').length,
}))
const products = computed(() => {
  const map = new Map<string, string>()
  for (const lead of all.value) if (lead.product) map.set(lead.product.id, lead.product.name)
  return [...map.entries()]
})
const items = computed(() =>
  all.value.filter((lead) => {
    if (product.value && lead.product?.id !== product.value) return false
    if (filter.value === 'new') return isNew(lead)
    if (filter.value === 'contacted') return lead.stage === 'contacted' || lead.stage === 'won'
    if (filter.value === 'dismissed') return lead.stage === 'dismissed'
    return true
  }),
)
const copied = ref<string | null>(null)
async function copyReply(lead: OfficeLead) {
  if (!lead.replyDraft) return
  if (await copyText(lead.replyDraft)) {
    copied.value = lead.id
    show('Отклик скопирован. Вставьте его в ответ на площадке.')
    setTimeout(() => copied.value === lead.id && (copied.value = null), 2500)
  } else show('Не получилось скопировать. Выделите текст вручную.', 'err')
}
function setStage(lead: OfficeLead, stage: string, text: string) {
  void run(`stage:${lead.id}`, () => officeApi.updateLead(lead.id, stage, lead.note || ''), text)
}
function redraft(lead: OfficeLead) {
  void run(
    `draft:${lead.id}`,
    () => officeApi.redraftLead(lead.id),
    'Готовим новый отклик, это займёт минуту.',
  )
}
const subtitle = computed(() => {
  if (!data.value) return 'Люди, которым уже сейчас нужна такая услуга.'
  if (!data.value.total) return 'Запросов пока нет.'
  const fresh = all.value.filter(isNew)
  const ready = fresh.filter((lead) => lead.replyDraft).length
  const waiting = fresh.length - ready
  if (!fresh.length)
    return `${withCount(data.value.total, ['запрос', 'запроса', 'запросов'])}. Новых нет.`
  return `${withCount(data.value.total, ['запрос', 'запроса', 'запросов'])}. Отклик готов у ${ready}${waiting ? `, без отклика ${waiting}` : ''}.`
})
</script>
<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Клиенты</h1>
        <p>
          {{ subtitle }}
          <span v-if="hasDemo" class="badge badge-plain demo-note">Данные демо-провайдера</span>
        </p>
      </div>
      <button type="button" class="btn" :disabled="!!busy" @click="searchMore">
        <OfficeIcon name="search" size="sm" />{{ busy === 'search' ? 'Ищем' : 'Поискать ещё' }}
      </button>
    </div>
    <p class="note rule">
      <OfficeIcon name="clients" size="sm" />{{
        auto?.on
          ? 'Этим клиентам пишете вы: на сайте и в почте ферма никому не пишет. На площадках, где вы вошли, ИИ откликается сам.'
          : 'Отправляете вы. Ферма никому не пишет.'
      }}
    </p>

    <div v-if="all.length" class="toolbar">
      <div class="chips" aria-label="Показать">
        <button
          type="button"
          class="chip"
          :class="{ 'is-active': filter === 'new' }"
          @click="filter = 'new'"
        >
          Новые <span class="n">{{ counts.new }}</span>
        </button>
        <button
          type="button"
          class="chip"
          :class="{ 'is-active': filter === 'contacted' }"
          @click="filter = 'contacted'"
        >
          Отправлено <span class="n">{{ counts.contacted }}</span>
        </button>
        <button
          type="button"
          class="chip"
          :class="{ 'is-active': filter === 'dismissed' }"
          @click="filter = 'dismissed'"
        >
          Не подходят <span class="n">{{ counts.dismissed }}</span>
        </button>
        <button
          type="button"
          class="chip"
          :class="{ 'is-active': filter === 'all' }"
          @click="filter = 'all'"
        >
          Все <span class="n">{{ all.length }}</span>
        </button>
      </div>
      <select
        v-if="products.length > 1 || product"
        v-model="product"
        class="select"
        aria-label="Продукт"
      >
        <option value="">Все продукты</option>
        <option v-for="[pid, name] in products" :key="pid" :value="pid">{{ name }}</option>
      </select>
    </div>

    <OfficeState v-if="!data" :status="status" :pending="pending" @retry="refresh" />
    <OfficeEmpty
      v-else-if="!data.total"
      icon="clients"
      title="Запросов пока нет"
      text="Ферма ищет публичные запросы по продуктам на сайте. Новые появятся здесь."
    />
    <OfficeEmpty
      v-else-if="!items.length"
      icon="check"
      :title="filter === 'new' ? 'Новых запросов нет' : 'Здесь пусто'"
      :text="filter === 'new' ? 'Все отклики разобраны.' : undefined"
    />
    <div v-else class="leads">
      <article
        v-for="lead in items"
        :key="lead.id"
        class="card lead rise"
        :class="{ 'is-done': lead.stage === 'dismissed', 'is-sent': lead.stage === 'contacted' }"
      >
        <div class="ask">
          <div class="src">
            <OfficeBadge :badge="leadBadge(lead.stage)" />
            <span class="where">{{ domain(lead.url) }}</span>
            <span>{{ ago(lead.lastSeenAt || lead.firstSeenAt) }}</span>
          </div>
          <h3>{{ lead.title }}</h3>
          <p class="quote">{{ lead.snippet }}</p>
          <span class="product-tag"
            ><OfficeIcon name="box" size="sm" />{{
              lead.product?.name || templateLabel(lead.template)
            }}</span
          >
          <p v-if="lead.note" class="small muted note-line">Заметка: {{ lead.note }}</p>
        </div>
        <div class="answer">
          <div class="reply-head">
            <span class="eyebrow">Отклик</span>
          </div>
          <div v-if="lead.replyDraft" class="reply">{{ lead.replyDraft }}</div>
          <p v-else-if="lead.replyError && leadSkipCodes.has(lead.replyError)" class="reply muted">
            Отклик не готовим: {{ lowerFirst(reasonText(lead.replyError)) }}
          </p>
          <p v-else-if="lead.replyError" class="reply reply-err">
            Отклик не получился: {{ lowerFirst(reasonText(lead.replyError)) }}
          </p>
          <p v-else class="reply muted">
            Отклика пока нет: за день ферма готовит несколько откликов, остальные по кнопке.
          </p>
          <div class="actions">
            <button
              v-if="!lead.replyDraft && isNew(lead)"
              type="button"
              class="btn btn-sm"
              :class="{ 'btn-primary': !leadSkipCodes.has(lead.replyError || '') }"
              :disabled="!!busy"
              @click="redraft(lead)"
            >
              {{ busy === `draft:${lead.id}` ? 'Готовим' : 'Подготовить отклик' }}
            </button>
            <button
              v-if="lead.replyDraft"
              type="button"
              class="btn btn-primary btn-sm"
              @click="copyReply(lead)"
            >
              <OfficeIcon :name="copied === lead.id ? 'check' : 'copy'" size="sm" />{{
                copied === lead.id ? 'Скопировано' : 'Скопировать отклик'
              }}
            </button>
            <a
              class="btn btn-sm"
              :href="lead.url"
              target="_blank"
              rel="noopener noreferrer nofollow"
              ><OfficeIcon name="external" size="sm" />Открыть заявку</a
            >
          </div>
          <div class="quiet">
            <template v-if="isNew(lead)">
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="!!busy"
                @click="setStage(lead, 'contacted', 'Отмечено: отклик отправлен.')"
              >
                Отправил
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="!!busy"
                @click="setStage(lead, 'dismissed', 'Запрос убран в «Не подходят».')"
              >
                Не подходит
              </button>
            </template>
            <button
              v-else
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="!!busy"
              @click="setStage(lead, 'new', 'Запрос вернулся в новые.')"
            >
              Вернуть в новые
            </button>
            <button
              v-if="isNew(lead) && lead.replyDraft"
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="!!busy"
              @click="redraft(lead)"
            >
              <OfficeIcon name="refresh" size="sm" />{{
                busy === `draft:${lead.id}` ? 'Готовим' : 'Подготовить отклик заново'
              }}
            </button>
          </div>
        </div>
      </article>
    </div>
    <p v-if="data?.hasMore" class="more small">
      <button type="button" class="link-btn" @click="more">Показать ещё</button>
    </p>
  </div>
</template>
<style scoped>
.demo-note {
  margin-left: 6px;
  vertical-align: 1px;
}
.rule {
  margin-bottom: var(--s-5);
  width: fit-content;
  max-width: 100%;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-3);
  align-items: center;
  margin-bottom: var(--s-4);
}
.toolbar .select {
  width: auto;
  min-width: 220px;
  margin-left: auto;
}
.leads {
  display: grid;
  gap: var(--s-4);
}
.lead {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
  gap: var(--s-6);
}
.lead.is-done {
  opacity: 0.65;
}
.src {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--text-sm);
  color: var(--muted);
  flex-wrap: wrap;
}
.where {
  color: var(--ink-2);
  font-weight: 600;
}
.lead h3 {
  margin-top: 8px;
  font-size: var(--text-lg);
}
.lead .quote {
  margin: 10px 0 12px;
}
.product-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--brand-ink);
  background: var(--brand-soft);
  border-radius: var(--r-pill);
  padding: 3px 10px;
}
.note-line {
  margin-top: var(--s-2);
}
.reply-head {
  margin-bottom: 8px;
}
.reply {
  background: var(--surface-2);
  border-radius: var(--r-md);
  padding: var(--s-4);
  font-size: var(--text-sm);
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 0;
}
.reply-err {
  background: var(--st-err-soft);
  color: var(--st-err-ink);
}
.actions {
  display: flex;
  gap: var(--s-2);
  margin-top: var(--s-3);
  flex-wrap: wrap;
}
.quiet {
  display: flex;
  flex-wrap: wrap;
  gap: 2px var(--s-1);
  margin: var(--s-2) 0 0 calc(-1 * var(--s-3));
}
.more {
  margin-top: var(--s-3);
}
.link-btn {
  border: 0;
  background: none;
  padding: 0;
  color: var(--brand);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
@media (max-width: 1023px) {
  .lead {
    grid-template-columns: 1fr;
    gap: var(--s-4);
  }
  .toolbar .select {
    margin-left: 0;
    width: 100%;
  }
}
</style>
