import {
  safeSourceUrl,
  templateSchema,
  validateContent,
  type Evidence,
  type Template,
} from './policy'

/** Server-owned topics describe the service, not arbitrary words supplied by a search result. */
export const customerDiscoveryRules: Record<Template, { topic: RegExp }> = {
  description: {
    topic:
      /(?:описан[а-я]*|карточ[а-я]*)\s+(?:для\s+)?(?:товар|продукт|маркетплейс)|product descriptions?/u,
  },
  faq: { topic: /\bfaq\b|вопрос[а-я]*.{0,25}ответ[а-я]*/u },
  social: {
    topic:
      /(?:пост|текст|публикац|контент)[а-я]*.{0,35}(?:соцсет|социальн.{0,12}сет|телеграм|telegram|вконтакте)|(?:написа|подготов|автор)[а-я]*.{0,25}пост[а-я]*|\bsmm\b|social (?:posts|media)/u,
  },
  proofreading: {
    topic:
      /редакт[а-я]*.{0,25}(?:текст|стат|книг|материал)|(?:текст|стат|книг|материал)[а-я]*.{0,25}редакт|корректор|корректур|вычит[а-я]*.{0,25}текст|proofread|copyedit/u,
  },
  translation: {
    topic:
      /переводчик|перевод[а-я]*.{0,35}(?:текст|описани|английск|русск|немецк|язык|стат|сайт)|перевести.{0,35}(?:текст|описани|стат|сайт)|translation|translator/u,
  },
  summary: {
    topic:
      /сократ[а-я]*.{0,25}текст|кратк[а-я]*.{0,25}(?:содержани|изложени|обзор)|выжимк|саммар[а-я]*|summari[sz]/u,
  },
  email: {
    topic: /ответ[а-я]*.{0,30}(?:клиент|покупател|заказчик)|(?:письм|шаблон)[а-я]*.{0,30}ответ/u,
  },
  landing: {
    topic:
      /(?:текст|копирайт|контент)[а-я]*.{0,45}(?:лендинг|лэндинг|посадочн[а-я]*\s+страниц)|(?:лендинг|лэндинг|посадочн[а-я]*\s+страниц)[а-я]*.{0,35}(?:текст|копирайт|контент)|landing page (?:copy|text)/u,
  },
  proposal: { topic: /(?:коммерческ|делов)[а-я]*\s+предложен|business proposal/u },
  instruction: {
    topic: /инструкци[а-я]*|мануал[а-я]*|руководств[а-я]* пользователя|user (?:guide|manual)/u,
  },
  lesson: {
    topic:
      /учебн[а-я]*\s+(?:материал|текст)|(?:текст|материал|сценари)[а-я]*.{0,25}урок|(?:подготов|редакт|написа)[а-я]*.{0,35}урок|learning materials/u,
  },
  job_post: {
    topic:
      /текст[а-я]*.{0,25}ваканси|(?:написа|состав|оформ|редакт)[а-я]*.{0,30}ваканси|job (?:post|description)/u,
  },
}

const projectSections: Record<string, RegExp> = {
  'fl.ru': /^\/projects(?:\/|$)/u,
  'weblancer.net': /^\/freelance(?:\/|$)/u,
  'freelancehunt.com': /^\/projects?(?:\/|$)/u,
  'freelance.ru': /^\/projects(?:\/|$)/u,
  'freelancium.ru': /^\/projects(?:\/|$)/u,
  'work-zilla.com': /^\/(?:freelance-jobs|tasks)(?:\/|$)/u,
}
const excludedHosts =
  /(?:^|\.)(?:avtor24\.ru|zaochnik(?:-com)?\.(?:ru|com)|studhelp-online\.ru|vsesdal\.com|elibrary\.ru|2gis\.ru|hh\.ru|remote-job\.ru|talent-move\.ru)$/u
const nonRequestPath =
  /\/(?:register|registration|signup|sign-up|login|auth|reestr|contragent|catalog|blog|articles?|media|tutorials?|cart\/company)(?:\/|$)|\/(?:order|projects?)\/(?:add|create)(?:\/|$)/u
const excludedWork =
  /(?:курсов[а-я]*|дипломн[а-я]*|контрольн[а-я]*)\s+работ|(?:написа[а-я]*|заказ[а-я]*)\s+реферат|помощь\s+студент|студенческ[а-я]*\s+работ|(?<![\p{L}])(?:для|к|в|по)\s+(?:дипломн[а-я]*|диплом[ау]?|курсов(?:ой|ую|ая))(?![\p{L}])|(?<![\p{L}])(?:вкр|выпускн[а-я]*\s+квалификационн)/u
const closedRequest =
  /(?:заказ|проект|задание|тендер)\s+(?:уже\s+)?(?:закрыт|завершен|выполнен|в архиве)|заказчик\s+выбрал\s+исполнителя|исполнитель\s+(?:уже\s+)?(?:выбран|определен)|(?<![\p{L}])(?:закрыт|закрыто|закрыта|в архиве|архивный)(?![\p{L}])|project (?:closed|completed)/u

const months: Record<string, number> = {
  январ: 0,
  феврал: 1,
  март: 2,
  апрел: 3,
  мая: 4,
  май: 4,
  июн: 5,
  июл: 6,
  август: 7,
  сентябр: 8,
  октябр: 9,
  ноябр: 10,
  декабр: 11,
}
/** Requests older than this are not offered to the owner: the client has moved on. */
export const leadMaxAgeDays = 60

