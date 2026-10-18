import { describe, expect, it } from 'vitest'
import {
  allowedSearchPhrases,
  categoryById,
  isTaxonomyTopic,
  taxonomyCategories,
  taxonomyTopics,
  topicsOf,
} from '../../core/taxonomy'
import { serviceTemplates } from '../../core/service-catalog'
import { validateContent } from '../../core/policy'
import { chooseTopic } from '../../core/autonomy'

describe('server taxonomy of legal industries', () => {
  it('covers 12 to 24 industries and earning directions with at least two topics each', () => {
    expect(taxonomyCategories.length).toBeGreaterThanOrEqual(12)
    expect(taxonomyCategories.length).toBeLessThanOrEqual(24)
    expect(new Set(taxonomyCategories.map((c) => c.id)).size).toBe(taxonomyCategories.length)
    for (const category of taxonomyCategories)
      expect(topicsOf(category.id).length).toBeGreaterThanOrEqual(2)
    expect(taxonomyTopics.length).toBeGreaterThanOrEqual(36)
    expect(new Set(taxonomyTopics.map((t) => t.id)).size).toBe(taxonomyTopics.length)
  })

  it('gives every topic server search phrases, hints and honest angles', () => {
    for (const topic of taxonomyTopics) {
      expect(categoryById[topic.category]).toBeDefined()
      expect(topic.queries.length).toBeGreaterThanOrEqual(2)
      expect(topic.hints.length).toBeGreaterThan(0)
      expect(topic.angles.length).toBeGreaterThanOrEqual(2)
      for (const phrase of topic.queries) {
        expect(phrase.length).toBeGreaterThan(10)
        expect(allowedSearchPhrases.has(phrase)).toBe(true)
      }
      for (const angle of topic.angles)
        if (angle.template) expect(serviceTemplates).toContain(angle.template)
    }
    // Both kinds of ideas exist: what the farm can do and what needs a person.
    const angles = taxonomyTopics.flatMap((t) => t.angles)
    expect(angles.some((a) => a.template === null)).toBe(true)
    expect(angles.some((a) => a.template !== null)).toBe(true)
  })

  it('includes earning directions beyond client texts, with honest human steps', () => {
    for (const id of [
      'crypto-rewards',
      'grants',
      'digital-goods',
      'freelance',
      'own-shop',
      'own-media',
    ]) {
      const angles = topicsOf(id).flatMap((t) => t.angles)
      expect(angles.length, id).toBeGreaterThanOrEqual(4)
      expect(
        angles.some((a) => a.template === null),
        id,
      ).toBe(true)
    }
  })

  it('contains no excluded area and no decorated text', () => {
    const text = JSON.stringify([taxonomyCategories, taxonomyTopics])
    expect(() => validateContent(text)).not.toThrow()
    expect(text).not.toMatch(
      /(?<!\p{L})(?:казино|ставк|эротик|политик|диплом|курсов(?:ая|ые) работ|накрутк|рассылк)/iu,
    )
    expect(text).not.toMatch(/[—→←·]/)
  })

  it('rejects unknown topics', () => {
    expect(isTaxonomyTopic('marketplaces-cards')).toBe(true)
    expect(isTaxonomyTopic('casino')).toBe(false)
    expect(isTaxonomyTopic(undefined)).toBe(false)
  })

  it('assigns different topics and industries to agents on one day', () => {
    const rows = taxonomyTopics.map((t) => ({
      topic_id: t.id,
      category: t.category,
      scout_count: 0,
      last_scouted_at: null as Date | null,
    }))
    const day = new Date('2026-10-08T00:00:00Z')
    const picked: string[] = []
    for (const focus of [['food'], ['food'], ['handmade', 'food'], ['it']]) {
      const topic = chooseTopic(rows, focus, day)
      picked.push(topic.topic_id)
      const row = rows.find((r) => r.topic_id === topic.topic_id)!
      row.scout_count++
      row.last_scouted_at = new Date('2026-10-08T09:00:00Z')
    }
    expect(new Set(picked).size).toBe(4)
    const categories = picked.map((id) => taxonomyTopics.find((t) => t.id === id)!.category)
    expect(new Set(categories).size).toBe(4)
    expect(categories[0]).toBe('food')
    expect(categories[2]).toBe('handmade')
    expect(categories[3]).toBe('it')
    // The least recently scouted topic wins inside the focus.
    const old = rows.find((r) => r.topic_id === 'food-menu')!
    old.last_scouted_at = new Date('2026-10-01T00:00:00Z')
    const local = rows.find((r) => r.topic_id === 'food-local')!
    local.last_scouted_at = new Date('2026-10-05T00:00:00Z')
    expect(chooseTopic(rows, ['food'], new Date('2026-10-09T00:00:00Z')).topic_id).toBe('food-menu')
  })
})
