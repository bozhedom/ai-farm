import { z } from 'zod'
import { config } from '../config'
import { audit, query, type Connection } from '../db'
import { forbiddenClaimReason } from './platforms'
import {
  forbiddenTextReason,
  hostOf,
  isForbiddenHost,
  isPaymentHost,
  isPrivateHost,
} from './policy'

/**
 * Performer profile: what the owner, a real person, truthfully says about themselves. The model
 * writes freelance proposals in first person and may use only these facts; the server enforces
 * the minimum price per currency and the proposal limit override. Only the owner edits it
 * (session + Origin), the model only reads a compact copy.
 */
export const PROFILE_LIMITS = Object.freeze({
  displayName: 80,
  bio: 600,
  skills: 20,
  skill: 60,
  languages: 6,
  language: 40,
  rates: 15,
  service: 80,
  unit: 40,
  minimumPrices: 5,
  turnaround: 400,
  avoidTopics: 15,
  avoidTopic: 80,
  toneNotes: 400,
  samples: 4,
  sampleTitle: 100,
  sampleText: 800,
  sampleUrl: 300,
  timezone: 60,
  availability: 200,
  maxActiveJobs: 50,
})
const L = PROFILE_LIMITS

/** Plain text without angle brackets or control characters; `multiline` allows line breaks. */
const plain = (max: number, multiline = false) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !/[<>]/.test(value), 'ANGLE_BRACKETS')
    .refine(
      (value) => !/\p{Cc}/u.test(multiline ? value.replace(/\n/g, '') : value),
      'CONTROL_CHARACTERS',
    )
const item = (max: number) => plain(max).refine((value) => value.length >= 2, 'TOO_SHORT')
const list = (max: number, size: number) =>
  z
    .array(item(max))
    .max(size)
    .refine(
      (values) => new Set(values.map((v) => v.toLowerCase())).size === values.length,
      'DUPLICATE',
    )
const currency = z
  .string()
  .trim()
  .toUpperCase()
  .refine((value) => /^[A-Z]{3}$/.test(value), 'CURRENCY_CODE')
/** Integer minor units (kopecks, cents), never a float. */
const minor = z.number().int().min(1).max(1_000_000_000_000)

export const performerProfileSchema = z
  .object({
    displayName: plain(L.displayName).default(''),
    bio: plain(L.bio, true).default(''),
    skills: list(L.skill, L.skills).default([]),
    languages: list(L.language, L.languages).default([]),
    rates: z
      .array(
        z
          .object({
            service: item(L.service),
            amount: minor,
            currency,
            unit: plain(L.unit).default(''),
          })
          .strict(),
      )
      .max(L.rates)
      .default([]),
    minimumPrices: z
      .array(z.object({ currency, amount: minor }).strict())
      .max(L.minimumPrices)
      .refine(
        (values) => new Set(values.map((v) => v.currency)).size === values.length,
        'DUPLICATE_CURRENCY',
      )
      .default([]),
    maxActiveJobs: z.number().int().min(1).max(L.maxActiveJobs).nullable().default(null),
    proposalsPerDay: z.number().int().min(1).max(100).nullable().default(null),
    turnaround: plain(L.turnaround, true).default(''),
    avoidTopics: list(L.avoidTopic, L.avoidTopics).default([]),
    toneNotes: plain(L.toneNotes, true).default(''),
    samples: z
      .array(
        z
          .object({
            title: plain(L.sampleTitle).refine((value) => value.length >= 4, 'TOO_SHORT'),
            text: plain(L.sampleText, true).default(''),
            url: plain(L.sampleUrl).default(''),
          })
          .strict()
          .refine((sample) => sample.text.length > 0 || sample.url.length > 0, 'SAMPLE_EMPTY'),
      )
      .max(L.samples)
      .default([]),
    timezone: plain(L.timezone).default(''),
    availability: plain(L.availability, true).default(''),
  })
  .strict()
