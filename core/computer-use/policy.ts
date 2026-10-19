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
  stepTimeoutMs: 60_000,
  agentTimeoutMs: 45_000,
  maxOutputTokens: 700,
  // Upper estimate of one 1280x800 PNG in input tokens; the reserve is checked before sending.
  imageTokens: 3000,
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
      a >= 224
    )
  }
  if (h.includes(':')) {
    const v6 = h.toLowerCase()
    if (v6 === '::1' || v6 === '::' || v6.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(v6))
      return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)
    return mapped ? isPrivateHost(mapped[1]!) : false
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

/**
 * Browsing, reading, searching and filling research forms run on their own. Money, credentials,
 * accounts, publishing, messages and agreements wait for the owner. Verification bypass and
 * fraud are refused.
 */
export function classifyAction(action: BrowserAction, page: PageContext): Verdict {
  const host = hostOf(page.url)
  if (action.name === 'navigate') {
    const target = hostOf(action.url)
    if (!target) return { verdict: 'blocked', reason: 'COMPUTER_USE_URL_SCHEME' }
    if (isPrivateHost(target)) return { verdict: 'blocked', reason: 'COMPUTER_USE_PRIVATE_NETWORK' }
    if (isForbiddenHost(target)) return { verdict: 'blocked', reason: 'COMPUTER_USE_HOST_BLOCKED' }
    if (forbiddenTextReason(action.url))
      return { verdict: 'blocked', reason: 'COMPUTER_USE_SCHEME_BLOCKED' }
    if (isPaymentHost(target)) return { verdict: 'approval', reason: 'COMPUTER_USE_PAYMENT_SITE' }
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
    if (
      focused &&
      (/^cc-|one-time-code|current-password|new-password/.test(focused.autocomplete) ||
        sensitiveField.test(`${focused.name} ${focused.autocomplete}`))
    )
      return { verdict: 'approval', reason: 'COMPUTER_USE_SENSITIVE_FIELD' }
    if (cardLike.test(action.text) || /\b0x[0-9a-f]{40}\b|\bbc1[0-9a-z]{25,}\b/i.test(action.text))
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
    if (
      outwardPath.test(URL.canParse(page.url) ? new URL(page.url).pathname : '') &&
      (element?.type === 'submit' || element?.tag === 'button' || action.name === 'key')
    )
      return { verdict: 'approval', reason: 'COMPUTER_USE_OUTWARD_PAGE' }
    return { verdict: 'allow', reason: '' }
  }
  return { verdict: 'allow', reason: '' }
}
