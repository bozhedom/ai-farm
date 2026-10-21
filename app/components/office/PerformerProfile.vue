<script setup lang="ts">
import type { PerformerProfile, ProfileView } from '../../../core/computer-use/profile'
import { useOfficeAction } from '~/composables/office/actions'
import { when } from '~/composables/office/format'
import { officeFetch } from '~/composables/office/resource'

/**
 * The owner's performer profile. The model writes proposals in first person and may use only
 * facts from here; the server refuses a price below the minimum. Amounts are typed in whole
 * units with up to two decimals and stored as integer minor units (kopecks, cents).
 */
type RateRow = { service: string; amount: string; currency: string; unit: string }
type MinimumRow = { amount: string; currency: string }
type SampleRow = { title: string; text: string; url: string }

const view = ref<ProfileView | null>(null)
const loadError = ref('')
const formError = ref('')
const { busy, run } = useOfficeAction()

const displayName = ref('')
const bio = ref('')
const skills = ref('')
const languages = ref('')
const rates = ref<RateRow[]>([])
const minimums = ref<MinimumRow[]>([])
const maxActiveJobs = ref('')
const proposalsPerDay = ref('')
const turnaround = ref('')
const avoidTopics = ref('')
const toneNotes = ref('')
const samples = ref<SampleRow[]>([])
const timezone = ref('')
const availability = ref('')

const limits = computed(() => view.value?.limits)
const empty = computed(() => {
  const p = view.value?.profile
  return !p || JSON.stringify(p) === JSON.stringify(emptyShape)
})
const emptyShape: PerformerProfile = {
  displayName: '',
  bio: '',
  skills: [],
  languages: [],
  rates: [],
  minimumPrices: [],
  maxActiveJobs: null,
  proposalsPerDay: null,
  turnaround: '',
  avoidTopics: [],
  toneNotes: '',
  samples: [],
  timezone: '',
  availability: '',
}

/** "1500", "1 500,50" -> 150050; integer arithmetic only, never a float. */
function toMinor(value: string): number | null {
  const text = value.replace(/[\s  ]/g, '')
  const match = /^(\d{1,10})(?:[.,](\d{1,2}))?$/.exec(text)
  if (!match) return null
  return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'))
}
function fromMinor(minor: number) {
  const cents = minor % 100
  return `${Math.floor(minor / 100)}${cents ? `,${String(cents).padStart(2, '0')}` : ''}`
}
const lines = (text: string) =>
  text
    .split(/\n|,|;/)
    .map((v) => v.trim())
    .filter(Boolean)
const whole = (text: string) => (text.trim() ? Number(text.trim()) : null)

function fill(p: PerformerProfile) {
  displayName.value = p.displayName
  bio.value = p.bio
  skills.value = p.skills.join('\n')
  languages.value = p.languages.join(', ')
  rates.value = p.rates.map((r) => ({ ...r, amount: fromMinor(r.amount) }))
  minimums.value = p.minimumPrices.map((m) => ({ ...m, amount: fromMinor(m.amount) }))
  maxActiveJobs.value = p.maxActiveJobs === null ? '' : String(p.maxActiveJobs)
  proposalsPerDay.value = p.proposalsPerDay === null ? '' : String(p.proposalsPerDay)
  turnaround.value = p.turnaround
  avoidTopics.value = p.avoidTopics.join('\n')
  toneNotes.value = p.toneNotes
  samples.value = p.samples.map((s) => ({ ...s }))
  timezone.value = p.timezone
  availability.value = p.availability
}

async function load() {
  try {
    view.value = await officeFetch<ProfileView>('/api/computer-use/profile')
    fill(view.value.profile)
    loadError.value = ''
  } catch {
    loadError.value = 'Профиль не загрузился. Обновите страницу.'
  }
}
onMounted(load)

