import type { LaunchGroup, LaunchStep, LaunchStepStatus, LaunchView } from '../contracts/launch'
import type { WalletKeyStatus } from '../contracts/wallet'
import { computerReason } from '../computer-use/words'

/**
 * The owner's launch checklist as a pure function of detected facts. `core/launch/view.ts`
 * gathers the facts from the database and the environment; this module only turns them into
 * ordered steps with a status and plain Russian words. Nothing here reads secrets: the input
 * carries booleans, counts, codes and timestamps only.
 */
export type LaunchInput = {
  now: Date
  system: {
    mode: 'running' | 'paused' | 'emergency_stop'
    workerAlive: boolean
    /** `system_state.schedule_enabled` and the AUTONOMY_ENABLED gate. */
    scheduleEnabled: boolean
    autonomyAllowed: boolean
    researchEnabled: boolean
    autopilotOnBoot: boolean
    workspaceMode: 'trading' | 'studio'
  }
  model: {
    provider: string
    /** The chosen provider has its key (presence only). */
    configured: boolean
    /** GPT-6 Astra over OpenRouter: the paid route computer use and the manager need. */
    paid: boolean
    /** Worker's last provider check; null while it has not reported. */
    readyNow: boolean | null
    lastSuccessAt: string | null
    lastErrorCode: string
    /** OpenRouter charged for a "free" request: new calls stop until the owner looks. */
    costAlert: boolean
    dailyKopecks: number
    monthlyKopecks: number
    paidTotalMicrousd: number
    daySpentKopecks: number
    monthSpentKopecks: number
    paidSpentMicrousd: number
  }
  computer: {
    /** `computerUseReady()` code or '' when the server side is configured. */
    blocker: string
    demo: boolean
    enabled: boolean
    failures: number
    maxFailures: number
    lastError: string
    lastStepAt: string | null
    lastDoneAt: string | null
    approvals: number
    autoProposalsAllowed: boolean
    autoProposals: boolean
    proposalsPerDay: number
    platforms: { domain: string; loggedIn: boolean }[]
    sentToday: number
    opportunities: number
    humanOpportunities: number
  }
  seller: {
    seller: boolean
    contact: boolean
    terms: boolean
    paymentMode: string
    publicProducts: number
  }
  wallet: {
    address: boolean
    network: string
    keyStatus: WalletKeyStatus
    keyError: string
    lastSyncAt: string | null
    unclassified: number
    incomeDeposits: number
  }
  trading: {
    liveEnabled: boolean
    minLiveUsdt: number
    bybit: {
      demoKeys: boolean
      liveKeys: boolean
      demo: { status: string; checkError: string; checkedAt: string | null; roundTrips: boolean }
      live: {
        status: string
        checkError: string
        reason: string
        capitalOk: boolean
        startedAt: string | null
        /** Last read-only key check; null means the key has never been checked. */
        checkedAt: string | null
      }
      paper: { status: string; qualified: boolean }
    }
    /** Other exchanges whose Live keys are present. */
    otherLiveKeys: string[]
  }
  manager: { enabled: boolean }
  execution: { track: string; title: string; demoReady: string; paperStatus: string }[]
}

/**
 * Platforms to log in first: Russian text markets that pay out in rubles and allow AI-assisted
 * work (docs/37-accounts.md). Upwork, Fiverr and Freelancer.com are closed to Russian residents,
 * Habr Freelance shut down in 2025.
 */
export const recommendedPlatforms: readonly string[] = Object.freeze([
  'kwork.ru',
  'fl.ru',
  'etxt.ru',
  'workzilla.com',
  'advego.com',
])

const groupMeta: Record<LaunchGroup, { title: string; hint: string }> = {
  required: {
    title: 'Обязательно',
    hint: 'Без этого ферма не работает сама: ни поиск заданий, ни отклики, ни торговля.',
  },
  freelance: {
    title: 'Чтобы ИИ сам откликался на фрилансе',
    hint: 'Единственный путь к живым заказам сейчас. Пока вход не выполнен, агент только ищет и всё помечает «нужен человек».',
  },
  payments: {
    title: 'Чтобы принимать оплату',
    hint: 'Фриланс-площадки платят через себя. Зарубежные клиенты напрямую платят только USDT на ваш Bybit. Тестовые оплаты на сайте не доход.',
  },
  trading: {
    title: 'Торговля',
    hint: 'Тренировка и Demo идут на тестовые деньги, это не доход. Реальная торговля открывается только после проверок и вашего включения.',
  },
  extra: {
    title: 'Дополнительно',
    hint: 'Не обязательно для заработка. Включайте, когда основное работает.',
  },
}
const groupOrder: LaunchGroup[] = ['required', 'freelance', 'payments', 'trading', 'extra']

