import { validateIdeaTopic } from '../policy'
import type { BrowserAction } from './schema'

/**
 * Server-enforced limits of computer use. The model only proposes; every action passes this
 * classification before the VM is contacted. Outward-facing or irreversible actions wait for the
 * owner; illegal schemes are refused outright. Hard limits also live in the database and the
 * budget ledger, not only here.
 */
export const COMPUTER_USE_POLICY = Object.freeze({
  version: 'computer-v1',
  leaseMs: 5 * 60_000,
  // One worker tick hands the task back after this long; the next tick resumes it, so a long
  // task never looks like a stuck loop to the worker watchdog (40 minutes).
  tickBudgetMs: 10 * 60_000,
  stepTimeoutMs: 60_000,
  // Reads (snapshot, state, element under the cursor) are idempotent: a short timeout and one
  // retry after a pause. Actions are never repeated; they get room for a page load and settling.
  // An unreachable VM fails the task in about half a minute instead of hanging on it.
  agentReadTimeoutMs: 15_000,
  agentReadAttempts: 2,
  agentRetryPauseMs: 1000,
  agentActionTimeoutMs: 45_000,
  maxOutputTokens: 700,
  // Upper estimate of one 1280x800 PNG in input tokens; the reserve is checked before sending.
  // A step without a picture is estimated without it.
  imageTokens: 3000,
  // Leave out a screenshot identical to the one the model just saw after note_opportunity.
  omitUnchangedScreenshots: true,
  maxHistorySteps: 12,
  maxScreenshotBytes: 2_000_000,
  maxInvalidInRow: 3,
  maxFailuresInRow: 3,
  failureCooldownMs: 15 * 60_000,
  approvalLifetimeMs: 24 * 60 * 60_000,
  maxOpportunitiesPerTask: 10,
  maxQueuedOwnerGoals: 20,
  screenshotRetentionDays: 14,
  rotationPauseMs: 60_000,
  // Freelance work: a send permit lives 15 minutes and covers exactly one outward action.
  permitLifetimeMs: 15 * 60_000,
  // Deliveries and replies per platform per UTC day, proposals included (the proposal limit
  // itself comes from COMPUTER_USE_PROPOSALS_PER_DAY).
  maxSendPermitsPerDomainPerDay: 40,
  maxDocumentsPerTask: 5,
  documentOutputTokens: 2500,
  // The owner's remote control of the browser: the model does not run while it lasts.
  manualLeaseMs: 15 * 60_000,
  // The model is told to wrap up (record what is left, call finish) at or below these.
  wrapUpSteps: 3,
  wrapUpCostPercent: 15,
  // Loop guard: a third navigate to the same address within one task is refused.
  maxNavigatesPerUrl: 2,
  maxVisitedShown: 30,
})

export type ElementInfo = {
  tag: string
  type: string
  name: string
  text: string
  href: string
  autocomplete: string
}
export type PageContext = {
  url: string
  title: string
  /** The element that would receive typed text. */
  focused?: ElementInfo | null
  /** The element under the click point. */
  target?: ElementInfo | null
  /** Text of the directly preceding `type` steps: card data typed in pieces is still card data. */
  typedBefore?: string
  /**
   * An open single-use send permit of this task: one outward click or Enter on that platform
   * (the send button of a proposal, delivery or reply) runs without owner approval. Payment
   * sites, credentials, card and code fields and forbidden schemes are never covered by it.
   */
  permit?: { domain: string } | null
}
export type Verdict = { verdict: 'allow' | 'approval' | 'blocked'; reason: string }

