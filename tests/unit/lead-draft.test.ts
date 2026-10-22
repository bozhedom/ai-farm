import { describe, expect, it } from 'vitest'
import { validateReplyDraft } from '../../core/policy'
import { demoReplyDraft } from '../../core/providers/demo'
import { leadTopic } from '../../core/jobs/lead'
import { formatRub } from '../../core/storefront'

const url = 'http://localhost:3210/services/description'
const ok =
  'Здравствуйте! Увидел ваш запрос про описания для Ozon. Пишем карточки по вашим характеристикам, без выдуманных свойств. Пример и заказ здесь: ' +
  url +
  '.'

describe('reply draft validation', () => {
  it('accepts a short draft with the product page as the only link', () => {
    expect(validateReplyDraft(ok, url, 'Описание товара')).toBe(ok)
  })

  it('rejects contacts, mentions and phone numbers', () => {
    expect(() => validateReplyDraft(ok + ' Пишите: shop@mail.ru', url)).toThrow(
      'POLICY_REPLY_CONTACT',
    )
    expect(() => validateReplyDraft(ok + ' Отвечу в телеграме @seller_bot', url)).toThrow(
      'POLICY_REPLY_CONTACT',
    )
    expect(() => validateReplyDraft(ok + ' Звоните 8 (999) 123-45-67', url)).toThrow(
      'POLICY_REPLY_CONTACT',
    )
  })

  it('accepts a product link whose host contains an IP address, but not phones next to it', () => {
    const ipUrl = 'https://farm.89.19.215.46.sslip.io/services/description'
    const draft = ok.replace(url, ipUrl)
    expect(validateReplyDraft(draft, ipUrl, 'Описание товара')).toBe(draft)
    expect(() => validateReplyDraft(draft + ' Звоните +7 999 123-45-67', ipUrl)).toThrow(
      'POLICY_REPLY_CONTACT',
    )
    expect(() => validateReplyDraft(draft + ' Пишите в телеграм', ipUrl)).toThrow(
      'POLICY_REPLY_CONTACT',
    )
    // The same IP outside the allowed link is still a phone-like run.
    expect(() => validateReplyDraft(draft + ' Адрес 89.19.215.46', ipUrl)).toThrow(
      /POLICY_REPLY_(CONTACT|URL)/,
    )
    expect(() => validateReplyDraft(draft.replace(ipUrl, `${ipUrl}?ref=1`), ipUrl)).toThrow(
      'POLICY_REPLY_URL',
    )
  })

  it('rejects any other link, bare domains included', () => {
    expect(() => validateReplyDraft(ok + ' Портфолио: https://evil.example/p', url)).toThrow(
      'POLICY_REPLY_URL',
    )
    expect(() => validateReplyDraft(ok + ' Ещё примеры на www.portfolio.ru', url)).toThrow(
      'POLICY_REPLY_URL',
    )
    expect(() => validateReplyDraft(ok + ' Канал t.me/seller или site.ru', url)).toThrow(
      'POLICY_REPLY_URL',
    )
    expect(() => validateReplyDraft(ok.replace(url, `${url}?ref=1`), url)).toThrow(
      'POLICY_REPLY_URL',
    )
  })

  it('rejects short links, any domain zone, other schemes, messengers and disguised contacts', () => {
    for (const tail of [
      ' Короткая ссылка bit.ly/abc123',
      ' Или vk.cc/xyz',
      ' Наш сайт studio.xyz',
      ' Звоните 8.900.123.45.67',
      ' Пишите tg://resolve?domain=seller',
      ' Напишите в телеграм seller_bot',
      ' Почта shop(at)mail(dot)ru',
      ' Ответим в WhatsApp',
      ' mailto:shop?subject=x',
      ' Пишите в личку',
      ' Ozon.ru подойдёт',
    ])
      expect(() => validateReplyDraft(ok + tail, url), tail).toThrow(/POLICY_REPLY_(CONTACT|URL)/)
    // Prices, counts and dates stay allowed.
    expect(validateReplyDraft(ok + ' Цена 1 490 ₽ за 30 описаний до 08.10.', url)).toBeTruthy()
  })

  it('rejects promises the product does not make', () => {
    expect(() => validateReplyDraft(ok + ' Даю скидку на первый заказ.', url)).toThrow(
      'POLICY_REPLY_PROMISE',
    )
    expect(() => validateReplyDraft(ok + ' Первый текст бесплатно.', url)).toThrow(
      'POLICY_REPLY_PROMISE',
    )
    expect(() => validateReplyDraft(ok + ' Гарантия результата.', url)).toThrow(
      'POLICY_REPLY_PROMISE',
    )
    expect(
      validateReplyDraft(ok + ' Без гарантий продаж.', url, 'Без гарантий продаж'),
    ).toBeTruthy()
  })

  it('rejects banned topics, HTML and wrong length', () => {
    expect(() => validateReplyDraft(ok + ' Поможем с накруткой отзывов.', url)).toThrow(
      'POLICY_CONTENT_BLOCKED',
    )
    expect(() => validateReplyDraft(ok + ' <b>жирный</b>', url)).toThrow()
    expect(() => validateReplyDraft('Коротко ' + url, url)).toThrow()
  })

  it('keeps demo drafts valid and strips names from the request topic', () => {
    const draft = demoReplyDraft({
      name: 'Описание товара',
      promise: 'Краткий черновик описания: название и список характеристик из исходного материала.',
      priceKopecks: 49000,
      publicUrl: url,
    })
    expect(validateReplyDraft(draft, url, 'Описание товара')).toBe(draft)
    expect(draft).toContain(formatRub(49000))
    expect(leadTopic('Иван Петров: нужен копирайтер для 30 описаний Ozon')).toBe(
      'нужен копирайтер для 30 описаний Ozon',
    )
    expect(leadTopic('Пишите ivan@mail.ru, ищу автора текстов').includes('@')).toBe(false)
    expect(leadTopic('x'.repeat(300))).toHaveLength(120)
  })
})