export type PerformerProfile = z.infer<typeof performerProfileSchema>
export const emptyProfile = (): PerformerProfile => performerProfileSchema.parse({})

/**
 * Content checks beyond the shape. The owner's own experience, degrees and samples are facts,
 * so the "invented claims" check does not apply here; contact details, off-platform payment,
 * denial of AI use, forbidden schemes and links outside the sample URL field are refused, since
 * the model would carry them into proposals. Topics to avoid may name excluded topics.
 */
export function profileContentReason(profile: PerformerProfile, envProposalsPerDay: number) {
  if (profile.proposalsPerDay !== null && profile.proposalsPerDay > envProposalsPerDay)
    return 'COMPUTER_USE_PROFILE_PROPOSALS_OVER_LIMIT'
  const texts = [
    profile.displayName,
    profile.bio,
    ...profile.skills,
    ...profile.languages,
    ...profile.rates.flatMap((rate) => [rate.service, rate.unit]),
    profile.turnaround,
    profile.toneNotes,
    ...profile.samples.flatMap((sample) => [sample.title, sample.text]),
    profile.timezone,
    profile.availability,
  ].filter(Boolean)
  for (const text of texts) {
    const scheme = forbiddenTextReason(text)
    if (scheme) return 'COMPUTER_USE_PROFILE_TOPIC_BLOCKED'
    // `forbiddenClaimReason` with the text itself as verified facts: everything except the
    // invented-claims rule still applies.
    const claim = forbiddenClaimReason(text, text)
    if (claim) return claim.replace('COMPUTER_USE_', 'COMPUTER_USE_PROFILE_')
  }
  for (const sample of profile.samples) {
    if (!sample.url) continue
    const host = hostOf(sample.url)
    if (!host || isPrivateHost(host) || isForbiddenHost(host) || isPaymentHost(host))
      return 'COMPUTER_USE_PROFILE_SAMPLE_URL'
  }
  return ''
}

/** Shape and content in one step; throws a stable code the office shows in words. */
export function validateProfile(input: unknown, envProposalsPerDay: number): PerformerProfile {
  const parsed = performerProfileSchema.safeParse(input)
  if (!parsed.success) throw new Error('COMPUTER_USE_PROFILE_INVALID')
  const reason = profileContentReason(parsed.data, envProposalsPerDay)
  if (reason) throw new Error(reason)
  return parsed.data
}

export function isEmptyProfile(profile: PerformerProfile) {
  return (
    !profile.displayName &&
    !profile.bio &&
    !profile.skills.length &&
    !profile.languages.length &&
    !profile.rates.length &&
    !profile.minimumPrices.length &&
    profile.maxActiveJobs === null &&
    profile.proposalsPerDay === null &&
    !profile.turnaround &&
    !profile.avoidTopics.length &&
    !profile.toneNotes &&
    !profile.samples.length &&
    !profile.timezone &&
    !profile.availability
  )
}

/** The stored row; a row that no longer passes the schema reads as empty, never as partial. */
export async function readProfile(db?: Connection) {
  const [row] = await query<{ profile: unknown; updated_at: Date }>(
    'SELECT profile,updated_at FROM computer_use_profile WHERE id=true',
    [],
    db,
  )
  const parsed = row ? performerProfileSchema.safeParse(row.profile) : null
  return {
    profile: parsed?.success ? parsed.data : emptyProfile(),
    updatedAt: row ? row.updated_at.toISOString() : null,
  }
}

export async function saveProfile(input: unknown) {
  const profile = validateProfile(input, config().COMPUTER_USE_PROPOSALS_PER_DAY)
  await query(
    `INSERT INTO computer_use_profile(id,profile,updated_at) VALUES(true,$1,now())
     ON CONFLICT (id) DO UPDATE SET profile=EXCLUDED.profile,updated_at=now()`,
    [JSON.stringify(profile)],
  )
  await audit('computer_use_profile', 'Владелец обновил профиль исполнителя.', {
    empty: isEmptyProfile(profile),
    rates: profile.rates.length,
    minimumPrices: profile.minimumPrices.map((m) => m.currency),
    samples: profile.samples.length,
    proposalsPerDay: profile.proposalsPerDay,
  })
  return profileView()
}