/** Payment processors and wallets: any interaction there is money or credentials. */
const paymentHosts = [
  'paypal.com',
  'stripe.com',
  'checkout.stripe.com',
  'pay.google.com',
  'apple.com/shop',
  'yoomoney.ru',
  'yookassa.ru',
  'cloudpayments.ru',
  'prodamus.ru',
  'tinkoff.ru',
  'sberbank.ru',
  'qiwi.com',
  'payeer.com',
  'wise.com',
  'revolut.com',
  'binance.com',
  'bybit.com',
  'okx.com',
  'bitget.com',
  'coinbase.com',
  'kraken.com',
  'metamask.io',
  'walletconnect.com',
  'skrill.com',
  'webmoney.ru',
]
/** Services whose purpose is to defeat verification; refused outright. */
const forbiddenHosts = [
  '2captcha.com',
  'rucaptcha.com',
  'anti-captcha.com',
  'capmonster.cloud',
  'capsolver.com',
  'deathbycaptcha.com',
  'bestcaptchasolver.com',
  'sms-activate.org',
  'sms-activate.io',
  'onlinesim.io',
  '5sim.net',
]
const outwardPath =
  /\/(?:checkout|payment|payments|pay|cart|basket|billing|subscribe|register|signup|sign-up|signin|sign-in|login|auth|compose|submit|publish|withdraw|withdrawal|transfer|send|apply)(?:[/?#.]|$)/i
const outwardText =
  /(?:^|\s)(?:pay|buy|purchase|checkout|order|subscribe|publish|post|submit|send|register|sign\s*up|create\s+account|accept|agree|confirm|transfer|withdraw|apply|place\s+bid|deposit)(?:\s|$)|(?:оплат|куп|заказ|подпис|опубликов|разме(?:с|щ)|отправ|зарегистр|создать\s+аккаунт|принима|соглас|подтвер|перев(?:ести|од)|вывести|вывод|подать\s+заявк|откликнуться|пополн)/iu
const sensitiveField =
  /(?:passw|пароль|cvv|cvc|cvn|card|карт|pan\b|iban|otp|one-time|code|seed|mnemonic|private|secret|ssn|passport|паспорт|inn\b|инн\b|snils|снилс)/i
const cardLike = /(?:\d[\s-]?){13,19}/
const forbiddenText = [
  /(?:(?:обход[а-я]*|обойти|обойд[а-я]*|обхож[а-я]*)\s+(?:капч|captcha|верификац|kyc|2fa|двухфактор|блокиров|бан)|captcha\s*(?:solv|bypass)|bypass\s*(?:captcha|kyc|verification|2fa)|kyc\s*bypass)/iu,
  /(?:мультиаккаунт|multi-?account|fake\s+accounts?|buy\s+accounts?|купить\s+аккаунт|аккаунт[а-я]*\s+на\s+продажу|sybil|сибил|(?<![\p{L}])дроп(?:ы|ов|ам|а)?(?![\p{L}])|обнал|money\s+mule|laundering|отмыв)/iu,
  /(?:чуж[а-я]*\s+(?:паспорт|документ|карт)|stolen\s+(?:card|account)|carding|кардинг|фишинг|phishing|malware|вредонос|ddos|взлом|hack(?:ing)?\s+(?:account|wallet))/iu,
  /(?:deepfake|дипфейк|fake\s+reviews?|фейков[а-я]*\s+отзыв|накрут|bot\s+farm|ферм[а-я]*\s+(?:аккаунт|бот|кошельк))/iu,
]

export function hostOf(url: string) {
  if (!URL.canParse(url)) return ''
  const u = new URL(url)
  return ['http:', 'https:'].includes(u.protocol) ? u.hostname.toLowerCase() : ''
}
const decoded = (value: string) => {
  try {
    return decodeURI(value)
  } catch {
    return value
  }
}
/** A query key or value decoded, with only the characters that would change its meaning escaped. */
const queryPart = (value: string) => value.replace(/[%&=#+\s]/g, (c) => encodeURIComponent(c))
/**
 * One address for the loop guard and the visited list: no fragment, lower-case host without
 * `www.`, no default port, no trailing slash, no empty query, sorted query parameters and a
 * decoded path. The query values stay: a different search or page number is a different page.
 */
export function normalizeUrl(url: string) {
  if (!URL.canParse(url)) return url
  const u = new URL(url)
  if (!['http:', 'https:'].includes(u.protocol)) return url
  const host = u.host.replace(/^www\./, '')
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') || '/' : u.pathname
  const params = [...u.searchParams.entries()].sort(([a, x], [b, y]) =>
    a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0,
  )
  const query = params.length
    ? '?' + params.map(([key, value]) => `${queryPart(key)}=${queryPart(value)}`).join('&')
    : ''
  return `${u.protocol}//${host}${decoded(path)}${query}`
}
const hostMatches = (host: string, list: string[]) =>
  list.some((entry) => {
    const [domain] = entry.split('/')
    return host === domain || host.endsWith(`.${domain}`)
  })
export const isPaymentHost = (host: string) => hostMatches(host, paymentHosts)
export const isForbiddenHost = (host: string) => hostMatches(host, forbiddenHosts)

/** Private, loopback, link-local and metadata targets are never browsed. */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true
  if (h.endsWith('.internal') || h.endsWith('.home.arpa') || h === 'metadata.google.internal')
    return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number) as [number, number, number, number]
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }
  if (h.includes(':')) {
    const v6 = h.toLowerCase()
    if (v6 === '::1' || v6 === '::') return true
    if (/^fe[89ab][0-9a-f]:/.test(v6) || /^f[cd][0-9a-f]{2}:/.test(v6) || /^ff/.test(v6))
      return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)
    if (mapped) return isPrivateHost(mapped[1]!)
    // The URL parser writes a mapped address in hex: [::ffff:7f00:1] is 127.0.0.1.
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6)
    if (hex) {
      const hi = parseInt(hex[1]!, 16)
      const lo = parseInt(hex[2]!, 16)
      return isPrivateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
    }
    return false
  }
  return !h.includes('.')
}

