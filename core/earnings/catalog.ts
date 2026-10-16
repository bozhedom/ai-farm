export type EarningTrackId =
  'spot' | 'bots' | 'arbitrage' | 'yield' | 'prediction' | 'business' | 'services'

export interface EarningTrack {
  id: EarningTrackId
  title: string
  stage: 'Спот' | 'Тренировка' | 'Операции' | 'Тестовые заказы'
  summary: string
}

export const earningTracks: EarningTrack[] = [
  {
    id: 'spot',
    title: 'Торговля монетами',
    stage: 'Спот',
    summary:
      'Счета OKX, Bybit, Binance и Bitget. Выбирайте биржу, следите за сделками и результатами стратегий.',
  },
  {
    id: 'bots',
    title: 'Сетка и DCA',
    stage: 'Тренировка',
    summary:
      'Сравнивайте сетку и покупку частями на виртуальных деньгах. Сетка покупает при снижении и продаёт после отскока. DCA делит покупку на несколько частей.',
  },
  {
    id: 'arbitrage',
    title: 'Арбитраж',
    stage: 'Операции',
    summary:
      'Покупка и продажа одной монеты на двух биржах. Средства заранее распределяются между счетами.',
  },
  {
    id: 'yield',
    title: 'Фандинг и DeFi',
    stage: 'Операции',
    summary:
      'Пара из спота и фьючерса на Bybit или размещение USDC в Aave. У каждого направления отдельный счёт.',
  },
  {
    id: 'prediction',
    title: 'Рынки прогнозов',
    stage: 'Операции',
    summary:
      'Покупка контрактов Kalshi по заданной оценке вероятности. Polymarket доступен в обзоре рынка.',
  },
  {
    id: 'business',
    title: 'Текстовые услуги',
    stage: 'Тестовые заказы',
    summary: 'Описание товаров, ответы на вопросы и другие тексты по вашим материалам.',
  },
  {
    id: 'services',
    title: 'Заказы через API',
    stage: 'Тестовые заказы',
    summary: 'Выберите услугу, узнайте цену и создайте тестовый заказ.',
  },
]
