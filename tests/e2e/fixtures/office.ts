import type {
  CritiqueVerdict,
  EvolutionRound,
  IdeaStatus,
  OfficeAgent,
  OfficeAgents,
  OfficeIdea,
  OfficeLead,
  OfficeMoney,
  OfficeOrderSummary,
  OfficeOverview,
  OfficeProduct,
  OfficeReport,
  OfficeSettings,
} from '../../../core/contracts/office'
import { taxonomyCategories } from '../../../core/taxonomy'

/**
 * Typed office data for Playwright route stubs. Realistic Russian content: four scouts after one
 * selection round (two retired, two copies), 22 ideas across industries, leads with replies,
 * orders and money. Dates are relative to `now`, so «сегодня» stays today.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export function officeFixtures(now = new Date()) {
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60000).toISOString()
  const daysAgo = (days: number, hour = 10) => {
    const date = new Date(now)
    date.setDate(date.getDate() - days)
    date.setHours(hour, 12, 0, 0)
    return date.toISOString()
  }
  const inMinutes = (minutes: number) => new Date(now.getTime() + minutes * 60000).toISOString()

  const agentIds = {
    a: uuid(101),
    b: uuid(102),
    v: uuid(103),
    g: uuid(104),
    a2: uuid(105),
    b2: uuid(106),
  }
  const roundId = uuid(201)

  const agents: OfficeAgent[] = [
    {
      id: agentIds.a,
      name: 'Разведчик А',
      status: 'active',
      generation: 1,
      parentId: null,
      params: {
        focusCategories: ['Общепит и доставка', 'Красота и бытовые услуги'],
        evidenceMinimum: 3,
        tone: 'plain',
        ideaScope: 'narrow',
        riskAppetite: 'low',
      },
      mutation: null,
      metrics: {
        ideas: 9,
        passed: 7,
        duplicates: 0,
        builtPassed: 2,
        delivered: 6,
        review: 1,
        costKopecks: 3150,
      },
      score: { total: 842, components: { P: 778, E: 930, U: 1000, B: 1000, C: 860, D: 857 } },
      retired: null,
    },
    {
      id: agentIds.b,
      name: 'Разведчик Б',
      status: 'active',
      generation: 1,
      parentId: null,
      params: {
        focusCategories: ['Хендмейд и мастерские', 'Маркетплейсы и интернет-магазины'],
        evidenceMinimum: 2,
        tone: 'friendly',
        ideaScope: 'broad',
        riskAppetite: 'medium',
      },
      mutation: null,
      metrics: {
        ideas: 8,
        passed: 5,
        duplicates: 1,
        builtPassed: 1,
        delivered: 3,
        review: 0,
        costKopecks: 3800,
      },
      score: { total: 776, components: { P: 625, E: 880, U: 875, B: 1000, C: 860, D: null } },
      retired: null,
    },
    {
      id: agentIds.v,
      name: 'Разведчик В',
      status: 'archived',
      generation: 1,
      parentId: null,
      params: {
        focusCategories: ['Репетиторы и обучение'],
        evidenceMinimum: 2,
        tone: 'expert',
        ideaScope: 'broad',
        riskAppetite: 'medium',
      },
      mutation: null,
      metrics: {
        ideas: 6,
        passed: 1,
        duplicates: 2,
        builtPassed: 0,
        delivered: 0,
        review: 0,
        costKopecks: 3540,
      },
      score: { total: 381, components: { P: 167, E: 610, U: 667, B: null, C: 760, D: null } },
      retired: {
        at: daysAgo(3, 9),
        reason: 'Критик принял 1 идею из 6, две повторяли старые.',
        roundId,
      },
    },
    {
      id: agentIds.g,
      name: 'Разведчик Г',
      status: 'archived',
      generation: 1,
      parentId: null,
      params: {
        focusCategories: ['Авто'],
        evidenceMinimum: 2,
        tone: 'plain',
        ideaScope: 'narrow',
        riskAppetite: 'medium',
      },
      mutation: null,
      metrics: {
        ideas: 6,
        passed: 2,
        duplicates: 0,
        builtPassed: 0,
        delivered: 0,
        review: 1,
        costKopecks: 4020,
      },
      score: { total: 455, components: { P: 333, E: 540, U: 1000, B: null, C: 730, D: null } },
      retired: {
        at: daysAgo(3, 9),
        reason: 'Критик принял 2 идеи из 6, источники слабые.',
        roundId,
      },
    },
    {
      id: agentIds.a2,
      name: 'Разведчик А2',
      status: 'active',
      generation: 2,
      parentId: agentIds.a,
      params: {
        focusCategories: ['B2B-услуги и агентства', 'Красота и бытовые услуги'],
        evidenceMinimum: 3,
        tone: 'plain',
        ideaScope: 'narrow',
        riskAppetite: 'low',
      },
      mutation: {
        param: 'focusCategories',
        from: ['Общепит и доставка'],
        to: ['B2B-услуги и агентства'],
      },
      metrics: {
        ideas: 3,
        passed: 2,
        duplicates: 0,
        builtPassed: 0,
        delivered: 0,
        review: 0,
        costKopecks: 1110,
      },
      score: {
        total: 713,
        components: { P: 667, E: 890, U: 1000, B: null, C: 860, D: null },
        lowData: true,
      },
      retired: null,
    },
    {
      id: agentIds.b2,
      name: 'Разведчик Б2',
      status: 'active',
      generation: 2,
      parentId: agentIds.b,
      params: {
        focusCategories: ['Хендмейд и мастерские', 'Маркетплейсы и интернет-магазины'],
        evidenceMinimum: 2,
        tone: 'expert',
        ideaScope: 'broad',
        riskAppetite: 'medium',
      },
      mutation: { param: 'tone', from: 'friendly', to: 'expert' },
      metrics: {
        ideas: 1,
        passed: 0,
        duplicates: 0,
        builtPassed: 0,
        delivered: 0,
        review: 0,
        costKopecks: 520,
      },
      score: null,
      retired: null,
    },
  ]

  const rounds: EvolutionRound[] = [
    {
      id: roundId,
      generation: 1,
      decision: 'ROTATED',
      reason: 'У всех по 6 идей и больше, разрыв между вторым и третьим 32 балла.',
      trigger: 'scheduled',
      isDemo: false,
      at: daysAgo(3, 9),
      scores: [
        { agentId: agentIds.a, name: 'Разведчик А', score: 842 },
        { agentId: agentIds.b, name: 'Разведчик Б', score: 776 },
        { agentId: agentIds.g, name: 'Разведчик Г', score: 455 },
        { agentId: agentIds.v, name: 'Разведчик В', score: 381 },
      ],
      archived: [agentIds.v, agentIds.g],
      children: [
        { id: agentIds.a2, parentId: agentIds.a, mutation: agents[4]!.mutation! },
        { id: agentIds.b2, parentId: agentIds.b, mutation: agents[5]!.mutation! },
      ],
    },
  ]

  const officeAgents: OfficeAgents = {
    generation: 2,
    agents,
    evolution: {
      enabled: true,
      minIdeas: 6,
      roundsPerDay: 1,
      roundsToday: 0,
      ready: false,
      reason: 'Ждём идей от копий: нужно по 6 у каждого.',
      missing: [
        { agentId: agentIds.a2, need: 3 },
        { agentId: agentIds.b2, need: 5 },
      ],
      financial: { decision: 'HOLD', reason: 'Продаж за деньги пока нет.', at: daysAgo(1, 9) },
    },
    rounds,
  }

  type Seed = {
    title: string
    category: string
    topic: string
    status: IdeaStatus
    score: number
    farm: boolean
    template: string | null
    agent: keyof typeof agentIds
    verdict: CritiqueVerdict
    reason: string
    audience: string
    problem: string
    days: number
    startup: number
    monthly: number
  }
  const seeds: Seed[] = [
    {
      title: 'Ответы на частые вопросы для студий маникюра',
      category: 'Красота и бытовые услуги',
      topic: 'FAQ салона',
      status: 'productized',
      score: 88,
      farm: true,
      template: 'faq',
      agent: 'a',
      verdict: 'PASS',
      reason: 'Спрос подтверждён в трёх чатах мастеров, шаблонов на русском мало.',
      audience: 'Владельцы студий маникюра на 2-5 мастеров',
      problem: 'Администратор весь день отвечает на одни и те же вопросы про цены и запись',
      days: 6,
      startup: 0,
      monthly: 0,
    },
    {
      title: 'Описания изделий для мастеров на Ярмарке Мастеров',
      category: 'Хендмейд и мастерские',
      topic: 'Описания изделий',
      status: 'productized',
      score: 84,
      farm: true,
      template: 'description',
      agent: 'b',
      verdict: 'PASS',
      reason: 'Мастера прямо просят помочь с текстами, есть платные исполнители от 300 ₽.',
      audience: 'Мастера керамики, украшений и вязаных вещей',
      problem: 'Карточки без описания продаются хуже, писать мастерам некогда',
      days: 5,
      startup: 0,
      monthly: 0,
    },
    {
      title: 'Меню для агрегаторов доставки с описаниями блюд',
      category: 'Общепит и доставка',
      topic: 'Меню для агрегаторов',
      status: 'accepted',
      score: 81,
      farm: true,
      template: 'description',
      agent: 'a',
      verdict: 'PASS',
      reason: 'Агрегаторы требуют описания, у малых кафе их нет.',
      audience: 'Небольшие кафе и пекарни на Яндекс Еде',
      problem: 'Блюда без описания реже заказывают, а писать 40 позиций долго',
      days: 0,
      startup: 0,
      monthly: 0,
    },
    {
      title: 'Вакансии для мастерских и малых производств',
      category: 'Найм и HR',
      topic: 'Тексты вакансий',
      status: 'productized',
      score: 79,
      farm: true,
      template: 'job_post',
      agent: 'a',
      verdict: 'PASS',
      reason: 'На hh.ru много слабых вакансий от малого бизнеса, откликов мало.',
      audience: 'Владельцы мастерских, которые нанимают 1-3 человек',
      problem: 'Вакансия «нужен работник» не собирает отклики',
      days: 4,
      startup: 0,
      monthly: 0,
    },
    {
      title: 'Ответы гостям посуточных квартир',
      category: 'Туризм, гостиницы, посуточная аренда',
      topic: 'Ответы гостям',
      status: 'productized',
      score: 77,
      farm: true,
      template: 'email',
      agent: 'b',
      verdict: 'PASS',
      reason: 'Хозяева квартир просят шаблоны ответов на отзывы на Авито и Островке.',
      audience: 'Хозяева 1-5 квартир посуточно',
      problem: 'Плохой отзыв без ответа отпугивает следующих гостей',
      days: 2,
      startup: 0,
      monthly: 0,
    },
    {
      title: 'Коммерческие предложения для студий ремонта',
      category: 'Ремонт, стройка, отделка',
      topic: 'КП по брифу',
      status: 'accepted',
      score: 75,
      farm: true,
      template: 'proposal',
      agent: 'a2',
      verdict: 'PASS',
      reason: 'КП нужны каждую неделю, бригадиры пишут их в мессенджере.',
      audience: 'Небольшие бригады и студии ремонта',
      problem: 'Клиент получает смету без пояснений и уходит к другому',
      days: 0,
      startup: 0,
      monthly: 0,
    },
    {
      title: 'Выездная мойка окон в спальных районах',
      category: 'Красота и бытовые услуги',
      topic: 'Бытовые услуги',
      status: 'needs_human',
      score: 73,
      farm: false,
      template: null,
      agent: 'b',
      verdict: 'PASS',
      reason: 'Спрос сезонный и заметный, но нужны люди и инвентарь.',
      audience: 'Жители многоэтажек, весна и осень',
      problem: 'Мыть окна на высоте опасно и долго',
      days: 1,
      startup: 60000,
      monthly: 25000,
    },
    {
      title: 'Перевод меню кафе на английский и китайский',
      category: 'Общепит и доставка',
      topic: 'Перевод меню',
      status: 'productized',
      score: 72,
      farm: true,
      template: 'translation',
      agent: 'a',
      verdict: 'PASS',
      reason: 'Туристические районы, просьбы в чатах рестораторов.',
      audience: 'Кафе в туристических районах',
      problem: 'Иностранцы не понимают меню и уходят',
      days: 8,
      startup: 0,
      monthly: 0,
    },
    {
      title: 'Посты для мастеров из одного длинного текста',
      category: 'Блогеры и контент',
      topic: 'Посты из текста',
      status: 'productized',
      score: 70,
      farm: true,
      template: 'social',
      agent: 'b',
      verdict: 'PASS',
      reason: 'Мастера пишут длинные тексты раз в месяц, постов нужно больше.',
      audience: 'Мастера красоты и ремесла с соцсетями',
      problem: 'Нет времени писать посты каждую неделю',
      days: 7,
      startup: 0,
      monthly: 0,
    },
    {
      title: 'Мобильный шиномонтаж по вызову',
      category: 'Авто',
      topic: 'Шиномонтаж',
      status: 'needs_human',
      score: 68,
      farm: false,
      template: null,
      agent: 'g',
      verdict: 'PASS',
      reason: 'В сезон очереди по 2 часа, но нужен фургон и мастер.',
      audience: 'Автовладельцы в спальных районах',
      problem: 'Сезонная смена шин занимает полдня',
      days: 9,
      startup: 450000,
      monthly: 80000,
    },
    {
      title: 'Памятки после груминга для зоосалонов',
      category: 'Питомцы',
      topic: 'Памятки груминга',
      status: 'new',
      score: 66,
      farm: true,
      template: 'instruction',
      agent: 'a2',
      verdict: 'REVISE',
      reason: 'Нужно больше подтверждений спроса, пока один источник.',
      audience: 'Небольшие груминг-салоны',
      problem: 'Клиенты звонят с одними и теми же вопросами после стрижки',
      days: 0,
      startup: 0,
      monthly: 0,
    },
    {
      title: 'Программы занятий для репетиторов английского',
      category: 'Репетиторы и обучение',
      topic: 'Программы занятий',
      status: 'accepted',
      score: 64,
      farm: true,
      template: 'lesson',
      agent: 'v',
      verdict: 'PASS',
      reason: 'Репетиторы покупают готовые планы уроков.',
      audience: 'Частные репетиторы английского',
      problem: 'Готовить план каждого урока долго',
      days: 5,
      startup: 0,
      monthly: 0,
    },
    {
      title: 'Описания фермерской продукции для рынков',
      category: 'Фермерство и локальные продукты',
      topic: 'Описания продукции',
      status: 'new',
      score: 61,
      farm: true,
      template: 'description',
      agent: 'b2',
      verdict: 'REVISE',
      reason: 'Похоже на описания товаров, нужно отличие.',
      audience: 'Фермеры, которые продают на рынках и в группах',
      problem: 'Покупатели не понимают, чем продукция лучше магазинной',
      days: 0,
      startup: 0,
      monthly: 0,
    },
    {
      title: 'Чек-лист приёмки ремонта для заказчика',
      category: 'Ремонт, стройка, отделка',
      topic: 'Чек-лист приёмки',
      status: 'needs_human',
      score: 59,
      farm: false,
      template: null,
      agent: 'a',
      verdict: 'PASS',
      reason: 'Нужен эксперт по стройке, чтобы проверить пункты.',
      audience: 'Люди, которые принимают ремонт квартиры',
      problem: 'Бригада сдаёт работу с недочётами',
      days: 3,
      startup: 30000,
      monthly: 0,
    },
    {
      title: 'Сценарии детских праздников для аниматоров',
      category: 'Дети и семья',
      topic: 'Сценарии праздников',
      status: 'new',
      score: 57,
      farm: true,
      template: 'instruction',
      agent: 'b',
      verdict: 'REVISE',
      reason: 'Много бесплатных сценариев, нужен узкий угол.',
      audience: 'Начинающие аниматоры',
      problem: 'Сценарии повторяются, дети скучают',
      days: 1,
      startup: 0,
      monthly: 0,
    },
    {
      title: 'Правила проживания для гостевых домов',
      category: 'Туризм, гостиницы, посуточная аренда',
      topic: 'Правила проживания',
      status: 'accepted',
      score: 55,
      farm: true,
      template: 'instruction',
      agent: 'a2',
      verdict: 'PASS',
      reason: 'Хозяева просят шаблоны в профильных чатах.',
      audience: 'Владельцы гостевых домов',
      problem: 'Гости нарушают правила, потому что их никто не написал',
      days: 0,
      startup: 0,
      monthly: 0,
    },
    {
      title: 'Тексты для автосервиса о сезонном обслуживании',
      category: 'Авто',
      topic: 'Тексты для автосервиса',
      status: 'rejected',
      score: 44,
      farm: true,
      template: 'social',
      agent: 'g',
      verdict: 'BLOCKED',
      reason: 'Бесплатных шаблонов полно на первой странице поиска.',
      audience: 'Небольшие автосервисы',
      problem: 'Клиенты забывают про сезонное ТО',
      days: 4,
      startup: 0,
      monthly: 0,
    },
    {
      title: 'Инструкции пользователя для малых IT-сервисов',
      category: 'Малые IT и сервисы',
      topic: 'Инструкции',
      status: 'productized',
      score: 63,
      farm: true,
      template: 'instruction',
      agent: 'a',
      verdict: 'PASS',
      reason: 'Стартапы ищут, кто напишет справку простыми словами.',
      audience: 'Команды из 2-10 человек',
      problem: 'Пользователи пишут в поддержку вместо того, чтобы прочитать справку',
      days: 10,
      startup: 0,
      monthly: 0,
    },
    {
      title: 'Перепродажа билетов на концерты',
      category: 'Мероприятия и праздники',
      topic: 'Билеты',
      status: 'rejected',
      score: 22,
      farm: false,
      template: null,
      agent: 'v',
      verdict: 'BLOCKED',
      reason: 'Нет законного способа проверить спрос, высокий риск.',
      audience: 'Фанаты популярных артистов',
      problem: 'Билеты быстро заканчиваются',
      days: 4,
      startup: 100000,
      monthly: 0,
    },
    {
      title: 'Гайды для новичков в скалолазных секциях',
      category: 'Спорт и хобби (не медицина)',
      topic: 'Гайды для новичков',
      status: 'rejected',
      score: 38,
      farm: true,
      template: 'lesson',
      agent: 'v',
      verdict: 'BLOCKED',
      reason: 'Повторяет идею про секции, источники не про спрос.',
      audience: 'Скалодромы и секции',
      problem: 'Новички бросают после первого занятия',
      days: 4,
      startup: 0,
      monthly: 0,
    },
    {
      title: 'Описания курсов для онлайн-школ рисования',
      category: 'Онлайн-эксперты и курсы',
      topic: 'Описания курсов',
      status: 'new',
      score: 52,
      farm: true,
      template: 'landing',
      agent: 'b2',
      verdict: 'REVISE',
      reason: 'Спрос есть, но конкуренты сильные. Нужен быстрый тест.',
      audience: 'Преподаватели рисования с онлайн-курсами',
      problem: 'Страница курса не объясняет, что получит ученик',
      days: 0,
      startup: 0,
      monthly: 0,
    },
    {
      title: 'Сборка свадебных бутоньерок на заказ',
      category: 'Хендмейд и мастерские',
      topic: 'Бутоньерки',
      status: 'needs_human',
      score: 47,
      farm: false,
      template: null,
      agent: 'b',
      verdict: 'PASS',
      reason: 'Нужны руки и материалы, ферма это не сделает.',
      audience: 'Пары, которые женятся летом',
      problem: 'Готовые бутоньерки однотипные',
      days: 6,
      startup: 15000,
      monthly: 5000,
    },
  ]

  const ideas: OfficeIdea[] = seeds
    .map((s, i) => {
      const id = uuid(300 + i)
      const agent = agents.find((a) => a.id === agentIds[s.agent])!
      return {
        id,
        title: s.title,
        category: s.category,
        categoryId:
          taxonomyCategories.find((c) => c.label === s.category)?.id ??
          `c-${s.category.length}-${s.category.slice(0, 3)}`,
        topic: s.topic,
        status: s.status,
        rankScore: s.score,
        farmExecutable: s.farm,
        suggestedTemplate: s.template,
        agent: { id: agent.id, name: agent.name },
        createdAt: s.days === 0 ? at(40 + i * 17) : daysAgo(s.days, 9 + (i % 8)),
        isDemo: false,
        duplicateOf: i === 19 ? uuid(311) : null,
        research: {
          audience: s.audience,
          problem: s.problem,
          demandSignals: [
            {
              claim: `В профильном чате за месяц 14 сообщений с просьбой помочь: «${s.topic.toLowerCase()}».`,
              url: 'https://vc.ru/u/1203-malyy-biznes/840122-kto-pishet-teksty',
            },
            {
              claim: 'На бирже фриланса 9 похожих заказов за неделю, бюджет от 500 ₽.',
              url: 'https://www.fl.ru/projects/category/copywriting/',
            },
            ...(s.score > 70
              ? [
                  {
                    claim: 'Вопрос задают на форуме владельцев малого бизнеса.',
                    url: 'https://forum.biznet.ru/threads/42117',
                  },
                ]
              : []),
          ],
          competitors: [
            'Фрилансеры на бирже: от 800 ₽, срок 1-3 дня',
            'Бесплатные шаблоны в статьях, без учёта деталей бизнеса',
          ],
          revenueModel: s.farm ? 'per_order' : 'service',
          revenueNote: s.farm
            ? 'Оплата за каждый текст. Себестоимость около 4 ₽ на модели.'
            : 'Плата за выезд или изделие, считать по месту.',
          startupCostRub: s.startup,
          monthlyCostRub: s.monthly,
          risks: s.farm
            ? ['Покупатель пришлёт мало фактов, текст выйдет общим', 'Конкуренты снизят цену']
            : ['Нужны люди и ответственность за результат', 'Сезонность спроса'],
          quickTest: s.farm
            ? 'Выставить продукт на сайт и откликнуться на 5 запросов. Цель: 2 заказа за неделю.'
            : 'Разместить объявление в районной группе и посчитать заявки за 7 дней.',
          executionNote: s.farm
            ? 'Покупатель присылает факты, ферма пишет текст, проверка сверяет его с исходником.'
            : 'Ферма не делает физическую работу и не общается с клиентами.',
          launchPlanForHuman: s.farm
            ? []
            : [
                'Проверить спрос объявлением на Авито в своём районе',
                'Посчитать стоимость инвентаря и выезда',
                'Найти исполнителя на сдельную оплату',
                'Провести 3 пробных заказа и собрать отзывы',
              ],
          uncertainties: ['Сколько людей готовы платить, а не делать сами'],
        },
        critique: { verdict: s.verdict, reason: s.reason },
        checks:
          s.status === 'productized' || s.status === 'accepted'
            ? [
                {
                  hypothesisId: uuid(500 + i),
                  status: s.status === 'productized' ? 'accepted' : 'running',
                  productId: s.status === 'productized' ? uuid(600 + (i % 7)) : null,
                  version: s.status === 'productized' ? 2 : null,
                  critique:
                    s.status === 'productized'
                      ? 'Пример прошёл проверку: все факты из исходника на месте.'
                      : 'Сборщик готовит пример, проверка ещё не запускалась.',
                },
              ]
            : [],
        ownerNote: i === 6 ? 'Обсудить с Сергеем, у него есть стремянки и пара ребят.' : '',
        ownerStatus: i === 6 ? 'taken' : null,
        ownerTakenAt: i === 6 ? daysAgo(1, 15) : null,
        product:
          s.status === 'productized'
            ? {
                id: uuid(600 + (i % 7)),
                name: s.title,
                publicUrl: '/services/description',
                visibility: 'public',
                status: 'sandbox',
              }
            : null,
      } satisfies OfficeIdea
    })
    .sort((a, b) => b.rankScore - a.rankScore)

  const products: OfficeProduct[] = [
    ['description', 'Описание товара для маркетплейса', 49000, 'public', 1],
    ['faq', 'Ответы на частые вопросы для сайта', 149000, 'public', 0],
    ['social', 'Три поста из вашего текста', 79000, 'public', 8],
    ['translation', 'Перевод на английский и другие языки', 89000, 'public', 7],
    ['email', 'Ответ на вопрос или отзыв клиента', 29000, 'public', 4],
    ['job_post', 'Вакансия, на которую откликаются', 69000, 'public', 3],
    ['instruction', 'Пошаговая инструкция для пользователей', 79000, 'private', 17],
  ].map(([template, name, price, visibility, ideaIndex], i) => ({
    id: uuid(600 + i),
    slug: String(template).replace('_', '-'),
    name: String(name),
    template: String(template),
    version: i === 0 ? 3 : 2,
    visibility: visibility as 'public' | 'private',
    publishedAt: visibility === 'public' ? daysAgo(6 - i) : null,
    priceKopecks: Number(price),
    ideaId: ideas.find((idea) => idea.title === seeds[Number(ideaIndex)]!.title)?.id ?? null,
    ideaTitle: seeds[Number(ideaIndex)]!.title,
    isDemo: false,
    needsRefresh: template === 'social',
    publicUrl: `/services/${String(template).replace('_', '-')}`,
    stats: {
      orders: [14, 6, 4, 3, 2, 1, 0][i]!,
      delivered: [12, 5, 4, 3, 1, 1, 0][i]!,
      leads: [3, 2, 0, 1, 1, 0, 0][i]!,
    },
  }))

  const orders: OfficeOrderSummary[] = Array.from({ length: 14 }, (_, i) => {
    const product = products[i % 6]!
    const status =
      i === 1
        ? 'manual_review'
        : i === 0
          ? 'running'
          : i === 4
            ? 'awaiting_payment'
            : i === 7
              ? 'closed'
              : i === 9
                ? 'expired'
                : 'delivered'
    return {
      id: `${['a7f3c021', 'b2c10755', 'c91e4410', 'd03a77be', 'e5517c09', 'f1d2e3a4', '0a9b8c7d', '1b2c3d4e', '2c3d4e5f', '3d4e5f60', '4e5f6071', '5f607182', '60718293', '718293a4'][i]}-1111-4111-8111-${String(700 + i).padStart(12, '0')}`,
      number: 1053 - i,
      status,
      source: i % 3 === 2 ? 'owner' : 'public',
      paymentMode: i === 3 ? 'sepolia' : 'sandbox',
      isTestPayment: true,
      priceKopecks: product.priceKopecks,
      revenueKopecks: 0,
      product: { name: product.name, slug: product.slug, version: product.version },
      createdAt: i < 3 ? at(12 + i * 35) : daysAgo(Math.floor(i / 3), 11 + (i % 6)),
      attention: status === 'manual_review',
    }
  })

  const leads: OfficeLead[] = [
    {
      id: uuid(801),
      product: { id: products[0]!.id, name: products[0]!.name, slug: products[0]!.slug },
      template: 'description',
      url: 'https://www.fl.ru/projects/5512309/opisaniya-dlya-ozon.html',
      title: 'Нужно 30 описаний для карточек на Ozon',
      snippet:
        'Открываю магазин свечей, 30 позиций. Описания сам писать не успеваю, агентства просят от 800 ₽ за карточку. Кто делал, посоветуйте.',
      stage: 'new',
      note: '',
      replyDraft:
        'Здравствуйте! Пишем описания для карточек по вашим характеристикам: заголовок, текст и список свойств. 490 ₽ за карточку, готово за несколько минут. Пример на свечах можно посмотреть здесь: /services/description',
      replyDraftedAt: at(50),
      replyError: null,
      isDemo: false,
      firstSeenAt: at(65),
      lastSeenAt: at(50),
    },
    {
      id: uuid(802),
      product: { id: products[1]!.id, name: products[1]!.name, slug: products[1]!.slug },
      template: 'faq',
      url: 'https://vc.ru/services/911204-salon-faq',
      title: 'Салон красоты ищет, кто соберёт ответы на вопросы для сайта',
      snippet:
        'Администратор устала отвечать на одни и те же вопросы про запись и цены. Хотим раздел вопросов на сайте, но не знаем, с чего начать.',
      stage: 'new',
      note: '',
      replyDraft:
        'Добрый день! Соберём 8-12 вопросов и ответов по вашим услугам, срокам и оплате. Пришлите список услуг и правила записи, через несколько минут получите готовый раздел. 1 490 ₽.',
      replyDraftedAt: daysAgo(1, 18),
      replyError: null,
      isDemo: false,
      firstSeenAt: daysAgo(1, 17),
      lastSeenAt: daysAgo(1, 18),
    },
    {
      id: uuid(803),
      product: { id: products[3]!.id, name: products[3]!.name, slug: products[3]!.slug },
      template: 'translation',
      url: 'https://t.me/restoratory_chat/18822',
      title: 'Срочно нужен перевод меню, 2 страницы',
      snippet:
        'Завтра приезжает группа туристов, а меню только на русском. Две страницы. Кто быстро переведёт на английский?',
      stage: 'new',
      note: '',
      replyDraft: null,
      replyDraftedAt: null,
      replyError: 'Модель не ответила. Нажмите «Подготовить отклик заново».',
      isDemo: false,
      firstSeenAt: daysAgo(1, 9),
      lastSeenAt: daysAgo(1, 9),
    },
    {
      id: uuid(804),
      product: { id: products[2]!.id, name: products[2]!.name, slug: products[2]!.slug },
      template: 'social',
      url: 'https://vk.com/wall-120044_8812',
      title: 'Просит помочь с текстами для постов',
      snippet:
        'Девочки, кто пишет посты для своих страниц сам? У меня времени нет, а нужно хотя бы 3 поста в неделю.',
      stage: 'contacted',
      note: 'Написал в личку 6 окт',
      replyDraft:
        'Здравствуйте! Сделаем три поста из вашего текста: прайс, новости, фото работ. 790 ₽ за три поста, готово за пару минут.',
      replyDraftedAt: daysAgo(2, 12),
      replyError: null,
      isDemo: false,
      firstSeenAt: daysAgo(2, 11),
      lastSeenAt: daysAgo(2, 12),
    },
    {
      id: uuid(805),
      product: { id: products[1]!.id, name: products[1]!.name, slug: products[1]!.slug },
      template: 'faq',
      url: 'https://www.avito.ru/moskva/vakansii/operator_chata_3301',
      title: 'Ищет оператора в чат на постоянную работу',
      snippet: 'Нужен человек отвечать клиентам в чате магазина, с 9 до 21, оплата по часам.',
      stage: 'dismissed',
      note: 'Нужен сотрудник на смены, а не текст ответов.',
      replyDraft: 'Здравствуйте! Можем подготовить ответы на частые вопросы для вашего чата.',
      replyDraftedAt: daysAgo(3, 15),
      replyError: null,
      isDemo: false,
      firstSeenAt: daysAgo(3, 14),
      lastSeenAt: daysAgo(3, 15),
    },
  ]

  const money: OfficeMoney = {
    daySpentKopecks: 1840,
    monthSpentKopecks: 31240,
    outstandingKopecks: 600,
    limits: { dailyKopecks: 5000, monthlyKopecks: 500000 },
    byCategory: { scout: 12400, research: 9800, order: 6200, lead: 1840, report: 1000 },
    testPayments: { count: 11, kopecks: 612000 },
    realRevenueKopecks: 0,
    openai: null,
  }

  const settings: OfficeSettings = {
    mode: 'running',
    scheduleEnabled: true,
    researchScope: 'rotate',
    evolutionEnabled: true,
    evolutionMinIdeas: 6,
    evolutionRoundsPerDay: 1,
    scoutsPerStrategyPerDay: 2,
    leadsPerDay: 3,
    scheduleHourUtc: 6,
    providers: {
      model: 'OpenRouter, бесплатная модель',
      search: 'SearXNG',
      payment: 'Тестовая кнопка',
    },
    limits: { dailyKopecks: 5000, monthlyKopecks: 500000 },
  }

  const overview: OfficeOverview = {
    mode: 'running',
    generation: 2,
    today: {
      ideas: 5,
      ideasAccepted: 3,
      productsPublished: 1,
      ordersDelivered: 2,
      leadsFound: 1,
      spentKopecks: 1840,
    },
    totals: {
      ideas: ideas.length,
      products: products.length,
      publicProducts: products.filter((p) => p.visibility === 'public').length,
      orders: orders.length,
      realRevenueKopecks: 0,
      testPayments: 11,
      activeAgents: agents.filter((a) => a.status === 'active').length,
      newLeads: 3,
    },
    worker: { alive: true, reason: 'Работает. Следующий поиск в 14:00.', nextAt: inMinutes(95) },
    feed: [
      {
        at: at(4),
        kind: 'scout_started',
        text: 'Разведчик Б ищет идеи в хендмейде. Тема: описания изделий.',
        link: '/office/agents',
      },
      {
        at: at(12),
        kind: 'order_test_paid',
        text: 'Заказ №1053 (тест): «Описание товара для маркетплейса», 490 ₽.',
        link: '/office/orders/' + orders[0]!.id,
      },
      {
        at: at(25),
        kind: 'order_review',
        text: 'Заказ №1052 не прошёл проверку. Посмотрите.',
        link: '/office/orders/' + orders[1]!.id,
      },
      {
        at: at(40),
        kind: 'idea_accepted',
        text: 'Критик принял идею Разведчика А: меню для агрегаторов доставки. Ферма может сделать сама.',
        link: '/office/ideas/' + ideas.find((x) => x.title.startsWith('Меню'))!.id,
      },
      {
        at: at(58),
        kind: 'lead_found',
        text: 'Найден возможный клиент на fl.ru: «Нужно 30 описаний для Ozon». Отклик готов.',
        link: '/office/leads',
      },
      {
        at: at(75),
        kind: 'idea_rejected',
        text: 'Критик отклонил идею Разведчика Г. Бесплатных шаблонов полно на первой странице поиска.',
        link: null,
      },
      {
        at: at(96),
        kind: 'product_published',
        text: 'Новый продукт на сайте: «Ответы на частые вопросы для сайта», 1 490 ₽. Пример прошёл проверку.',
        link: '/office/products',
      },
      {
        at: at(130),
        kind: 'idea_needs_human',
        text: 'Идея «Выездная мойка окон» требует человека. Нужны люди и инвентарь, оставили в рейтинге.',
        link: '/office/ideas/' + ideas.find((x) => x.title.startsWith('Выездная'))!.id,
      },
      {
        at: at(180),
        kind: 'scout_assigned',
        text: 'Руководитель раздал задания. А ищет в общепите, Б в хендмейде, А2 в B2B, Б2 у маркетплейсов.',
        link: null,
      },
    ],
    needsOwner: [
      {
        kind: 'order_review',
        text: 'Заказ B2C10755 ждёт проверки',
        link: '/office/orders/' + orders[1]!.id,
      },
      { kind: 'lead_reply', text: '2 отклика клиентам готовы к отправке', link: '/office/leads' },
      {
        kind: 'idea_human',
        text: 'Идея «Выездная мойка окон»: нужен человек',
        link: '/office/ideas/' + ideas.find((x) => x.title.startsWith('Выездная'))!.id,
      },
    ],
  }

  const reports: OfficeReport[] = [
    {
      id: uuid(901),
      kind: 'daily',
      periodStart: daysAgo(1, 0),
      periodEnd: daysAgo(0, 0),
      generation: 2,
      metrics: {
        ideas: 6,
        accepted: 4,
        rejected: 1,
        products: 1,
        orders: 3,
        leads: 2,
        spentKopecks: 2210,
      },
      ranking: ideas.slice(0, 5).map((idea) => ({
        ideaId: idea.id,
        title: idea.title,
        rankScore: idea.rankScore,
        status: idea.status,
      })),
      narrative: {
        headline: 'Лучший день по принятым идеям: 4 из 6',
        summary:
          'Сильнее всего выступил Разведчик А: две идеи про общепит прошли критика. Копии только начали, у Б2 пока одна идея.',
        ideaComments: [
          {
            ideaId: ideas[0]!.id,
            comment: 'Уже продаётся, стоит искать клиентов в чатах мастеров.',
          },
        ],
        nextActions: [
          'Собрать продукт по меню для агрегаторов',
          'Откликнуться на запрос с fl.ru про описания',
        ],
        needsOwner: ['Решить, берёте ли мойку окон в работу'],
      },
      isDemo: false,
      createdAt: daysAgo(0, 6),
    },
    {
      id: uuid(902),
      kind: 'weekly',
      periodStart: daysAgo(7, 0),
      periodEnd: daysAgo(0, 0),
      generation: 2,
      metrics: {
        ideas: 22,
        accepted: 14,
        rejected: 3,
        products: 6,
        orders: 14,
        leads: 5,
        spentKopecks: 31240,
      },
      ranking: ideas.slice(0, 8).map((idea) => ({
        ideaId: idea.id,
        title: idea.title,
        rankScore: idea.rankScore,
        status: idea.status,
      })),
      narrative: null,
      isDemo: false,
      createdAt: daysAgo(0, 6),
    },
  ]

  const reviewOrder = {
    id: orders[1]!.id,
    number: orders[1]!.number,
    productName: orders[1]!.product.name,
    agent: { id: agentIds.a, name: 'Разведчик А', label: 'А' },
    status: 'manual_review',
    source: 'public',
    payment_mode: 'sandbox',
    is_test_payment: true,
    price_kopecks: orders[1]!.priceKopecks,
    product_id: products[1]!.id,
    product_snapshot: { name: orders[1]!.product.name, version: 2 },
    strategy_snapshot: { name: 'Разведчик А' },
    input:
      'Студия маникюра «Лак». Работаем с 10 до 21 без выходных. Маникюр с покрытием 1 800 ₽, педикюр 2 300 ₽. Запись через сайт или по телефону, отмена за 3 часа.',
    result: null,
    review: { reason: 'В тексте нет цены педикюра из исходника.' },
    resolution_reason: null,
    closed_at: null,
    created_at: at(40),
    paid_at: at(39),
    delivered_at: null,
    expires_at: inMinutes(60 * 23),
    receiver: null,
    amount_wei: null,
    tx_hash: null,
    required_confirmations: 3,
    payment_proof: null,
    progress: {
      title: 'Нужна проверка владельцем',
      detail: 'Текст не прошёл проверку дважды. Исходник и попытки сохранены.',
      tone: 'warn',
      canSubmit: false,
      canResolve: true,
      errorCode: 'OUTPUT_FORMAT_REQUIRED',
    },
    job: {
      status: 'failed',
      attempts: 3,
      max_attempts: 3,
      run_after: null,
      error_code: 'OUTPUT_FORMAT_REQUIRED',
    },
    steps: [
      { label: 'Оформлен', at: at(40), done: true },
      { label: 'Оплачен (тест)', at: at(39), done: true },
      { label: 'Текст написан', at: at(30), done: true },
      { label: 'Проверен и выдан', at: null, done: false },
    ],
    paymentAttempts: [],
  }

  const deliveredOrder = {
    ...reviewOrder,
    id: orders[2]!.id,
    number: orders[2]!.number,
    productName: orders[2]!.product.name,
    status: 'delivered',
    source: 'owner',
    product_snapshot: { name: orders[2]!.product.name, version: 2 },
    result:
      'Кружка «Утро» из белой керамики, 300 мл\n\nПлотная керамика держит тепло, ручка не нагревается. Можно мыть в посудомоечной машине.\n\nХарактеристики:\n- Объём: 300 мл\n- Материал: керамика\n- Цвет: белый',
    review: { reason: 'Все факты из исходника на месте.' },
    delivered_at: at(80),
    progress: {
      title: 'Готово',
      detail: 'Текст прошёл проверку и сохранён.',
      tone: 'good',
      canSubmit: false,
      canResolve: false,
      errorCode: null,
    },
    job: { status: 'done', attempts: 1, max_attempts: 3, run_after: null, error_code: null },
    steps: reviewOrder.steps.map((step) => ({ ...step, done: true, at: step.at || at(80) })),
  }

  const versions = {
    versions: [
      {
        version: 3,
        spec: {
          name: 'Описание товара для маркетплейса',
          audience: 'Продавцы на Ozon и Wildberries',
          promise: 'Карточка без воды из ваших характеристик',
        },
        checks: {
          reason: 'Все характеристики из исходника на месте.',
          input: 'Кружка, керамика, 300 мл',
          sample: 'Кружка «Утро» из белой керамики, 300 мл.',
        },
        critique: { verdict: 'PASS', reason: 'Понятная польза, спрос подтверждён.' },
        is_demo: false,
        created_at: daysAgo(1, 12),
        model: 'openrouter/free',
      },
      {
        version: 2,
        spec: {
          name: 'Описание товара',
          audience: 'Продавцы маркетплейсов',
          promise: 'Описание товара по характеристикам',
        },
        checks: { reason: 'Пример прошёл проверку.' },
        critique: { verdict: 'PASS', reason: 'Спрос есть.' },
        is_demo: false,
        created_at: daysAgo(6, 12),
        model: 'qwen3:4b',
      },
    ],
    nextBefore: null,
  }

  const readiness = {
    version: 2,
    status: 'degraded',
    checks: {
      database: true,
      worker: true,
      payments: true,
      backup: false,
      providerHeartbeat: true,
      model: true,
      search: true,
    },
    providers: { checkedAt: at(1), fresh: true },
    checkedAt: at(0),
  }

  const journal = {
    audit: [
      { id: 3, message: 'Владелец изменил режим работы.', created_at: at(200) },
      {
        id: 2,
        message: 'Отбор поколения 1: Разведчик В и Разведчик Г уволены.',
        created_at: daysAgo(3, 9),
      },
      { id: 1, message: 'Найдены потенциальные запросы на услуги.', created_at: daysAgo(3, 8) },
    ],
    jobs: [
      {
        id: uuid(951),
        kind: 'scout',
        status: 'running',
        attempts: 1,
        error_code: null,
        created_at: at(4),
      },
      {
        id: uuid(952),
        kind: 'fulfill',
        status: 'failed',
        attempts: 3,
        error_code: 'OUTPUT_FORMAT_REQUIRED',
        created_at: at(40),
      },
      {
        id: uuid(953),
        kind: 'report',
        status: 'done',
        attempts: 1,
        error_code: null,
        created_at: daysAgo(0, 6),
      },
    ],
  }

  const categories = [...new Map(ideas.map((i) => [i.categoryId!, i.category])).entries()].map(
    ([id, label]) => ({ id, label }),
  )

  return {
    overview,
    agents: officeAgents,
    ideas,
    categories,
    products,
    orders,
    leads,
    money,
    settings,
    reports,
    reviewOrder,
    deliveredOrder,
    versions,
    readiness,
    journal,
  }
}

export type OfficeFixtures = ReturnType<typeof officeFixtures>