/** Text that describes a forbidden scheme, in Russian or English. */
export function forbiddenTextReason(text: string) {
  if (forbiddenText.some((pattern) => pattern.test(text))) return 'COMPUTER_USE_SCHEME_BLOCKED'
  try {
    validateIdeaTopic(text)
  } catch {
    return 'POLICY_IDEA_TOPIC_BLOCKED'
  }
  return ''
}

const negationWords = new Set([
  'без',
  'не',
  'ни',
  'кроме',
  'исключая',
  'no',
  'not',
  'without',
  'except',
  'excluding',
])
/** "не только казино", "not only gambling" still mention the topic positively. */
const notNegating = new Set(['только', 'просто', 'лишь', 'only', 'just', 'merely'])
/** A negated window ends before these: "без вложений на казино" keeps "на казино". */
const windowStops = new Set([
  'на',
  'в',
  'во',
  'для',
  'через',
  'по',
  'и',
  'или',
  'а',
  'но',
  'on',
  'in',
  'for',
  'via',
  'and',
  'or',
  'but',
  'at',
  'to',
])
const bare = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '')
/**
 * The text without negated mentions: a negation ("без", "не", "кроме", no, without, except)
 * and up to three following words within the same clause, stopping before a preposition or
 * conjunction. "без политических кампаний" goes away, "кампании для политиков" stays.
 */
export function withoutNegatedMentions(text: string) {
  return text
    .split(/([.,;:!?()\n]+)/)
    .map((clause) => {
      const list = clause.split(/(\s+)/).filter((part) => part.length && !/^\s+$/.test(part))
      const kept: string[] = []
      for (let index = 0; index < list.length; index++) {
        const word = bare(list[index]!)
        const next = bare(list[index + 1] ?? '')
        if (!negationWords.has(word) || notNegating.has(next)) {
          kept.push(list[index]!)
          continue
        }
        let skipped = 0
        while (skipped < 3 && index + 1 < list.length && !windowStops.has(bare(list[index + 1]!))) {
          index++
          skipped++
        }
      }
      return /^[.,;:!?()\n]+$/.test(clause) ? clause : kept.join(' ')
    })
    .join('')
}

/**
 * The topic and scheme check of a finding the model recorded: a finding often says what a job
 * excludes ("без политических кампаний"), so negated mentions are ignored; positive mentions
 * are still blocked.
 */
export const forbiddenFindingReason = (text: string) =>
  forbiddenTextReason(withoutNegatedMentions(text))

/** Owner goals and rotation goals pass the same check before a task exists. */
export function validateGoal(goal: string) {
  const text = goal.trim()
  if (text.length < 10 || text.length > 1000) throw new Error('COMPUTER_USE_GOAL_LENGTH')
  if (/[<>]/.test(text)) throw new Error('COMPUTER_USE_GOAL_LENGTH')
  const reason = forbiddenTextReason(text)
  if (reason) throw new Error(reason)
  return text
}

const describe = (element: ElementInfo | null | undefined) =>
  element
    ? [element.tag, element.type, element.name, element.autocomplete, element.text]
        .filter(Boolean)
        .join(' ')
    : ''
const outwardElement = (element: ElementInfo | null | undefined) =>
  !!element &&
  (outwardText.test(` ${element.text} `) ||
    outwardText.test(` ${element.name} `) ||
    element.type === 'submit')
/** Card, code, password and identity fields by name or autocomplete hint. */
const sensitiveElement = (element: ElementInfo | null | undefined) =>
  !!element &&
  (/^cc-|one-time-code|current-password|new-password/.test(element.autocomplete) ||
    sensitiveField.test(`${element.name} ${element.autocomplete}`))
const pathOf = (url: string) => (URL.canParse(url) ? new URL(url).pathname : '')

const permitCovers = (host: string, permit: PageContext['permit']) =>
  !!permit && !!host && (host === permit.domain || host.endsWith(`.${permit.domain}`))
/** Reasons a send permit may replace: the outward send itself, nothing about money or access. */
const permitReasons = new Set(['COMPUTER_USE_OUTWARD_ACTION', 'COMPUTER_USE_OUTWARD_PAGE'])

/**
 * Browsing, reading, searching and filling research forms run on their own. Money, credentials,
 * accounts, publishing, messages and agreements wait for the owner. Verification bypass and
 * fraud are refused. One outward click or Enter on a platform with an open send permit runs
 * instead of waiting; the caller consumes the permit.
 */
