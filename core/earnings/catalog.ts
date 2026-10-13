export type EarningTrackId =
  'spot' | 'bots' | 'arbitrage' | 'yield' | 'prediction' | 'business' | 'services'

export interface EarningTrack {
  id: EarningTrackId
  title: string
  stage: 'Спот' | 'Тренировка' | 'Мониторинг' | 'Тестовые заказы'
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
    stage: 'Мониторинг',
    summary: 'Разница цен одной монеты на разных биржах. Только наблюдение, без сделок.',
  },
  {
    id: 'yield',
    title: 'Фандинг и DeFi',
    stage: 'Мониторинг',
    summary:
      'Ставки фандинга Bybit и OKX, доходность пулов DeFi. Только наблюдение, без вложения средств.',
  },
  {
    id: 'prediction',
    title: 'Рынки прогнозов',
    stage: 'Мониторинг',
    summary: 'События, цены исходов и оборот Polymarket и Kalshi. Только наблюдение, без ставок.',
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
