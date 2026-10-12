# Project instructions

Отвечай по-русски, кратко и по делу. Обычные обратимые действия выполняй самостоятельно.

## Architecture

- Nuxt 4 / Vue / TypeScript, PostgreSQL, separate Node worker, Docker Compose.
- Read `docs/01-project-plan.md`, `docs/03-setup.md` and `docs/STATUS.md` before continuing significant work.
- Models produce validated data. Only server code performs actions. Never grant models shell, SQL, secrets, policy editing, wallets or unrestricted network access.
- `prompts/master.md` is shared by every model role. Hard limits belong in `core/policy.ts` and database transactions, not only in prompts.
- Sandbox and Sepolia are test modes. Never count test payments as revenue. Mainnet and real cryptocurrency sales are intentionally unavailable.
- The owner authorized a separate multi-exchange spot-trading product (OKX, Bybit, Binance, Bitget) on 12.10.2026. Ledgers, agents, orders and risk history are isolated by exchange and paper/demo/live mode. The owner clarified that 100 USDT was an example, not a funding ceiling: initial live allocations are owner-defined, remain immutable after activation and must pass exact-input, minimum-capital and exchange-balance checks. Only server code can submit allowlisted cash IOC orders; models never get keys or trading tools. Live trading needs local credentials, explicit enablement and the enforced acceptance gates. Transfers, withdrawals, margin and derivatives remain unavailable. See `docs/21-trading.md`.
- Money uses integer kopecks; on-chain values use integer wei strings / BigInt. No floating point accounting.
- Preserve archived strategies, product snapshots, obligations, audit records and idempotency keys.
- Never weaken tests, security or operating limits to make a demo pass.

## Verification and handover

- `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run build` for meaningful application changes. Integration tests need a separate database ending in `_test`.
- `npm run format:check` for formatting. Check changed UI with Playwright.
- Keep `docs/STATUS.md` honest about real external integrations and uncompleted acceptance checks.
- Commit complete, verified work in small independent commits. English conventional commit messages, no model attribution or bot coauthors. Check commit author and message before finishing.
- Never commit `.env`, credentials, private keys, database dumps or customer material. Credentials are configured locally / on the server, not sent through chat.