const tradingWords: Record<string, string> = {
  TRADING_KEY_PERMISSIONS:
    'у ключа лишние права или нет права на спот-торговлю. Нужен ключ субаккаунта только с правом Spot Trade, без вывода и переводов, привязанный к IP сервера',
  TRADING_CREDENTIALS_REQUIRED: 'ключ не внесён',
  TRADING_IP_REQUIRED: 'ключ не привязан к IP сервера',
  TRADING_ACCOUNT_MODE: 'на Bybit нужен единый торговый счёт с обычной маржой (Regular Margin)',
  TRADING_CLOCK_SKEW: 'часы сервера расходятся с биржей',
  TRADING_NETWORK_UNAVAILABLE: 'биржа не отвечает',
  TRADING_REGION_UNAVAILABLE: 'биржа ограничила доступ для этого аккаунта или адреса сервера',
  TRADING_INSUFFICIENT_FUNDS: 'на торговом субаккаунте мало свободных USDT',
  TRADING_INITIAL_ASSETS: 'на субаккаунте должны быть только USDT',
  TRADING_POSITIONS_EXIST: 'на аккаунте есть позиции по деривативам',
  TRADING_DEBT_FORBIDDEN: 'на аккаунте есть заём',
  TRADING_EXTERNAL_ORDERS: 'на аккаунте есть чужие открытые ордера',
  TRADING_BALANCE_DRIFT: 'баланс биржи расходится с журналом, нужна сверка',
  TRADING_ORDER_UNKNOWN: 'есть ордер с неясным исходом, нужна проверка на бирже',
  TRADING_DEMO_REQUIRED: 'раньше требовалась проверка Demo (с 28.10 не нужна)',
}
/** Errors raised after the exchange accepted the key and its permissions. */
const accountStateCodes = new Set([
  'TRADING_INSUFFICIENT_FUNDS',
  'TRADING_INITIAL_ASSETS',
  'TRADING_EXTERNAL_ORDERS',
])
const walletWords: Record<WalletKeyStatus | 'unchecked', string> = {
  not_configured: 'Ключ не внесён.',
  unchecked: 'Ключ внесён, проверка пройдёт в ближайшие 5 минут.',
  read_only: 'Ключ проверен: только чтение.',
  rejected: 'Ключ отклонён: у него есть права на изменение. Такой ключ ферма не использует.',
  error: 'Ключ не прошёл проверку.',
}

export function tradingWord(code: string) {
  if (!code) return ''
  return tradingWords[code] ?? `код ${code}, подробности в разделе биржи`
}

