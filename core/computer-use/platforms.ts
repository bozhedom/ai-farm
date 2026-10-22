import { config } from '../config'
import { hostOf } from './policy'

/**
 * Freelance platforms where the owner may log the VM browser in. Proposals, deliveries and
 * replies are allowed only here, and only on platforms the owner marked as logged in. The list
 * can be extended through COMPUTER_USE_PLATFORM_DOMAINS; the server still validates every name.
 */
export const defaultPlatformDomains: readonly string[] = Object.freeze([
  'fl.ru',
  'kwork.ru',
  'freelance.habr.com',
  'weblancer.net',
  'youdo.com',
  'workzilla.com',
  'work-zilla.com',
  'freelancer.com',
  'upwork.com',
  'fiverr.com',
  'peopleperhour.com',
  'guru.com',
  'toptal.com',
  'contently.com',
  'textbroker.com',
  'etxt.ru',
  'advego.com',
  'text.ru',
  'freelancejob.ru',
  'pchel.net',
  'hh.ru',
  'profi.ru',
  'freelancehunt.com',
])

const domainPattern = /^[a-z0-9][a-z0-9.-]{1,98}\.[a-z]{2,}$/

/** Configured platforms: the defaults plus valid names from the environment. */
export function platformDomains(): string[] {
  const extra = (config().COMPUTER_USE_PLATFORM_DOMAINS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => domainPattern.test(value))
  return [...new Set([...defaultPlatformDomains, ...extra])]
}

/** The platform a host belongs to (`www.fl.ru` → `fl.ru`), or '' when it is not a platform. */
export function platformOf(hostOrUrl: string): string {
  const host = /^https?:\/\//i.test(hostOrUrl) ? hostOf(hostOrUrl) : hostOrUrl.toLowerCase()
  if (!host) return ''
  // Longest match first: `freelance.habr.com` before a hypothetical `habr.com`.
  const match = platformDomains()
    .filter((domain) => host === domain || host.endsWith(`.${domain}`))
    .sort((a, b) => b.length - a.length)[0]
  return match || ''
}
export const isFreelancePlatform = (domain: string) => platformOf(domain) === domain.toLowerCase()

// ---------------------------------------------------------------------------------------------
// Text heuristics. They are server-side hard limits, not prompt advice, and are unit-tested.
// `\b` knows ASCII letters only, so Cyrillic words get explicit letter lookarounds.

const B = '(?<![\\p{L}\\p{N}])'
const E = '(?![\\p{L}\\p{N}])'
const w = '[\\p{L}\\p{N}-]*'
const rx = (source: string) => new RegExp(source, 'iu')
const aiWords = `(?:ии|ai|нейросет${w}|нейронн${w}\\s+сет${w}|chat\\s?gpt|gpt|llm|искусственн${w}\\s+интеллект${w})`
const aiBan = [
  // "без ИИ", "без использования нейросетей", "без ChatGPT"
  rx(`${B}без\\s+(?:использования\\s+|помощи\\s+|применения\\s+)?${aiWords}${E}`),
  // "не использовать ИИ", "не принимаем тексты от нейросетей", "никакого GPT"
  rx(
    `${B}(?:не\\s+(?:использ${w}|принима${w}|рассматрива${w}|допуска${w}|нужн${w}|предлага${w})|никак${w})\\s+(?:${w}\\s+){0,3}?${aiWords}${E}`,
  ),
  // "ИИ не рассматриваем", "тексты нейросетью отклоняются", "ИИ запрещён"
  rx(
    `${B}${aiWords}[^.!\\n]{0,40}(?:запрещ${w}|не\\s+допуска${w}|не\\s+принима${w}|не\\s+рассматрива${w}|не\\s+использ${w}|отклоня${w}|бан${E})`,
  ),
  /\b(?:no|without|zero)\s+(?:use\s+of\s+|the\s+use\s+of\s+|any\s+)?(?:ai|chat\s?gpt|gpt|llms?|neural\s+networks?|ai[- ]generated|ai[- ]written|ai[- ]tools?|ai[- ]assistance)\b/i,
  /\b(?:ai|chat\s?gpt|gpt|llms?|ai[- ]generated|ai[- ]written|ai[- ]tools?)\b[^.!\n]{0,40}\b(?:not\s+allowed|prohibited|forbidden|banned|will\s+be\s+rejected|not\s+accepted|is\s+a\s+no)\b/i,
  /\b(?:don'?t|do\s+not|never|must\s+not|cannot|can'?t|please\s+do\s+not)\s+use\s+(?:any\s+)?(?:ai|chat\s?gpt|gpt|llms?|neural)/i,
  /\b(?:human[- ]written|human[- ]only|ai[- ]free|written\s+by\s+(?:a\s+)?humans?\s+only)\b/i,
  rx(
    `${B}(?:только\\s+вручную|только\\s+ручн${w}\\s+работ${w}|написан${w}\\s+(?:только\\s+)?человеком|не\\s+нейросет${w})${E}`,
  ),
]
/** Job text that forbids AI, neural networks or ChatGPT (Russian and English). */
export function aiForbiddenReason(text: string): string {
  return aiBan.some((pattern) => pattern.test(text)) ? 'COMPUTER_USE_AI_FORBIDDEN' : ''
}

