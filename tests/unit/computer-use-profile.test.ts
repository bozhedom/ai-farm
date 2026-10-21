import { describe, expect, it } from 'vitest'
import { prepareStepRequest } from '../../core/computer-use/model'
import { forbiddenClaimReason } from '../../core/computer-use/platforms'
import {
  effectiveProposalsPerDay,
  emptyProfile,
  isEmptyProfile,
  priceReason,
  profileForModel,
  validateProfile,
  verifiedFacts,
  type PerformerProfile,
} from '../../core/computer-use/profile'

const filled = (extra: Partial<PerformerProfile> = {}): PerformerProfile => ({
  ...emptyProfile(),
  displayName: 'Анна К.',
  bio: 'Пишу описания товаров для интернет-магазинов. 3 года опыта в копирайтинге.',
  skills: ['Описания товаров', 'Редактура'],
  languages: ['русский', 'английский'],
  rates: [{ service: 'Описание товара', amount: 50000, currency: 'RUB', unit: 'за штуку' }],
  minimumPrices: [
    { currency: 'RUB', amount: 100000 },
    { currency: 'USD', amount: 2000 },
  ],
  avoidTopics: ['казино и ставки'],
  samples: [{ title: 'Описания для магазина посуды', text: 'Чайник из стали.', url: '' }],
  ...extra,
})

describe('performer profile validation', () => {
  it('accepts a filled profile and fills defaults for missing fields', () => {
    const profile = validateProfile(filled(), 15)
    expect(profile.rates[0]!.amount).toBe(50000)
    expect(validateProfile({}, 15)).toEqual(emptyProfile())
    expect(isEmptyProfile(emptyProfile())).toBe(true)
    expect(isEmptyProfile(profile)).toBe(false)
    // An owner may avoid excluded topics by name: the list is not a scheme check.
    expect(validateProfile({ avoidTopics: ['казино', 'курсовые работы'] }, 15).avoidTopics).toEqual(
      ['казино', 'курсовые работы'],
    )
  })

  it('refuses wrong shapes: floats, long bio, duplicates, unknown keys, empty samples', () => {
    const bad = [
      { rates: [{ service: 'Статья', amount: 10.5, currency: 'RUB', unit: '' }] },
      { minimumPrices: [{ currency: 'RUB', amount: 0 }] },
      {
        minimumPrices: [
          { currency: 'RUB', amount: 100 },
          { currency: 'rub', amount: 200 },
        ],
      },
      { bio: 'а'.repeat(601) },
      { skills: ['Редактура', 'редактура'] },
      { samples: [{ title: 'Пример работы', text: '', url: '' }] },
      { bio: 'Текст <script>' },
      { wallet: '0x0' },
      { maxActiveJobs: 0 },
    ]
    for (const input of bad)
      expect(() => validateProfile(input, 15), JSON.stringify(input)).toThrow(
        'COMPUTER_USE_PROFILE_INVALID',
      )
  })

  it('applies the content checks that would leak into proposals', () => {
    expect(() => validateProfile({ proposalsPerDay: 20 }, 15)).toThrow(
      'COMPUTER_USE_PROFILE_PROPOSALS_OVER_LIMIT',
    )
    expect(validateProfile({ proposalsPerDay: 15 }, 15).proposalsPerDay).toBe(15)
    expect(() => validateProfile({ bio: 'Пишите в телеграм @anna_texts' }, 15)).toThrow(
      'COMPUTER_USE_PROFILE_CONTACT_DETAILS',
    )
    expect(() => validateProfile({ bio: 'Тексты пишу без ИИ и нейросетей' }, 15)).toThrow(
      'COMPUTER_USE_PROFILE_AI_DENIAL',
    )
    expect(() => validateProfile({ bio: 'Оплата напрямую на карту без комиссии' }, 15)).toThrow(
      /COMPUTER_USE_PROFILE_(OFF_PLATFORM_PAYMENT|TOPIC_BLOCKED)/,
    )
    expect(() => validateProfile({ bio: 'Моё портфолио: https://example.com/me' }, 15)).toThrow(
      'COMPUTER_USE_PROFILE_EXTERNAL_LINK',
    )
    expect(() => validateProfile({ skills: ['Мультиаккаунты на биржах'] }, 15)).toThrow(
      'COMPUTER_USE_PROFILE_TOPIC_BLOCKED',
    )
    for (const url of ['http://192.168.0.1/work', 'https://paypal.com/me', 'ftp://x.example'])
      expect(() =>
        validateProfile({ samples: [{ title: 'Пример работы', text: '', url }] }, 15),
      ).toThrow(/COMPUTER_USE_PROFILE_(SAMPLE_URL|INVALID)/)
    // The owner's own facts are not "invented claims".
    expect(validateProfile({ bio: 'Диплом филолога, 5 лет опыта в переводах.' }, 15).bio).toContain(
      'Диплом',
    )
  })
})

