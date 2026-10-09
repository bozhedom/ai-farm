import { describe, expect, it } from 'vitest'
import { serviceByTemplate, serviceTemplates } from '../../core/service-catalog'
import { buyerCopy, ownHeadline } from '../../core/public-catalog'
import { orderTitle, serviceName, serviceNames } from '../../core/service-names'

describe('one name per service', () => {
  it.each(serviceTemplates)('%s has the same name on the site and in the office', (id) => {
    expect(serviceByTemplate[id].label).toBe(serviceNames[id])
    expect(buyerCopy[id].name).toBe(serviceNames[id])
    expect(serviceName(id)).toBe(serviceNames[id])
  })

  it('keeps the stored name for unknown types', () => {
    expect(serviceName('unknown', 'Старое имя')).toBe('Старое имя')
    expect(serviceName(null)).toBe('Текстовая услуга')
  })

  it('writes short order numbers', () => {
    expect(orderTitle('1042')).toBe('Заказ №1042')
    expect(orderTitle(1001)).toBe('Заказ №1001')
    expect(orderTitle(null)).toBe('Заказ')
  })
})

describe('storefront promise', () => {
  it('does not repeat the service name or the idea title', () => {
    expect(
      ownHeadline('Коммерческие предложения по брифу клиента', [
        'Коммерческое предложение по брифу',
        'Коммерческие предложения по брифу клиента',
      ]),
    ).toBeNull()
    expect(ownHeadline('Текст для страницы услуги', ['Текст для страницы услуги'])).toBeNull()
  })

  it('keeps a short headline that says something new', () => {
    expect(ownHeadline('КП за пять минут', ['Коммерческое предложение по брифу'])).toBe(
      'КП за пять минут',
    )
    expect(ownHeadline('x'.repeat(60), [])).toBeNull()
    expect(ownHeadline(undefined, [])).toBeNull()
  })
})