/** What the office shows: the profile, when it changed and the limits of every field. */
export async function profileView() {
  return {
    ...(await readProfile()),
    limits: { ...PROFILE_LIMITS, proposalsPerDay: config().COMPUTER_USE_PROPOSALS_PER_DAY },
  }
}
export type ProfileView = Awaited<ReturnType<typeof profileView>>

/** Compact copy for the model: empty fields are left out, `null` when nothing is filled in. */
export function profileForModel(profile: PerformerProfile) {
  if (isEmptyProfile(profile)) return null
  const out: Record<string, unknown> = {}
  if (profile.displayName) out.display_name = profile.displayName
  if (profile.bio) out.bio = profile.bio
  if (profile.skills.length) out.skills = profile.skills
  if (profile.languages.length) out.languages = profile.languages
  if (profile.rates.length)
    out.rates = profile.rates.map((r) => ({
      service: r.service,
      amount_minor: r.amount,
      currency: r.currency,
      ...(r.unit ? { unit: r.unit } : {}),
    }))
  if (profile.minimumPrices.length)
    out.minimum_price = profile.minimumPrices.map((m) => ({
      amount_minor: m.amount,
      currency: m.currency,
    }))
  if (profile.maxActiveJobs !== null) out.max_active_jobs = profile.maxActiveJobs
  if (profile.turnaround) out.turnaround = profile.turnaround
  if (profile.avoidTopics.length) out.avoid_topics = profile.avoidTopics
  if (profile.toneNotes) out.tone = profile.toneNotes
  if (profile.samples.length)
    out.samples = profile.samples.map((s) => ({
      title: s.title,
      ...(s.text ? { text: s.text } : {}),
      ...(s.url ? { url: s.url } : {}),
    }))
  if (profile.timezone) out.timezone = profile.timezone
  if (profile.availability) out.availability = profile.availability
  return out
}
export type ModelProfile = ReturnType<typeof profileForModel>

/** The owner override can only lower the env limit, never raise it. */
export const effectiveProposalsPerDay = (profile: PerformerProfile, envLimit: number) =>
  profile.proposalsPerDay === null ? envLimit : Math.min(envLimit, profile.proposalsPerDay)

/**
 * The price check of draft_proposal. With minimums set, a price needs a currency, and a price in
 * a currency with a minimum may not be below it. Without an explicit price the job budget the
 * model recorded counts as the bid when its currency has a minimum.
 */
export function priceReason(
  profile: PerformerProfile,
  price: { amount: number | null; currency: string | null },
  budget: { amount: number | null; currency: string | null } = { amount: null, currency: null },
) {
  if (!profile.minimumPrices.length) return ''
  if (price.amount !== null && !price.currency) return 'COMPUTER_USE_PRICE_CURRENCY_REQUIRED'
  const bid = price.amount !== null ? price : budget
  if (bid.amount === null || !bid.currency) return ''
  const minimum = profile.minimumPrices.find((m) => m.currency === bid.currency)
  return minimum && bid.amount < minimum.amount ? 'COMPUTER_USE_PRICE_BELOW_MINIMUM' : ''
}

/**
 * Owner-provided facts a proposal may repeat: claims about experience, degrees or portfolio are
 * allowed in a proposal only when the same words stand in the profile.
 */
export function verifiedFacts(profile: PerformerProfile) {
  return [
    profile.bio,
    ...profile.skills,
    ...profile.samples.flatMap((s) => [s.title, s.text]),
    // Real samples exist: the proposal may say it has a portfolio.
    profile.samples.length ? 'портфолио portfolio' : '',
  ]
    .filter(Boolean)
    .join('\n')
}