describe('performer profile in the model input', () => {
  const base = {
    taskId: 't',
    reservationId: 'r',
    goal: 'Проверь новые задания на fl.ru и откликнись на подходящие',
    stepNo: 3,
    stepLimit: 30,
    history: [],
    page: { url: 'https://www.fl.ru/projects/', title: 'Проекты' },
    png: null,
    opportunities: 0,
  }

  it('sends a compact profile and tells the model how to use it', () => {
    const profile = profileForModel(filled())
    const request = prepareStepRequest({ ...base, profile })
    const sent = JSON.parse(request.text)
    expect(sent.profile).toMatchObject({
      display_name: 'Анна К.',
      rates: [{ service: 'Описание товара', amount_minor: 50000, currency: 'RUB' }],
      minimum_price: [
        { amount_minor: 100000, currency: 'RUB' },
        { amount_minor: 2000, currency: 'USD' },
      ],
      avoid_topics: ['казино и ставки'],
    })
    // Empty fields are left out.
    expect(sent.profile).not.toHaveProperty('turnaround')
    expect(request.system).toContain('profile.minimum_price')
    expect(request.system).toContain('profile.avoid_topics')
    expect(request.system).toContain('decision human')
    // Without a profile the field is null and the generic-proposal rule is still in the prompt.
    expect(profileForModel(emptyProfile())).toBeNull()
    expect(JSON.parse(prepareStepRequest(base).text).profile).toBeNull()
  })

  it('counts the profile bytes in the reserve estimate', () => {
    const big = profileForModel(
      filled({ bio: 'б'.repeat(600), toneNotes: 'т'.repeat(400), turnaround: 'с'.repeat(400) }),
    )
    const without = prepareStepRequest(base)
    const withProfile = prepareStepRequest({ ...base, profile: big })
    // The profile replaces `null` in the envelope; every other byte of it is counted.
    const bytes = Buffer.byteLength(JSON.stringify(big), 'utf8') - 'null'.length
    expect(withProfile.upperInput - without.upperInput).toBeGreaterThanOrEqual(bytes)
    expect(withProfile.upperInput).toBeGreaterThanOrEqual(
      Buffer.byteLength(withProfile.system + withProfile.text, 'utf8'),
    )
  })
})

describe('performer profile limits', () => {
  it('blocks a price below the minimum of its currency', () => {
    const profile = filled()
    const none = { amount: null, currency: null }
    expect(priceReason(profile, { amount: 99999, currency: 'RUB' })).toBe(
      'COMPUTER_USE_PRICE_BELOW_MINIMUM',
    )
    expect(priceReason(profile, { amount: 100000, currency: 'RUB' })).toBe('')
    expect(priceReason(profile, { amount: 1999, currency: 'USD' })).toBe(
      'COMPUTER_USE_PRICE_BELOW_MINIMUM',
    )
    // No minimum in this currency: no rule to apply.
    expect(priceReason(profile, { amount: 1, currency: 'EUR' })).toBe('')
    expect(priceReason(profile, { amount: 500, currency: null })).toBe(
      'COMPUTER_USE_PRICE_CURRENCY_REQUIRED',
    )
    // Without an explicit price the recorded job budget is the bid.
    expect(priceReason(profile, none, { amount: 50000, currency: 'RUB' })).toBe(
      'COMPUTER_USE_PRICE_BELOW_MINIMUM',
    )
    expect(priceReason(profile, none, none)).toBe('')
    expect(priceReason(emptyProfile(), { amount: 1, currency: 'RUB' })).toBe('')
  })

  it('lowers but never raises the proposal limit', () => {
    expect(effectiveProposalsPerDay(emptyProfile(), 15)).toBe(15)
    expect(effectiveProposalsPerDay(filled({ proposalsPerDay: 5 }), 15)).toBe(5)
    expect(effectiveProposalsPerDay(filled({ proposalsPerDay: 50 }), 15)).toBe(15)
  })

  it('lets a proposal repeat the owner facts word for word and nothing more', () => {
    const facts = verifiedFacts(filled())
    const text = 'Здравствуйте! У меня 3 года опыта в копирайтинге, могу показать портфолио.'
    expect(forbiddenClaimReason(text)).toBe('COMPUTER_USE_UNVERIFIED_CLAIM')
    expect(forbiddenClaimReason(text, facts)).toBe('')
    expect(forbiddenClaimReason('У меня 10 лет опыта в копирайтинге.', facts)).toBe(
      'COMPUTER_USE_UNVERIFIED_CLAIM',
    )
    expect(forbiddenClaimReason('Есть диплом журналиста.', facts)).toBe(
      'COMPUTER_USE_UNVERIFIED_CLAIM',
    )
    // Without samples there is no portfolio to mention.
    expect(forbiddenClaimReason('Покажу портфолио.', verifiedFacts(filled({ samples: [] })))).toBe(
      'COMPUTER_USE_UNVERIFIED_CLAIM',
    )
    // Contacts stay forbidden whatever the profile says.
    expect(forbiddenClaimReason('Пишите в телеграм @anna_texts', facts)).toBe(
      'COMPUTER_USE_CONTACT_DETAILS',
    )
  })
})