/**
 * The newest date a search title or snippet shows: full dates, "12 марта 2022", or a bare year
 * (not "2000 знаков"). Null when the text has none: a snippet without a date proves nothing.
 */
export function newestLeadDate(text: string, now = new Date()): Date | null {
  const value = normalize(text)
  const dates: Date[] = []
  const year = (raw: string) => (raw.length === 2 ? 2000 + Number(raw) : Number(raw))
  const push = (y: number, m: number, d: number) => {
    if (y < 1995 || y > now.getUTCFullYear() + 1 || m < 0 || m > 11 || d < 1 || d > 31) return
    dates.push(new Date(Date.UTC(y, m, d)))
  }
  for (const match of value.matchAll(/(?<!\d)(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})(?!\d)/gu))
    push(year(match[3]!), Number(match[2]) - 1, Number(match[1]))
  for (const match of value.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/gu))
    push(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  for (const match of value.matchAll(
    /(?<!\d)(\d{1,2})\s+(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)[а-я]*\s+(\d{4})(?!\d)/gu,
  ))
    push(Number(match[3]), months[match[2]!]!, Number(match[1]))
  if (!dates.length)
    for (const match of value.matchAll(
      /(?<![\d.,])(19\d{2}|20\d{2})(?![\d.,])(?!\s*(?:знак|символ|слов|руб|р\.|₽|шт|страниц|тыс|строк|позиц|товар|к(?![\p{L}])))/gu,
    ))
      push(Number(match[1]), 11, 31)
  return dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null
}

/** Why a search result is not worth a reply: closed, student work, or older than `leadMaxAgeDays`. */
export function staleLead(title: string, snippet: string, now = new Date()) {
  const text = normalize(`${title} ${snippet}`).replace(/\s+/g, ' ')
  if (closedRequest.test(text)) return 'LEAD_CLOSED' as const
  // Work for students is excluded from the pilot; older saved leads are checked again too.
  if (excludedWork.test(text)) return 'LEAD_EXCLUDED' as const
  const newest = newestLeadDate(`${title} ${snippet}`, now)
  if (newest && now.getTime() - newest.getTime() > leadMaxAgeDays * 86400000)
    return 'LEAD_TOO_OLD' as const
  return null
}
export const requestText =
  /(?:^|[^\p{L}])(?:ищу|ищем|требуется|требуются|нужен|нужна|нужны)\s+|(?:^|[.!?]\s+)(?:нам\s+)?(?:нужно|необходимо)\s+(?:написать|составить|подготовить|отредактировать|перевести|сократить|создать)|looking for (?:a |an )?(?:writer|editor|translator|copywriter)/u
const supplierTitle =
  /(?:^|\s)(?:услуги|заказать|закажите)|на заказ|цены и отзывы|лучшие предложения|сервис|онлайн.?курс|как\s+(?:написать|сократить|найти|получить|отвечать)|для начинающих/u
const supplierText =
  /(?:наши|опытные)\s+(?:авторы|копирайтеры|редакторы)|мы\s+(?:предлагаем|напишем|разработаем)|(?:ищу|ищем)\s+(?:новых?\s+|дополнительн[а-я]*\s+)?(?:клиент|заказ|работ|подработ)|(?:закажите|заказать услугу)|выбирайте\s+(?:лучших|специалистов)|вставьте.{0,30}(?:текст|материал).{0,20}поле/u

const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/ё/g, 'е')

/** Snippet qualification can yield zero candidates; it proves neither freshness nor demand. */
export function selectCustomerCandidates(
  template: Template,
  evidence: Evidence[],
  now = new Date(),
): Evidence[] {
  templateSchema.parse(template)
  const seen = new Set<string>()
  return evidence
    .filter((item) => {
      if (!safeSourceUrl(item.url) || seen.has(item.url)) return false
      try {
        validateContent(`${item.title} ${item.snippet}`)
      } catch {
        return false
      }
      const url = new URL(item.url)
      const host = url.hostname.replace(/^www\./, '')
      const title = normalize(item.title)
      const snippet = normalize(item.snippet)
      const text = normalize(`${item.title} ${item.snippet}`).replace(/\s+/g, ' ')
      if (item.demo) {
        const fixture =
          ['customer-brief.example', 'project-request.example'].includes(host) &&
          url.pathname === `/${template}` &&
          normalize(item.title).includes('демонстрация')
        if (fixture) seen.add(item.url)
        return fixture
      }
      if (
        excludedHosts.test(host) ||
        nonRequestPath.test(url.pathname) ||
        excludedWork.test(text) ||
        closedRequest.test(text) ||
        !!staleLead(item.title, item.snippet, now) ||
        !customerDiscoveryRules[template].topic.test(text)
      )
        return false
      // Project snippets sometimes quote an applicant's offer or a list-page footer.
      // The public project URL is a reason to inspect the source, never proof of an open order.
      const projectSection = projectSections[host]?.test(url.pathname) ?? false
      if (
        !projectSection &&
        ((!requestText.test(title) && !requestText.test(snippet)) ||
          supplierTitle.test(title) ||
          supplierText.test(text))
      )
        return false
      seen.add(item.url)
      return true
    })
    .slice(0, 6)
}