/** Client-side shape check for clear messages; the server validates everything again. */
function collect(): PerformerProfile | string {
  const rateRows: PerformerProfile['rates'] = []
  for (const r of rates.value) {
    if (!r.service.trim() && !r.amount.trim()) continue
    const amount = toMinor(r.amount)
    if (!r.service.trim()) return 'У каждой ставки нужна услуга.'
    if (!amount) return `Ставка «${r.service}»: сумма числом, например 1500 или 1500,50.`
    if (!/^[A-Za-z]{3}$/.test(r.currency.trim()))
      return `Ставка «${r.service}»: валюта тремя буквами, например RUB или USD.`
    rateRows.push({
      service: r.service.trim(),
      amount,
      currency: r.currency.trim().toUpperCase(),
      unit: r.unit.trim(),
    })
  }
  const minimumRows: PerformerProfile['minimumPrices'] = []
  for (const m of minimums.value) {
    if (!m.amount.trim() && !m.currency.trim()) continue
    const amount = toMinor(m.amount)
    if (!amount) return 'Минимальная цена: сумма числом, например 1000.'
    if (!/^[A-Za-z]{3}$/.test(m.currency.trim()))
      return 'Минимальная цена: валюта тремя буквами, например RUB.'
    const currency = m.currency.trim().toUpperCase()
    if (minimumRows.some((x) => x.currency === currency))
      return `Минимальная цена в ${currency} указана дважды.`
    minimumRows.push({ amount, currency })
  }
  const sampleRows = samples.value
    .map((s) => ({ title: s.title.trim(), text: s.text.trim(), url: s.url.trim() }))
    .filter((s) => s.title || s.text || s.url)
  for (const s of sampleRows) {
    if (s.title.length < 4) return 'У каждого примера нужно название от 4 символов.'
    if (!s.text && !s.url) return `Пример «${s.title}»: добавьте текст или ссылку.`
    if (s.url && !/^https?:\/\//i.test(s.url))
      return `Пример «${s.title}»: ссылка должна начинаться с https://.`
  }
  const active = whole(maxActiveJobs.value)
  if (active !== null && !(Number.isInteger(active) && active >= 1 && active <= 50))
    return 'Активных заказов: целое число от 1 до 50 или пусто.'
  const perDay = whole(proposalsPerDay.value)
  const cap = limits.value?.proposalsPerDay ?? 100
  if (perDay !== null && !(Number.isInteger(perDay) && perDay >= 1 && perDay <= cap))
    return `Откликов в сутки: целое число от 1 до ${cap} (лимит сервера) или пусто.`
  return {
    displayName: displayName.value.trim(),
    bio: bio.value.trim(),
    skills: lines(skills.value),
    languages: lines(languages.value),
    rates: rateRows,
    minimumPrices: minimumRows,
    maxActiveJobs: active,
    proposalsPerDay: perDay,
    turnaround: turnaround.value.trim(),
    avoidTopics: lines(avoidTopics.value),
    toneNotes: toneNotes.value.trim(),
    samples: sampleRows,
    timezone: timezone.value.trim(),
    availability: availability.value.trim(),
  }
}

async function save() {
  formError.value = ''
  const profile = collect()
  if (typeof profile === 'string') {
    formError.value = profile
    return
  }
  const result = await run(
    'performer-profile',
    () =>
      officeFetch<ProfileView>('/api/computer-use/profile', {
        method: 'PUT',
        body: { profile },
      }),
    'Профиль исполнителя сохранён.',
  )
  if (result) {
    view.value = result
    fill(result.profile)
  }
}
const addRate = () => rates.value.push({ service: '', amount: '', currency: 'RUB', unit: '' })
const addMinimum = () => minimums.value.push({ amount: '', currency: 'RUB' })
const addSample = () => samples.value.push({ title: '', text: '', url: '' })
</script>
<template>
  <section class="card rise profile" aria-labelledby="computer-profile">
    <div class="card-head">
      <h2 id="computer-profile">Профиль исполнителя</h2>
      <span v-if="view?.updatedAt" class="small muted">обновлён {{ when(view.updatedAt) }}</span>
    </div>
    <p class="small muted">
      Модель пишет отклики от вашего имени и берёт факты о вас только отсюда. Пишите только правду:
      то, что вы готовы подтвердить заказчику. Сервер не пропустит отклик с ценой ниже минимальной.
    </p>
    <p v-if="loadError" class="small hint-err">{{ loadError }}</p>
    <p v-else-if="view && empty" class="note note-wait small">
      Профиль пуст: модель пишет отклики общими словами, без опыта и примеров, а задания, где нужен
      опыт или портфолио, оставляет вам.
    </p>
    <form v-if="view" class="profile-form" @submit.prevent="save">
      <div class="grid">
        <div class="field">
          <label for="profile-name">Имя, как на площадках</label>
          <input
            id="profile-name"
            v-model="displayName"
            class="input"
            :maxlength="limits?.displayName"
            placeholder="Например: Анна К."
          />
          <p class="hint">Необязательно. Модель подпишет отклик этим именем.</p>
        </div>
        <div class="field">
          <label for="profile-languages">Рабочие языки</label>
          <input
            id="profile-languages"
            v-model="languages"
            class="input"
            placeholder="русский, английский (B2)"
          />
          <p class="hint">Через запятую, до {{ limits?.languages }}.</p>
        </div>
      </div>

      <div class="field">
        <label for="profile-bio">Коротко о себе</label>
        <textarea
          id="profile-bio"
          v-model="bio"
          class="textarea"
          rows="4"
          :maxlength="limits?.bio"
          placeholder="Например: Пишу описания товаров и статьи для интернет-магазинов с 2021 года. Есть профильное образование: филолог."
        />
        <p class="hint">
          {{ bio.length }} из {{ limits?.bio }} знаков. Только правда: опыт, образование и примеры
          модель повторит дословно. Без контактов, ссылок и обещаний «пишу без ИИ».
        </p>
      </div>

      <div class="grid">
        <div class="field">
          <label for="profile-skills">Навыки и услуги</label>
          <textarea
            id="profile-skills"
            v-model="skills"
            class="textarea short"
            rows="4"
            placeholder="Описания товаров&#10;Редактура и корректура&#10;Перевод с английского"
          />
          <p class="hint">По одному в строке, до {{ limits?.skills }}.</p>
        </div>
        <div class="field">
          <label for="profile-avoid">Темы, которые не берём</label>
          <textarea
            id="profile-avoid"
            v-model="avoidTopics"
            class="textarea short"
            rows="4"
            placeholder="Медицина&#10;Криптовалюты&#10;Тексты для взрослых"
          />
          <p class="hint">По одной в строке. Такие задания модель пропускает.</p>
        </div>
      </div>

      <fieldset class="group">
        <legend>Ставки по услугам</legend>
        <p class="hint small muted">
          Сумма в рублях или другой валюте, например 500 или 1500,50. Модель называет цену по этим
          ставкам.
        </p>
        <div v-for="(rate, i) in rates" :key="`rate-${i}`" class="line rate">
          <input
            v-model="rate.service"
            class="input"
            :aria-label="`Услуга ${i + 1}`"
            placeholder="Описание товара"
          />
          <input
            v-model="rate.amount"
            class="input"
            inputmode="decimal"
            :aria-label="`Сумма ставки ${i + 1}`"
            placeholder="500"
          />
          <input
            v-model="rate.currency"
            class="input cur"
            maxlength="3"
            :aria-label="`Валюта ставки ${i + 1}`"
            placeholder="RUB"
          />
          <input
            v-model="rate.unit"
            class="input"
            :aria-label="`За что ставка ${i + 1}`"
            placeholder="за 1000 знаков"
          />
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :aria-label="`Удалить ставку ${i + 1}`"
            @click="rates.splice(i, 1)"
          >
            Удалить
          </button>
        </div>
        <button
          v-if="rates.length < (limits?.rates ?? 15)"
          type="button"
          class="btn btn-ghost btn-sm"
          @click="addRate"
        >
          Добавить ставку
        </button>
      </fieldset>

      <fieldset class="group">
        <legend>Минимальная цена заказа</legend>
        <p class="hint small muted">
          Ниже этой суммы сервер не даст отправить отклик. По одной на валюту.
        </p>
        <div v-for="(m, i) in minimums" :key="`min-${i}`" class="line minimum">
          <input
            v-model="m.amount"
            class="input"
            inputmode="decimal"
            :aria-label="`Минимальная сумма ${i + 1}`"
            placeholder="1000"
          />
          <input
            v-model="m.currency"
            class="input cur"
            maxlength="3"
            :aria-label="`Валюта минимума ${i + 1}`"
            placeholder="RUB"
          />
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :aria-label="`Удалить минимум ${i + 1}`"
            @click="minimums.splice(i, 1)"
          >
            Удалить
          </button>
        </div>
        <button
          v-if="minimums.length < (limits?.minimumPrices ?? 5)"
          type="button"
          class="btn btn-ghost btn-sm"
          @click="addMinimum"
        >
          Добавить минимум
        </button>
      </fieldset>

      <div class="grid">
        <div class="field">
          <label for="profile-active">Сколько заказов одновременно</label>
          <input
            id="profile-active"
            v-model="maxActiveJobs"
            class="input"
            inputmode="numeric"
            placeholder="3"
          />
          <p class="hint">
            Подсказка для модели. Сервер пока не знает, какие заказы у вас в работе, поэтому сам
            этот лимит не проверяет.
          </p>
        </div>
        <div class="field">
          <label for="profile-per-day">Откликов в сутки на площадку</label>
          <input
            id="profile-per-day"
            v-model="proposalsPerDay"
            class="input"
            inputmode="numeric"
            :placeholder="String(limits?.proposalsPerDay ?? '')"
          />
          <p class="hint">
            Пусто: лимит сервера ({{ limits?.proposalsPerDay }}). Можно только меньше.
          </p>
        </div>
      </div>

      <div class="grid">
        <div class="field">
          <label for="profile-turnaround">Сроки</label>
          <textarea
            id="profile-turnaround"
            v-model="turnaround"
            class="textarea short"
            rows="3"
            :maxlength="limits?.turnaround"
            placeholder="До 5 описаний за сутки; статья до 5000 знаков за 2 дня"
          />
        </div>
        <div class="field">
          <label for="profile-tone">Тон откликов</label>
          <textarea
            id="profile-tone"
            v-model="toneNotes"
            class="textarea short"
            rows="3"
            :maxlength="limits?.toneNotes"
            placeholder="На «вы», коротко, без восклицательных знаков"
          />
        </div>
      </div>

      <div class="grid">
        <div class="field">
          <label for="profile-tz">Часовой пояс</label>
          <input
            id="profile-tz"
            v-model="timezone"
            class="input"
            :maxlength="limits?.timezone"
            placeholder="Москва, UTC+3"
          />
        </div>
        <div class="field">
          <label for="profile-availability">Когда на связи</label>
          <input
            id="profile-availability"
            v-model="availability"
            class="input"
            :maxlength="limits?.availability"
            placeholder="Будни 10:00-19:00"
          />
        </div>
      </div>

      <fieldset class="group">
        <legend>Примеры работ</legend>
        <p class="hint small muted">
          Только ваши настоящие работы. Модель упомянет пример по названию; ссылки в отклик не
          вставляются.
        </p>
        <div v-for="(s, i) in samples" :key="`sample-${i}`" class="sample">
          <div class="line sample-head">
            <input
              v-model="s.title"
              class="input"
              :maxlength="limits?.sampleTitle"
              :aria-label="`Название примера ${i + 1}`"
              placeholder="Описания для магазина посуды"
            />
            <input
              v-model="s.url"
              class="input"
              type="url"
              :maxlength="limits?.sampleUrl"
              :aria-label="`Ссылка на пример ${i + 1}`"
              placeholder="https://..."
            />
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :aria-label="`Удалить пример ${i + 1}`"
              @click="samples.splice(i, 1)"
            >
              Удалить
            </button>
          </div>
          <textarea
            v-model="s.text"
            class="textarea short"
            rows="3"
            :maxlength="limits?.sampleText"
            :aria-label="`Текст примера ${i + 1}`"
            placeholder="Фрагмент текста или краткое описание работы"
          />
        </div>
        <button
          v-if="samples.length < (limits?.samples ?? 4)"
          type="button"
          class="btn btn-ghost btn-sm"
          @click="addSample"
        >
          Добавить пример
        </button>
      </fieldset>

      <p v-if="formError" class="small hint-err" role="alert">{{ formError }}</p>
      <div>
        <button type="submit" class="btn btn-primary" :disabled="!!busy">
          {{ busy === 'performer-profile' ? 'Сохраняем' : 'Сохранить профиль' }}
        </button>
      </div>
    </form>
  </section>
</template>
<style scoped>
.profile-form {
  display: grid;
  gap: var(--s-4);
  margin-top: var(--s-3);
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--s-4);
}
.textarea.short {
  min-height: 96px;
}
.group {
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  padding: var(--s-3) var(--s-4) var(--s-4);
  margin: 0;
  display: grid;
  gap: var(--s-3);
  min-width: 0;
}
.group legend {
  font-weight: 600;
  font-size: var(--text-sm);
  padding: 0 6px;
}
.group .hint {
  margin: 0;
}
.line {
  display: grid;
  gap: 8px;
  align-items: center;
}
.rate {
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) 76px minmax(0, 1.5fr) auto;
}
.minimum {
  grid-template-columns: minmax(0, 1fr) 76px auto;
  max-width: 420px;
}
.sample {
  display: grid;
  gap: 8px;
}
.sample-head {
  grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) auto;
}
.cur {
  text-transform: uppercase;
}
.hint-err {
  color: var(--st-err);
}
.group > .btn {
  justify-self: start;
}
@media (max-width: 720px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .rate {
    grid-template-columns: minmax(0, 1fr) 76px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--line);
  }
  .rate > :first-child,
  .rate > :nth-child(4) {
    grid-column: 1 / -1;
  }
  .rate > :nth-child(2) {
    grid-column: 1;
  }
  .sample-head {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