/** A run of ten or more digits with the usual separators: a phone number, not a date or price. */
const phoneLike = (text: string) =>
  (text.match(/[\d\s().+-]{10,}/g) || []).some((run) => run.replace(/\D/g, '').length >= 10)
const contactDetails = [
  /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i,
  /(?:^|[\s(])@[a-z0-9_]{4,}\b/i,
  rx(
    `${B}(?:t\\.me\\/|telegram|телеграм${w}|тг|whats\\s?app|вотсап${w}|ватсап${w}|viber|вайбер${w}|skype|скайп${w}|discord|дискорд${w}|signal|вконтакте|vk\\.com)${E}`,
  ),
  rx(
    `${B}(?:напишите|пишите|свяжитесь|пиши)\\s+(?:мне\\s+)?(?:в\\s+)?(?:личк${w}|лс|почт${w}|мессенджер${w})${E}`,
  ),
]
const offPlatformPayment = [
  rx(
    `${B}(?:мимо|вне)\\s+(?:площадки|биржи|сервиса|сайта|платформы)${E}|${B}напрямую\\s+(?:мне\\s+)?(?:на\\s+карту|без\\s+комиссии|без\\s+площадки)|${B}без\\s+комиссии\\s+(?:площадки|биржи|сервиса)${E}`,
  ),
  rx(
    `${B}(?:оплат${w}|перевод${w}|перевед${w}|перечисл${w}|скин${w}|отправ${w}|заплат${w})\\s+(?:мне\\s+)?(?:напрямую\\s+)?(?:на\\s+)?(?:карт${w}|сбер${w}|тиньк${w}|т-банк|qiwi|киви|юmoney|yoomoney|юмани|paypal|крипт${w}|usdt|кошел${w})${E}`,
  ),
  /\b(?:pay|payment|paid)\s+(?:me\s+)?(?:directly|outside|off[- ]platform|via\s+(?:paypal|crypto|usdt|wise|card|bank))\b|\b(?:outside|off)\s+(?:of\s+)?(?:the\s+)?platform\b|\bavoid\s+(?:the\s+)?(?:platform\s+)?fees?\b|\bdirect\s+(?:bank\s+)?transfer\b|\bbypass\s+(?:the\s+)?(?:platform|escrow)\b/i,
]
const fabricatedClaims = [
  rx(
    `${B}\\d{1,2}\\+?\\s*(?:лет|года|год)\\s+(?:опыта|стажа|в\\s+(?:копирайтинге|переводах|сфере))${E}`,
  ),
  /\b\d{1,2}\+?\s*years?\s+(?:of\s+)?(?:experience|in\s+the\s+field)\b/i,
  rx(
    `${B}(?:более|больше|свыше)\\s+\\d{1,5}\\s+(?:довольных\\s+)?(?:клиентов|заказчиков|проектов|заказов|отзывов)${E}`,
  ),
  /\b(?:over|more\s+than)\s+\d{1,5}\s+(?:happy\s+|satisfied\s+)?(?:clients|projects|orders|reviews)\b/i,
  rx(
    `${B}(?:диплом${w}|кандидат\\s+наук|сертифицирован${w}|сертификат${w}|портфолио|отзыв${w}|рейтинг${w}|работал${w}\\s+(?:в|с)\\s+(?:компани${w}|агентств${w}|яндекс${w}|сбер${w}|google|amazon))${E}`,
  ),
  /\b(?:degree|university\s+of|phd|mba|certified|certificate|portfolio|reviews?|testimonials?|top[- ]rated|worked\s+(?:at|for|with)\s+(?:google|amazon|microsoft|meta|apple))\b/i,
]
const externalLinks = /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\.[a-z]{2,}\b/i
const aiDenial = [
  rx(
    `${B}(?:не|никогда\\s+не)\\s+(?:использу${w}|применя${w}|пользу${w})\\s+(?:никак${w}\\s+)?(?:ии|ai|нейросет${w}|chat\\s?gpt|gpt)${E}`,
  ),
  rx(
    `${B}без\\s+(?:использования\\s+|помощи\\s+|применения\\s+)?(?:ии|ai|нейросет${w}|chat\\s?gpt|gpt)${E}`,
  ),
  rx(`${B}(?:это\\s+не|я\\s+не)\\s+(?:ии|нейросеть|бот|робот)${E}`),
  rx(
    `${B}(?:пишу|написан${w}|делаю|сделан${w})\\s+(?:всё\\s+|все\\s+|только\\s+)?(?:вручную|человеком)${E}`,
  ),
  /\b(?:no|without|never\s+use|don'?t\s+use|do\s+not\s+use|not\s+using)\s+(?:any\s+)?(?:ai|chat\s?gpt|gpt|neural\s+networks?|llms?)\b/i,
  /\b(?:100\s*%|fully|entirely|purely)\s+human(?:[- ]written)?\b|\bhuman[- ]written\b|\bwritten\s+by\s+(?:a\s+)?human\b|\bi\s+am\s+not\s+(?:an?\s+)?(?:ai|bot|robot)\b/i,
]

/**
 * Proposal or reply text the server refuses: contact details and off-platform payment (platform
 * rules, fee circumvention bans accounts), invented credentials, reviews, experience or
 * portfolio, external links, and any denial of AI use. The owner decides what to answer when a
 * client asks about AI; the model escalates with request_approval. `verified` is the owner's
 * performer profile: a claim is a fact only when a positive clause of the profile states the
 * same claim (`claimVerified`).
 */
export function forbiddenClaimReason(text: string, verified = ''): string {
  const other = platformTextReason(text)
  if (other) return other
  if (fabricatedClaims.some((pattern) => unverifiedMatch(pattern, text, verified)))
    return 'COMPUTER_USE_UNVERIFIED_CLAIM'
  return ''
}

/** Every rule of `forbiddenClaimReason` except invented claims: for the owner's own profile. */
export function platformTextReason(text: string): string {
  if (aiDenial.some((pattern) => pattern.test(text))) return 'COMPUTER_USE_AI_DENIAL'
  if (offPlatformPayment.some((pattern) => pattern.test(text)))
    return 'COMPUTER_USE_OFF_PLATFORM_PAYMENT'
  if (phoneLike(text) || contactDetails.some((pattern) => pattern.test(text)))
    return 'COMPUTER_USE_CONTACT_DETAILS'
  if (externalLinks.test(text)) return 'COMPUTER_USE_EXTERNAL_LINK'
  return ''
}

/** Clauses: sentences split further at commas, semicolons, colons, brackets and line breaks. */
const clauses = (value: string) => value.split(/[.!?;:,()\n…]+/u)
/** Words of a clause: lower case, ё as е, apostrophes dropped, other punctuation as spaces. */
const words = (value: string) =>
  value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}+%]+/gu, ' ')
    .split(' ')
    .filter(Boolean)
