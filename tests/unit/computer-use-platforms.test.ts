import { afterEach, describe, expect, it, vi } from 'vitest'
import * as settings from '../../core/config'
import {
  aiForbiddenReason,
  defaultPlatformDomains,
  forbiddenClaimReason,
  isFreelancePlatform,
  platformDomains,
  platformGoals,
  platformOf,
} from '../../core/computer-use/platforms'
import { validateGoal } from '../../core/computer-use/policy'
import { chunkStoredText } from '../../core/computer-use/schema'

const original = settings.config()
afterEach(() => vi.restoreAllMocks())

describe('freelance platforms', () => {
  it('recognises known platforms by host, subdomain and URL', () => {
    expect(platformOf('https://www.fl.ru/projects/123/')).toBe('fl.ru')
    expect(platformOf('kwork.ru')).toBe('kwork.ru')
    expect(platformOf('https://freelance.habr.com/tasks/1')).toBe('freelance.habr.com')
    expect(platformOf('https://habr.com/ru/')).toBe('')
    expect(platformOf('https://evil.example/fl.ru')).toBe('')
    expect(platformOf('https://fl.ru.evil.example/')).toBe('')
    expect(isFreelancePlatform('upwork.com')).toBe(true)
    expect(isFreelancePlatform('www.upwork.com')).toBe(false)
    expect(isFreelancePlatform('example.com')).toBe(false)
  })
  it('extends the list from the environment with valid names only', () => {
    vi.spyOn(settings, 'config').mockImplementation(() => ({
      ...original,
      COMPUTER_USE_PLATFORM_DOMAINS: ' Example-Jobs.com, not a domain, fl.ru ,localhost',
    }))
    const list = platformDomains()
    expect(list).toContain('example-jobs.com')
    expect(list).not.toContain('localhost')
    expect(list.filter((d) => d === 'fl.ru')).toHaveLength(1)
    expect(list.length).toBe(defaultPlatformDomains.length + 1)
  })
  it('generates two valid goals per logged-in platform', () => {
    const goals = platformGoals(['fl.ru', 'kwork.ru'], 15)
    expect(goals).toHaveLength(4)
    expect(goals[0]).toContain('fl.ru')
    expect(goals[0]).toContain('15 откликов')
    expect(goals[1]).toContain('prepare_send')
    for (const goal of goals) expect(validateGoal(goal)).toBe(goal)
    expect(platformGoals([], 15)).toEqual([])
  })
})

describe('AI-ban heuristics in job text', () => {
  it('finds Russian and English bans', () => {
    for (const text of [
      'Нужен копирайтер. Тексты без ИИ и нейросетей, только живой автор.',
      'Без использования ChatGPT! Проверяем на детекторе.',
      'Не используем нейросети, не предлагать.',
      'ИИ-тексты не принимаем, оплата после проверки.',
      'Статьи, написанные нейросетью, отклоняются без оплаты.',
      'Только вручную, никакого GPT.',
      'No AI tools allowed. Human-written content only.',
      'Please do not use ChatGPT or any LLM for this task.',
      'AI-generated text will be rejected.',
      'We need a writer without AI assistance.',
    ])
      expect([text, aiForbiddenReason(text)]).toEqual([text, 'COMPUTER_USE_AI_FORBIDDEN'])
  })
  it('does not flag jobs about AI or ordinary text', () => {
    for (const text of [
      'Нужен промпт-инженер со знанием ChatGPT для настройки бота.',
      'Описание товаров для интернет-магазина, 50 карточек, срок неделя.',
      'Looking for an AI prompt writer to improve our assistant.',
      'Перевод статьи об искусственном интеллекте с английского.',
      'Need a summary of a neural networks lecture.',
    ])
      expect([text, aiForbiddenReason(text)]).toEqual([text, ''])
  })
})

describe('forbidden claims in proposals and replies', () => {
  const ok = [
    'Здравствуйте! Прочитал задание: нужно 20 описаний товаров для каталога мебели. Сделаю в едином стиле, с характеристиками и выгодами для покупателя, без воды. Первые два описания пришлю на согласование в течение дня, остальные за три дня. Правки входят в стоимость. Цена за весь объём указана в отклике. Готов начать сразу после подтверждения.',
    'Hello! I read the brief carefully: you need a 1,500-word article on home composting for beginners. I will write it in a friendly, practical tone with clear steps and a short checklist at the end. The draft will be ready within two days, and I will revise it once at no extra cost. Happy to start right away.',
    'Срок до 20.10.2026, объём 10 000 знаков, стоимость 2 500 рублей за статью.',
  ]
  it('accepts plain proposals about the job, dates and prices', () => {
    for (const text of ok)
      expect([text.slice(0, 30), forbiddenClaimReason(text)]).toEqual([text.slice(0, 30), ''])
  })
  it('refuses contacts, off-platform payment, invented credentials, links and AI denial', () => {
    const cases: [string, string][] = [
      ['Пишите в телеграм @ivan_writer, обсудим.', 'COMPUTER_USE_CONTACT_DETAILS'],
      ['Мой номер +7 (999) 123-45-67, звоните.', 'COMPUTER_USE_CONTACT_DETAILS'],
      ['Email me at ivan@example.com for samples.', 'COMPUTER_USE_CONTACT_DETAILS'],
      [
        'Можно оплатить напрямую на карту без комиссии площадки.',
        'COMPUTER_USE_OFF_PLATFORM_PAYMENT',
      ],
      ['Переведите на Сбер, так дешевле.', 'COMPUTER_USE_OFF_PLATFORM_PAYMENT'],
      [
        'You can pay me directly via PayPal to avoid the platform fee.',
        'COMPUTER_USE_OFF_PLATFORM_PAYMENT',
      ],
      ['У меня 7 лет опыта в копирайтинге и диплом филолога.', 'COMPUTER_USE_UNVERIFIED_CLAIM'],
      ['Over 300 happy clients and a top-rated badge.', 'COMPUTER_USE_UNVERIFIED_CLAIM'],
      ['Посмотрите моё портфолио и отзывы.', 'COMPUTER_USE_UNVERIFIED_CLAIM'],
      ['Примеры работ: https://example.com/portfolio', 'COMPUTER_USE_EXTERNAL_LINK'],
      ['Пишу сам, без ИИ и нейросетей.', 'COMPUTER_USE_AI_DENIAL'],
      ['I never use AI, everything is human-written.', 'COMPUTER_USE_AI_DENIAL'],
      ['Нет, я не нейросеть, я живой автор.', 'COMPUTER_USE_AI_DENIAL'],
    ]
    for (const [text, reason] of cases)
      expect([text, forbiddenClaimReason(text)]).toEqual([text, reason])
  })
})

describe('stored text chunks', () => {
  it('splits at line or word boundaries within the VM limit', () => {
    const paragraph = 'слово '.repeat(500).trim()
    const text = `${paragraph}\n\n${paragraph}\n${paragraph}`
    const chunks = chunkStoredText(text)
    expect(chunks.join('')).toBe(text)
    expect(chunks.every((chunk) => chunk.length <= 2000 && chunk.length > 0)).toBe(true)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunkStoredText('short')).toEqual(['short'])
    expect(chunkStoredText('x'.repeat(4500)).map((c) => c.length)).toEqual([2000, 2000, 500])
  })
})