export function classifyAction(action: BrowserAction, page: PageContext): Verdict {
  const verdict = classifyWithoutPermit(action, page)
  if (
    verdict.verdict === 'approval' &&
    permitReasons.has(verdict.reason) &&
    (action.name === 'click' || action.name === 'key') &&
    permitCovers(hostOf(page.url), page.permit)
  )
    return { verdict: 'allow', reason: 'COMPUTER_USE_SEND_PERMIT' }
  return verdict
}

function classifyWithoutPermit(action: BrowserAction, page: PageContext): Verdict {
  const host = hostOf(page.url)
  if (action.name === 'navigate') {
    const target = hostOf(action.url)
    if (!target) return { verdict: 'blocked', reason: 'COMPUTER_USE_URL_SCHEME' }
    if (isPrivateHost(target)) return { verdict: 'blocked', reason: 'COMPUTER_USE_PRIVATE_NETWORK' }
    if (isForbiddenHost(target)) return { verdict: 'blocked', reason: 'COMPUTER_USE_HOST_BLOCKED' }
    if (forbiddenTextReason(action.url))
      return { verdict: 'blocked', reason: 'COMPUTER_USE_SCHEME_BLOCKED' }
    if (isPaymentHost(target)) return { verdict: 'approval', reason: 'COMPUTER_USE_PAYMENT_SITE' }
    // An outward page opened with parameters may act on them (GET forms, prefilled sends).
    if (outwardPath.test(pathOf(action.url)) && new URL(action.url).search.length > 1)
      return { verdict: 'approval', reason: 'COMPUTER_USE_OUTWARD_PAGE' }
    return { verdict: 'allow', reason: '' }
  }
  if (host && isForbiddenHost(host))
    return { verdict: 'blocked', reason: 'COMPUTER_USE_HOST_BLOCKED' }
  if (action.name === 'type') {
    const reason = forbiddenTextReason(action.text)
    if (reason) return { verdict: 'blocked', reason }
    const focused = page.focused
    if (focused?.type === 'password')
      return { verdict: 'approval', reason: 'COMPUTER_USE_CREDENTIALS' }
    if (sensitiveElement(focused))
      return { verdict: 'approval', reason: 'COMPUTER_USE_SENSITIVE_FIELD' }
    const typed = `${page.typedBefore ?? ''}${action.text}`
    if (cardLike.test(typed) || /\b0x[0-9a-f]{40}\b|\bbc1[0-9a-z]{25,}\b/i.test(typed))
      return { verdict: 'approval', reason: 'COMPUTER_USE_PAYMENT_DATA' }
    if (host && isPaymentHost(host))
      return { verdict: 'approval', reason: 'COMPUTER_USE_PAYMENT_SITE' }
    return { verdict: 'allow', reason: '' }
  }
  if (action.name === 'click' || (action.name === 'key' && action.key === 'Enter')) {
    const element = action.name === 'click' ? page.target : page.focused
    if (host && isPaymentHost(host))
      return { verdict: 'approval', reason: 'COMPUTER_USE_PAYMENT_SITE' }
    if (element && forbiddenTextReason(describe(element)))
      return { verdict: 'blocked', reason: 'COMPUTER_USE_SCHEME_BLOCKED' }
    if (element?.href) {
      const linkHost = hostOf(element.href)
      if (linkHost && isForbiddenHost(linkHost))
        return { verdict: 'blocked', reason: 'COMPUTER_USE_HOST_BLOCKED' }
      if (linkHost && isPaymentHost(linkHost))
        return { verdict: 'approval', reason: 'COMPUTER_USE_PAYMENT_SITE' }
    }
    if (outwardElement(element))
      return { verdict: 'approval', reason: 'COMPUTER_USE_OUTWARD_ACTION' }
    if (page.focused?.type === 'password' && action.name === 'key')
      return { verdict: 'approval', reason: 'COMPUTER_USE_CREDENTIALS' }
    // Enter in a card, code or identity field submits what was typed there.
    if (action.name === 'key' && sensitiveElement(page.focused))
      return { verdict: 'approval', reason: 'COMPUTER_USE_SENSITIVE_FIELD' }
    if (
      outwardPath.test(pathOf(page.url)) &&
      (element?.type === 'submit' || element?.tag === 'button' || action.name === 'key')
    )
      return { verdict: 'approval', reason: 'COMPUTER_USE_OUTWARD_PAGE' }
    return { verdict: 'allow', reason: '' }
  }
  return { verdict: 'allow', reason: '' }
}