/** Leading words that state nothing themselves: "у меня", "я", "есть", "могу показать", "I have a". */
const fillers = new Set(
  (
    'здравствуйте добрый день привет у меня я мой моя мое мои есть имею имеется также тоже ' +
    'а и еще уже могу можно показать покажу вот это hello hi i have has a an the my also can ' +
    'show am im ive got and'
  ).split(' '),
)
/** A profile clause with any of these words is never a positive statement of a fact. */
const negations = new Set(
  (
    'не нет ни без никогда нету пока not no never without none dont didnt doesnt havent hasnt ' +
    'isnt wasnt werent cannot cant wont'
  ).split(' '),
)
function claimWords(clause: string) {
  const list = words(clause)
  let start = 0
  while (start < list.length && fillers.has(list[start]!)) start++
  return list.slice(start)
}

/**
 * A claim clause is verified only when a positive clause of the profile states it: after the
 * leading filler words of both, the profile clause starts with the whole claim on word
 * boundaries. "работала в компании Ромашка" verifies "Я работала в компании Ромашка", but not
 * "работала в компании Google", "красный диплом МГУ" or "сертифицированный специалист". A
 * profile clause with a negation ("диплом не получала") never verifies anything.
 */
export function claimVerified(claim: string, verified: string) {
  const wanted = claimWords(claim)
  if (!wanted.length) return false
  const needle = ` ${wanted.join(' ')} `
  return clauses(verified).some((clause) => {
    if (words(clause).some((word) => negations.has(word))) return false
    return ` ${claimWords(clause).join(' ')} `.startsWith(needle)
  })
}