/** «3 мин назад», «2 ч назад», «5 дн назад» for a server-side state line. */
export function since(iso: string | null, now: Date) {
  if (!iso) return 'ещё не было'
  const ms = now.getTime() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 'только что'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'только что'
  if (minutes < 60) return `${minutes} мин назад`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} ч назад`
  return `${Math.floor(hours / 24)} дн назад`
}

const rub = (kopecks: number) => `${Math.round(kopecks / 100).toLocaleString('ru-RU')} ₽`
const usd = (microusd: number) => `$${(microusd / 1_000_000).toFixed(microusd % 1_000_000 ? 2 : 0)}`
const list = (values: string[]) => values.join(', ')
/** A reason sentence used inside a longer sentence: without its final period. */
const clause = (text: string) => text.replace(/\.$/, '')
const reason = (code: string) => clause(computerReason(code))

type Draft = Omit<LaunchStep, 'status' | 'required' | 'codes'> & {
  status: LaunchStepStatus
  required?: boolean
  codes?: string[]
}

export function launchSteps(input: LaunchInput): LaunchView {
  const { now, system, model, computer, seller, wallet, trading, manager } = input
  const steps: Draft[] = []
  const add = (step: Draft) => steps.push(step)

  // ---- required ---------------------------------------------------------------------------
  const farmRunning = system.mode === 'running' && system.workerAlive
  add({
    id: 'server',
    group: 'required',
    status: farmRunning ? 'done' : 'needed',
    title: 'Сервер работает и не остановлен',
    why: 'Фоновый процесс делает всё остальное: ищет задания, торгует, проверяет оплату.',
    actions:
      system.mode === 'emergency_stop'
        ? ['Откройте обзор и нажмите «Продолжить» вверху, если остановка была не намеренной.']
        : system.mode === 'paused'
          ? ['Нажмите «Продолжить» вверху обзора, когда будете готовы.']
          : !system.workerAlive
            ? ['Перезапустите службу worker на сервере: bash deploy/timeweb/dc.sh up -d worker.']
            : ['Ничего делать не нужно.'],
    link: '/office/settings#mode-title',
    linkLabel: 'Настройки',
    state:
      system.mode === 'emergency_stop'
        ? 'Аварийный стоп: новые задачи не начинаются.'
        : system.mode === 'paused'
          ? 'Пауза: начатые заказы доделываются, новое не берётся.'
          : system.workerAlive
            ? 'Работает, фоновый процесс на связи.'
            : 'Фоновый процесс не отвечает больше 90 секунд.',
  })

  const paidRoute = model.paid && model.configured
  const modelOk = model.configured && model.readyNow !== false && !model.costAlert
  const modelCodes = [model.lastErrorCode].filter(Boolean)
  add({
    id: 'model',
    group: 'required',
    status: model.provider === 'demo' || !model.configured ? 'needed' : modelOk ? 'done' : 'needed',
    title: 'Платная модель подключена',
    why: 'Модель читает задания, пишет отклики и тексты, управляет браузером. Без неё работает только торговля по правилам.',
    actions: [
      'Пополните баланс OpenRouter и создайте ключ с лимитом.',
      'Админ вписывает в .env на сервере: MODEL_PROVIDER=openai, OPENAI_TRANSPORT=openrouter, OPENROUTER_API_KEY. Ключ в чат не отправляйте.',
      'Перезапустите web и worker; в «Настройках» строка «Подключения» станет зелёной.',
    ],
    link: '/office/settings#providers-title',
    linkLabel: 'Настройки',
    state:
      model.provider === 'demo'
        ? 'Работает демо-режим: тексты и решения ненастоящие.'
        : !model.configured
          ? `Выбран провайдер ${model.provider}, ключа нет.`
          : model.costAlert
            ? 'OpenRouter списал деньги за бесплатный запрос, новые вызовы остановлены. Проверьте расходы в кабинете OpenRouter.'
            : model.readyNow === false
              ? `Ключ есть, но модель сейчас недоступна${model.lastErrorCode ? ` (${model.lastErrorCode})` : ''}. Последний удачный вызов: ${since(model.lastSuccessAt, now)}.`
              : `${paidRoute ? 'GPT-6 Astra через OpenRouter' : `Провайдер ${model.provider}`}. Последний удачный вызов: ${since(model.lastSuccessAt, now)}.${model.readyNow === null ? ' Воркер ещё не отчитался о проверке.' : ''}`,
    codes: modelCodes,
  })

  const budgetsOk =
    model.dailyKopecks > 0 &&
    model.monthlyKopecks > 0 &&
    (!model.paid || model.paidTotalMicrousd > 0)
  add({
    id: 'budgets',
    group: 'required',
    status: budgetsOk ? 'done' : 'needed',
    title: 'Пределы расходов на модель заданы',
    why: 'Ферма тратит на модель только в этих пределах; когда они исчерпаны, она ждёт следующего дня, а не останавливается навсегда.',
    actions: [
      'Проверьте пределы в «Деньгах». Менять их может только админ в .env: DAILY_BUDGET_KOPECKS, MONTHLY_BUDGET_KOPECKS, OPENAI_TOTAL_BUDGET_MICROUSD.',
    ],
    link: '/office/money',
    linkLabel: 'Деньги',
    state: budgetsOk
      ? `В сутки ${rub(model.dailyKopecks)}, в месяц ${rub(model.monthlyKopecks)}${model.paid ? `, всего на платную модель ${usd(model.paidTotalMicrousd)}` : ''}. Потрачено сегодня ${rub(model.daySpentKopecks)}, за месяц ${rub(model.monthSpentKopecks)}${model.paid ? `, по платной модели ${usd(model.paidSpentMicrousd)}` : ''}.`
      : 'Один из пределов равен нулю: модель не может работать.',
  })

  const scheduleOn = system.autonomyAllowed && system.scheduleEnabled
  const autoOk = system.autopilotOnBoot && (scheduleOn || system.workspaceMode === 'trading')
  add({
    id: 'autopilot',
    group: 'required',
    status: autoOk ? 'done' : 'needed',
    title: 'Автопилот и расписание включены',
    why: 'Автопилот сам запускает тренировку, Demo и направления после перезапуска; расписание каждый день запускает разведку идей и клиентов.',
    actions: [
      ...(system.autopilotOnBoot
        ? []
        : ['Админ ставит AUTOPILOT_ON_BOOT=true в .env и пересоздаёт worker.']),
      ...(scheduleOn
        ? []
        : system.autonomyAllowed
          ? ['В «Настройках» включите расписание и выберите час запуска.']
          : ['Админ ставит AUTONOMY_ENABLED=true в .env.']),
      ...(system.researchEnabled ? [] : ['Начните новый сезон исследований в «Настройках».']),
    ],
    link: '/office/settings#schedule-title',
    linkLabel: 'Настройки',
    state: `Автопилот ${system.autopilotOnBoot ? 'включён' : 'выключен'}. Расписание ${scheduleOn ? 'включено' : 'выключено'}${system.researchEnabled ? '' : ', сезон исследований закрыт'}.`,
  })

  // ---- freelance ----------------------------------------------------------------------------
  const vmOk = !computer.blocker
  add({
    id: 'computer-vm',
    group: 'freelance',
    status: vmOk ? 'done' : 'needed',
    title: 'Компьютер ИИ подключён',
    why: 'Отдельная машина с браузером, где модель ищет задания на площадках и откликается на них от вашего имени.',
    actions: [
      'Арендуйте отдельную виртуальную машину и поставьте на неё vm-agent (инструкция в docs/32-computer-use.md).',
      'Админ вписывает в .env фермы VM_AGENT_URL, VM_AGENT_TOKEN и COMPUTER_USE_ENABLED=true.',
    ],
    link: '/office/computer',
    linkLabel: 'Компьютер ИИ',
    state: vmOk
      ? computer.demo
        ? 'Подключён в демо-режиме: без настоящей машины и модели.'
        : 'Машина и модель настроены на сервере.'
      : computerReason(computer.blocker),
    codes: computer.blocker ? [computer.blocker] : [],
  })

  const halted = computer.failures >= computer.maxFailures
  const vmDown = computer.lastError === 'COMPUTER_USE_VM_UNAVAILABLE'
  const computerOn = vmOk && computer.enabled && !halted
  add({
    id: 'computer-on',
    group: 'freelance',
    status: !vmOk ? 'blocked' : computerOn ? 'done' : 'needed',
    title: 'Компьютер ИИ включён и не остановлен',
    why: 'Пока раздел выключен или остановлен после сбоев, модель не берёт ни одного задания в браузере.',
    actions: halted
      ? [
          `Остановлен после ${computer.failures} сбоев подряд: ${reason(computer.lastError) || 'причина в техжурнале'}.`,
          vmDown
            ? 'Проверьте, что машина с vm-agent запущена и доступна с сервера фермы.'
            : 'Посмотрите последние задания в истории на странице раздела.',
          'Нажмите переключатель «Работа модели в браузере» на странице раздела: счётчик сбоев сбросится, задания пойдут снова.',
        ]
      : computer.enabled
        ? ['Ничего делать не нужно.']
        : ['Включите переключатель «Работа модели в браузере» на странице раздела.'],
    link: '/office/computer#computer-state',
    linkLabel: 'Компьютер ИИ',
    state: !vmOk
      ? 'Сначала подключите машину.'
      : halted
        ? `Остановлен: ${computer.failures} сбоя подряд. Последняя ошибка: ${reason(computer.lastError) || 'нет записи'}. Последний шаг ${since(computer.lastStepAt, now)}.`
        : !computer.enabled
          ? 'Выключен переключателем в кабинете.'
          : `Работает. Последний шаг ${since(computer.lastStepAt, now)}, последнее завершённое задание ${since(computer.lastDoneAt, now)}${computer.failures ? `, сбоев подряд ${computer.failures} из ${computer.maxFailures}` : ''}${computer.lastError ? `. Последняя ошибка: ${reason(computer.lastError)}` : ''}.`,
    codes: computer.lastError ? [computer.lastError] : [],
  })

  const loggedIn = computer.platforms.filter((p) => p.loggedIn).map((p) => p.domain)
  const known = new Set(computer.platforms.map((p) => p.domain))
  const toLogIn = recommendedPlatforms.filter((d) => known.has(d) && !loggedIn.includes(d))
  add({
    id: 'platforms',
    group: 'freelance',
    status: !vmOk ? 'blocked' : loggedIn.length ? 'done' : 'needed',
    title: 'Вход в фриланс-площадки под вашим аккаунтом',
    why: 'Только на площадках, где вы вошли, модель видит задания, откликается и сдаёт работу. Деньги за заказы приходят на ваш счёт площадки.',
    actions: [
      'Зарегистрируйте аккаунты лично, с двухфакторной защитой. Модель аккаунты не создаёт.',
      'На странице «Компьютер ИИ» в блоке «Вход на площадки» выберите площадку, введите логин и пароль и нажмите «Сохранить и войти»: модель войдёт сама. Пароль хранится зашифрованным на сервере, модель его не видит.',
      'Если площадка попросит код из SMS или почты, он придёт в блок «Нужен человек»: введите код через «Управление вручную».',
      `Начните с: ${list(toLogIn.length ? toLogIn : [...recommendedPlatforms])}.`,
    ],
    link: '/office/computer#computer-manual',
    linkLabel: 'Компьютер ИИ',
    state: !vmOk
      ? 'Сначала подключите машину.'
      : loggedIn.length
        ? `Вход выполнен: ${list(loggedIn)}. Откликов отправлено сегодня: ${computer.sentToday}.`
        : `Ни одной. Найдено возможностей ${computer.opportunities}, из них «нужен человек» ${computer.humanOpportunities}: без входа агент только смотрит.`,
  })

  const sendingOk = computer.autoProposalsAllowed && computer.autoProposals
  add({
    id: 'auto-proposals',
    group: 'freelance',
    status: !vmOk ? 'blocked' : sendingOk ? 'done' : 'needed',
    title: 'Разрешение отправлять отклики самой',
    why: `Без него модель только пишет черновики. С ним модель отправляет до ${computer.proposalsPerDay} откликов в сутки на площадку, отвечает заказчикам и сдаёт работу.`,
    actions: [
      ...(computer.autoProposalsAllowed
        ? []
        : ['Админ ставит COMPUTER_USE_AUTO_PROPOSALS=true в .env и пересоздаёт worker.']),
      ...(computer.autoProposals
        ? []
        : ['Включите переключатель «Автоотклики и ответы заказчикам» на странице раздела.']),
      'Отклики идут от вашего имени: за работу перед заказчиком отвечаете вы. Оплату, пароли и вопросы об ИИ модель передаёт вам.',
    ],
    link: '/office/computer#computer-state',
    linkLabel: 'Компьютер ИИ',
    state: !vmOk
      ? 'Сначала подключите машину.'
      : sendingOk
        ? `Разрешено, до ${computer.proposalsPerDay} откликов в сутки на площадку.${loggedIn.length ? '' : ' Пока нет входа в площадки, отправлять нечего.'}`
        : `${computer.autoProposalsAllowed ? 'На сервере разрешено' : 'На сервере запрещено (COMPUTER_USE_AUTO_PROPOSALS)'}, переключатель в кабинете ${computer.autoProposals ? 'включён' : 'выключен'}.`,
  })

  if (computer.approvals)
    add({
      id: 'approvals',
      group: 'freelance',
      status: 'needed',
      title: `Решить ${computer.approvals === 1 ? 'запрос' : 'запросы'} модели: ${computer.approvals}`,
      why: 'Оплата, вход, регистрация, публикация и вопросы заказчика об ИИ ждут вашего слова. Пока ждут, задание стоит.',
      actions: [
        'Откройте «Нужен человек» на странице раздела и нажмите «Разрешить» или «Отклонить».',
      ],
      link: '/office/computer#computer-approvals',
      linkLabel: 'Компьютер ИИ',
      state: `Ждут решения: ${computer.approvals}.`,
    })

  // ---- payments -----------------------------------------------------------------------------
  add({
    id: 'usdt-address',
    group: 'payments',
    status: wallet.address ? 'done' : 'needed',
    title: 'Адрес USDT для зарубежных клиентов',
    why: 'Клиенты не из России могут платить за услуги напрямую, в USDT на ваш Bybit. Резидентам РФ платить криптой за услуги нельзя (259-ФЗ), и кабинет об этом предупреждает.',
    actions: [
      'В Bybit откройте «Активы», «Депозит», USDT, выберите сеть (например TRC20) и скопируйте адрес.',
      'Админ вписывает в .env PAYMENT_USDT_ADDRESS и PAYMENT_USDT_NETWORK (и PAYMENT_USDT_MEMO, если биржа его показывает).',
    ],
    link: '/office/money#wallet-title',
    linkLabel: 'Деньги',
    state: wallet.address
      ? `Адрес задан, сеть ${wallet.network}. Сам адрес показан в разделе «Деньги».`
      : 'Адрес не задан: зарубежным клиентам нечего отправить.',
  })

  const keyOk = wallet.keyStatus === 'read_only'
  add({
    id: 'wallet-key',
    group: 'payments',
    status: keyOk ? 'done' : 'needed',
    title: 'Ключ Bybit только для чтения поступлений',
    why: 'По нему ферма видит, что деньги пришли, и показывает их в «Деньгах». Доход засчитывается только после вашей отметки «доход».',
    actions: [
      'В Bybit, раздел API, создайте ключ с типом Read-Only, разделы «Кошелёк» и «Активы», привяжите к IP сервера. Права на торговлю, вывод и переводы не давайте: такой ключ сервер отклонит.',
      'Админ вписывает BYBIT_WALLET_READ_API_KEY и BYBIT_WALLET_READ_SECRET в .env и перезапускает worker.',
      ...(wallet.keyStatus === 'rejected'
        ? ['Удалите отклонённый ключ на Bybit и создайте новый, только для чтения.']
        : []),
    ],
    link: '/office/money#wallet-title',
    linkLabel: 'Деньги',
    state: `${walletWords[wallet.keyStatus] ?? wallet.keyStatus}${
      wallet.keyStatus === 'error' && wallet.keyError ? ` Bybit ответил: ${wallet.keyError}.` : ''
    }${keyOk ? ` Последняя сверка ${since(wallet.lastSyncAt, now)}.` : ''}${
      wallet.unclassified ? ` Поступлений без отметки: ${wallet.unclassified}.` : ''
    }`,
    codes: wallet.keyStatus === 'error' && wallet.keyError ? [wallet.keyError] : [],
  })

  const sellerFields = [seller.seller, seller.contact, seller.terms]
  const sellerDone = sellerFields.every(Boolean)
  add({
    id: 'seller',
    group: 'payments',
    status: sellerDone ? 'done' : 'optional',
    required: false,
    title: 'Продавец на сайте и настоящая оплата',
    why: 'Сайт фермы сейчас продаёт тексты только за тестовые деньги. Чтобы брать настоящие, нужен статус продавца (самозанятость или ИП) и платёжный провайдер, которого в коде пока нет.',
    actions: [
      'Оформите статус продавца.',
      'Админ заполняет PUBLIC_SELLER, PUBLIC_CONTACT и PUBLIC_TERMS_URL в .env, чтобы на сайте был указан продавец.',
      'Настоящий платёжный провайдер пока не подключён: оплата на сайте остаётся тестовой, и это не доход.',
    ],
    link: '/office/products',
    linkLabel: 'Продукты',
    state: `Оплата на сайте тестовая (${seller.paymentMode}), в продаже ${seller.publicProducts} услуг. Продавец указан: ${seller.seller ? 'да' : 'нет'}, контакт: ${seller.contact ? 'да' : 'нет'}, условия: ${seller.terms ? 'да' : 'нет'}.`,
  })

  // ---- trading ------------------------------------------------------------------------------
  const b = trading.bybit
  const demoVerified = b.demoKeys && !b.demo.checkError && !!b.demo.checkedAt && b.demo.roundTrips
  add({
    id: 'bybit-demo',
    group: 'trading',
    status: demoVerified ? 'done' : 'needed',
    title: 'Проверка на тестовом счёте Bybit (Demo)',
    why: 'Реальная торговля никогда не откроется без удачной пробной покупки и продажи на Demo. Деньги Demo ненастоящие.',
    actions: [
      'В Bybit включите Demo Trading и создайте там API-ключ (только чтение + Spot Trade, без вывода).',
      'Админ вписывает BYBIT_DEMO_API_KEY и BYBIT_DEMO_SECRET в .env и перезапускает web/worker.',
      'При включённом автопилоте сервер сам запускает пробную покупку/продажу и затем продолжает Demo. Кнопка «Проверить покупку и продажу» в «Торговой ферме» нужна только если автопилот выключен.',
    ],
    link: '/office/trading',
    linkLabel: 'Торговая ферма',
    state: !b.demoKeys
      ? 'Demo-ключ не внесён.'
      : b.demo.checkError
        ? `Ключ есть, проверка не прошла: ${tradingWord(b.demo.checkError)}.`
        : !b.demo.roundTrips
          ? `Ключ есть, подключение ${b.demo.checkedAt ? 'проверено' : 'ещё не проверялось'}; автопилот ещё не завершил пробную сделку.`
          : `Пройдена: пробная сделка на Demo есть, подключение проверено ${since(b.demo.checkedAt, now)}.`,
    codes: b.demo.checkError ? [b.demo.checkError] : [],
  })

  // The key authenticated and passed the permission check; only the account is not ready yet.
  const liveAccountIssue = accountStateCodes.has(b.live.checkError)
  const liveKeyOk = b.liveKeys && !!b.live.checkedAt && (!b.live.checkError || liveAccountIssue)
  add({
    id: 'bybit-live-key',
    group: 'trading',
    status: liveKeyOk ? 'done' : 'needed',
    title: 'Торговый ключ Bybit для реального счёта',
    why: 'Нужен, чтобы покупать и продавать на ваши деньги. Сервер принимает только ключ с правом Spot Trade, без вывода и переводов.',
    actions: [
      'Создайте в Bybit субаккаунт только для фермы и переведите на него USDT (минимум ' +
        `${trading.minLiveUsdt} USDT).`,
      'В этом субаккаунте создайте API-ключ: тип «Системный», права только Spot Trade (чтение и торговля), без Withdraw, Transfer, Derivatives, Options и Earn; ограничьте IP адресом сервера.',
      'Админ вписывает BYBIT_LIVE_API_KEY и BYBIT_LIVE_SECRET в .env и перезапускает web и worker.',
    ],
    link: '/office/trading',
    linkLabel: 'Торговая ферма',
    state: !b.liveKeys
      ? 'Ключ реального счёта не внесён.'
      : !b.live.checkedAt
        ? 'Ключ внесён, но ещё не проверялся. Сервер проверяет его раз в час только чтением, без ордеров; можно проверить сразу кнопкой «Проверить связь» в «Торговой ферме».'
        : liveAccountIssue
          ? `Ключ принят (проверен ${since(b.live.checkedAt, now)}), но счёт не готов: ${tradingWord(b.live.checkError)}.`
          : b.live.checkError
            ? `Ключ внесён, но отклонён: ${tradingWord(b.live.checkError)}. Проверка ${since(b.live.checkedAt, now)}.`
            : `Ключ принят, проверен ${since(b.live.checkedAt, now)}.`,
    codes: b.live.checkError ? [b.live.checkError] : [],
  })

  const gates = {
    enabled: trading.liveEnabled,
    key: liveKeyOk,
    capital: b.live.capitalOk,
  }
  const gatesOk = Object.values(gates).every(Boolean)
  const liveRunning = b.live.status === 'running'
  const missing = [
    !gates.enabled && 'TRADING_LIVE_ENABLED=true в .env',
    !gates.key && 'принятый торговый ключ',
    !gates.capital && `бюджет от ${trading.minLiveUsdt} USDT`,
  ].filter((x): x is string => !!x)
  add({
    id: 'live-trading',
    group: 'trading',
    status: liveRunning ? 'done' : gatesOk ? 'needed' : 'blocked',
    required: false,
    title: 'Включить реальную торговлю на Bybit',
    why: 'Единственный торговый режим с настоящими деньгами. Прибыль не гарантируется; убыток ограничен вашим бюджетом и лимитами риска (2% в день, 10% просадки). Demo и прибыльная тренировка больше не требуются для запуска.',
    actions: [
      'Админ ставит TRADING_LIVE_ENABLED=true в .env.',
      'В «Торговой ферме» задайте бюджет для Bybit и нажмите «Запустить» в режиме «Реальные деньги», введя фразу подтверждения.',
      'Бюджет активного портфеля после запуска не меняется.',
    ],
    link: '/office/trading',
    linkLabel: 'Торговая ферма',
    state: liveRunning
      ? `Идёт с ${since(b.live.startedAt, now)}.`
      : b.live.status === 'paused' || b.live.status === 'stopped'
        ? `Остановлена: ${tradingWord(b.live.reason) || b.live.reason || 'вами'}. Снова запускаете вы.`
        : gatesOk
          ? 'Можно запускать. Запуск только вашей рукой с фразой подтверждения; прибыль не обещается.'
          : `Пока нельзя. Не хватает: ${list(missing)}.`,
  })

  // ---- extra --------------------------------------------------------------------------------
  add({
    id: 'manager',
    group: 'extra',
    status: manager.enabled ? 'done' : 'optional',
    required: false,
    title: 'ИИ-менеджер торговли',
    why: 'Разбирает результаты агентов тренировки и предлагает бумажные эксперименты. Реальные деньги не трогает.',
    actions: ['Включите в разделе «Менеджер». Нужна платная модель.'],
    link: '/office/manager',
    linkLabel: 'Менеджер',
    state: manager.enabled ? 'Включён.' : 'Выключен.',
  })
  const execution = input.execution
  const execDemoReady = execution.filter((t) => !t.demoReady)
  add({
    id: 'execution',
    group: 'extra',
    status: execDemoReady.length ? 'done' : 'optional',
    required: false,
    title: 'Направления: фандинг, арбитраж, DeFi, прогнозы',
    why: 'Тренировка идёт сама на виртуальных деньгах. Для Demo нужны отдельные ключи, Live открывается после пяти Demo-циклов и ваших флагов.',
    actions: [
      'Для Demo фандинга: отдельный ключ Bybit (FUNDING_BYBIT_DEMO_*), для прогнозов Kalshi (PREDICTION_KALSHI_DEMO_*), для DeFi тестовый кошелёк (DEFI_DEMO_CONFIG). Всё в .env через админа.',
    ],
    link: '/office/earnings',
    linkLabel: 'Направления',
    state: `Тренировка идёт: ${list(execution.filter((t) => t.paperStatus === 'running').map((t) => t.title)) || 'ни по одному направлению'}. Demo готово: ${list(execDemoReady.map((t) => t.title)) || 'нет ключей'}.`,
  })
  if (trading.otherLiveKeys.length === 0)
    add({
      id: 'other-exchanges',
      group: 'extra',
      status: 'optional',
      required: false,
      title: 'Другие биржи: OKX, Binance, Bitget',
      why: 'Тренировка на них идёт и так. Реальные ключи нужны только если захотите торговать там настоящими деньгами.',
      actions: ['Те же правила, что для Bybit: субаккаунт, только спот, IP сервера, без вывода.'],
      link: '/office/trading',
      linkLabel: 'Торговая ферма',
      state: 'Реальных ключей нет; тренировка работает.',
    })

  // ---- assemble -----------------------------------------------------------------------------
  const full: LaunchStep[] = steps.map((s) => ({
    ...s,
    required: s.required ?? true,
    codes: s.codes ?? [],
  }))
  const required = full.filter((s) => s.required)
  const next =
    full.find((s) => s.required && s.status === 'needed') ??
    full.find((s) => s.status === 'needed') ??
    null
  return {
    generatedAt: now.toISOString(),
    done: required.filter((s) => s.status === 'done').length,
    total: required.length,
    next,
    groups: groupOrder
      .map((id) => ({ id, ...groupMeta[id], steps: full.filter((s) => s.group === id) }))
      .filter((g) => g.steps.length),
  }
}
