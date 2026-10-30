# API-ключи бирж для спота

Ферма торгует спотом на **четырёх** биржах: OKX, Bybit, Binance Spot, Bitget. Можно подключить одну или несколько — у каждой свой счёт, ключ, бюджет и журнал. Прибыль не гарантируется. Ферма **не** выводит деньги и **не** переводит их между счетами: только покупка/продажа спота в пределах вашего бюджета.

Общее для всех:

- Отдельный аккаунт / субаккаунт **только под бота** (без ручной торговли и других ботов).
- Перед первым запуском на торговом счёте — **только USDT** (лишние монеты уберите).
- Минимум бюджета на включённую биржу: **20 USDT**.
- Live-ключ с **привязкой к IP сервера**: **`89.19.215.46`**.
- **Withdraw / вывод** — всегда выкл. Переводы между счетами ключу тоже не даём.
- Секрет ключа в общий чат лучше не слать; админ пишет его в `.env` на сервере.
- Ключ сам торговлю не включает: нужны `TRADING_LIVE_ENABLED=true`, бюджет и фраза в кабинете (`ТОРГОВАТЬ N USDT НА OKX` / `BYBIT` / `BINANCE` / `BITGET`).

Названия меню у бирж могут отличаться. Если застряли — пришлите скрин.

---

## Сводная таблица

| Биржа   | Торговый счёт                        | Права Live-ключа                                                                                              | Ещё нужно                                | Переменные `.env`                             |
| ------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------- |
| OKX     | Spot / cash (не Multi-currency PM)   | Read + Trade, без Withdraw, IP                                                                                | **Passphrase** API                       | `OKX_LIVE_API_KEY`, `SECRET`, `PASSPHRASE`    |
| Bybit   | UTA, Cross/Regular, Spot Margin ВЫКЛ | Только **Spot → Trade**, без Contracts/Withdraw/Transfer, IP                                                  | USDT в **Unified**, не Funding           | `BYBIT_LIVE_API_KEY`, `SECRET`                |
| Binance | Отдельный Spot                       | Reading + Spot (Margin Trading в галке биржи часто вместе со Spot); без Futures/Withdraw/Transfer/Options, IP | **Скидка комиссий в BNB выкл.**          | `BINANCE_LIVE_API_KEY`, `SECRET`              |
| Bitget  | UTA **basic**                        | `uta_mgt` + `uta_trade`, без withdraw/copy, IP                                                                | **Passphrase**; **комиссии в BGB выкл.** | `BITGET_LIVE_API_KEY`, `SECRET`, `PASSPHRASE` |

Demo (по желанию, отдельные ключи, не Live):