/**
 * A claim pattern matches and at least one clause with a match is not stated in the owner's
 * verified facts (the performer profile). Without facts every match is unverified; a match that
 * spans clauses is unverified too: when in doubt, block.
 */
function unverifiedMatch(pattern: RegExp, text: string, verified: string) {
  if (!pattern.test(text)) return false
  if (!verified) return true
  const matched = clauses(text).filter((clause) => pattern.test(clause))
  if (!matched.length) return true
  return matched.some((clause) => !claimVerified(clause, verified))
}

/**
 * Goals for platforms the owner logged in: check jobs and send proposals, then check messages
 * and deliver accepted work. Research goals follow them in the rotation.
 */
export function platformGoals(loggedIn: string[], proposalsPerDay: number): string[] {
  const goals: string[] = []
  for (const domain of loggedIn) {
    goals.push(
      `Открой ${domain} под аккаунтом владельца (вход уже выполнен; если видишь форму входа, заверши задание через finish). Просмотри новые задания, которые закрываются текстовыми услугами: описания, статьи, редактура, перевод, инструкции, ответы клиентам. Каждое подходящее оцени через note_opportunity с решением и оценкой соответствия; задания с запретом ИИ пропускай. Для заданий с решением take напиши отклик через draft_proposal и отправь его кнопкой площадки. Не больше ${proposalsPerDay} откликов в сутки на этой площадке.`,
      `Открой ${domain} под аккаунтом владельца (вход уже выполнен; если видишь форму входа, заверши задание через finish). Проверь сообщения, уведомления и принятые заказы. Ответь заказчикам по делу через prepare_send с целью reply; для принятых текстовых заданий подготовь результат через write_document, вставь его через type_stored и сдай через prepare_send с целью delivery. Вопросы о деньгах вне площадки, контактах и о том, используется ли ИИ, передавай владельцу через request_approval.`,
    )
  }
  return goals
}