| Биржа   | Демо                                            | Переменные                                    |
| ------- | ----------------------------------------------- | --------------------------------------------- |
| OKX     | Demo Trading                                    | `OKX_DEMO_API_KEY`, `SECRET`, `PASSPHRASE`    |
| Bybit   | Demo Trading                                    | `BYBIT_DEMO_API_KEY`, `SECRET`                |
| Binance | [Spot Testnet](https://testnet.binance.vision/) | `BINANCE_DEMO_API_KEY`, `SECRET`              |
| Bitget  | Demo Trading                                    | `BITGET_DEMO_API_KEY`, `SECRET`, `PASSPHRASE` |

Обычный Live-ключ для Demo **не** подходит.

Ссылки на страницы API: OKX — [my-api](https://www.okx.com/account/my-api), Bybit — [api-management](https://www.bybit.com/app/user/api-management), Binance — [api-management](https://www.binance.com/en/my/settings/api-management), Bitget — [newapi](https://www.bitget.com/account/newapi).

---

## Bybit (подробно)

### 1. Субаккаунт

1. Основной аккаунт: KYC и 2FA.
2. Аватар → **Subaccounts** → **Create Subaccount** → **Standard Subaccount**, имя например `farm-spot`.
3. Работайте дальше уже в этом субаккаунте.

### 2. Режим счёта

1. **Unified Trading Account**.
2. **Margin Mode** = **Cross** (кросс-маржа / `REGULAR_MARGIN`).
3. **Spot Margin Trading** — **выключен**.

Это не «включить плечо», а режим учёта. Isolated для спот-бота не подходит.

### 3. Деньги

USDT должны быть в **Unified Trading**, не в **Funding**.

1. Assets → **Transfer**.
2. Funding → Unified Trading, монета USDT, сумма ≥ бюджета.
3. С основного на субаккаунт — отдельным переводом, если нужно.

### 4. Live-ключ

В субаккаунте `farm-spot`:

1. **API** → **Create New Key** → System-generated → **API Transaction**.
2. **Read-Write**.
3. Только **Unified Trading → Spot → Trade**.
4. Выкл: Derivatives/Contracts, Options, Withdraw, Transfer, Convert, Earn, Copy Trading и пр.
5. IP: **Only IPs…** → `89.19.215.46`.
6. Сохраните Key и Secret.

Админ:

```dotenv
BYBIT_LIVE_API_KEY=…
BYBIT_LIVE_SECRET=…
```

### Частые ошибки Bybit

| Код / симптом             | Что проверить                    |
| ------------------------- | -------------------------------- |
| `TRADING_KEY_PERMISSIONS` | Лишние права (Contracts и т.п.)  |
| `TRADING_IP_REQUIRED`     | Нет IP `89.19.215.46`            |
| Баланс ≈ 0                | Деньги в Funding, а не в Unified |
| Isolated margin           | Нужен Cross / Regular            |
| Ключ «протух»             | Создан без IP-ограничения        |

---

## OKX

1. Выделенный аккаунт / субаккаунт под бота: **Spot / cash**.
2. Не Multi-currency / Portfolio Margin. Адаптер допускает Spot либо Futures-account, на котором торгуется только cash spot.
3. API: Read + **Trade**, без **Withdraw**, IP `89.19.215.46`.
4. Задайте **Passphrase** при создании ключа — он понадобится в `.env`.
5. Пополните торговый Spot USDT (≥ бюджета).

```dotenv
OKX_LIVE_API_KEY=…
OKX_LIVE_SECRET=…
OKX_LIVE_PASSPHRASE=…
```

При региональном аккаунте админ выставляет `OKX_API_HOST` из списка официальных доменов в конфиге.

---

## Binance Spot

1. Отдельный Spot-аккаунт под бота (не Futures-only).
2. API: Reading + торговля спотом. Отдельно **выключите** Futures, Withdraw, Transfer, Options (и прочие лишние).
3. IP `89.19.215.46`.
4. **Выключите оплату комиссий в BNB** (скидка BNB) — иначе сверка комиссий может разъехаться.
5. Пополните Spot USDT.

```dotenv
BINANCE_LIVE_API_KEY=…
BINANCE_LIVE_SECRET=…
```

Глобальный Spot API `api.binance.com`. Binance.US и другие отдельные продукты не поддержаны.

Demo = **Spot Testnet** (`testnet.binance.vision`), не обычный ключ основного аккаунта.

---

## Bitget

1. Выделенный **UTA** в режиме **basic** (без delta, без займов и деривативов под бота).
2. API: права UTA на управление/торговлю (`uta_mgt` + `uta_trade`), **без** withdraw и copy trading, IP `89.19.215.46`.
3. Нужен **Passphrase**.
4. **Выключите оплату комиссий в BGB**.
5. Пополните UTA USDT.

```dotenv
BITGET_LIVE_API_KEY=…
BITGET_LIVE_SECRET=…
BITGET_LIVE_PASSPHRASE=…
```

---

## После ключей (любая биржа)

1. Админ вписывает переменные в `/opt/ai-farm/.env`, пересоздаёт web/worker.
2. Кабинет → «Торговая ферма» → биржа → «Реальные деньги» → **Проверить подключение**.
3. `TRADING_LIVE_ENABLED=true` (один флаг на все биржи).
4. «Бюджет на биржи»: целые USDT на каждую нужную (0 = выкл).
5. Запуск с фразой, например `ТОРГОВАТЬ 25 USDT НА BYBIT`.

Автопилот Live не включает. После первого старта бюджет этой биржи фиксируется.

Можно начать с одной биржи (часто Bybit) и добавить остальные позже — у каждой свой ключ и свой минимум 20 USDT.

---

## Не путать с другими ключами Bybit

| Назначение                    | Права                                | Переменные                       |
| ----------------------------- | ------------------------------------ | -------------------------------- |
| Спот-бот                      | Только Spot Trade + IP               | `BYBIT_LIVE_*`                   |
| Фандинг-хедж (другой субакк.) | Spot + Contracts Orders/Positions    | `EXECUTION_FUNDING_BYBIT_LIVE_*` |
| Наблюдение депозитов          | **Read-Only**, без торговли и вывода | `BYBIT_WALLET_READ_*`            |

Один субаккаунт/ключ нельзя вешать сразу на спот и фандинг: разные книги учёта.
