import { z } from 'zod'
import { BYBIT_SPOT_POLICY as P } from '../policy'

/** The extra permission is accepted only for the owner's legacy spot product, not execution. */
export function assertBybitSpotPermissions(
  permissions: Record<string, string[]>,
  legacySpot: boolean,
) {
  if (
    permissions.Spot?.length !== 1 ||
    permissions.Spot[0] !== 'SpotTrade' ||
    Object.entries(permissions).some(([group, values]) => {
      if (group === 'Spot' || values.length === 0) return false
      return !(
        legacySpot &&
        group === 'Derivatives' &&
        values.length === 1 &&
        values[0] === P.optionalLegacyKeyPermission
      )
    })
  )
    throw new Error('TRADING_KEY_PERMISSIONS')
}

const empty = z.object({}).strict()
const symbol = z
  .string()
  .regex(/^[A-Z0-9]{1,32}USDT$/)
  .refine((s) => s !== 'USDTUSDT')
const clientId = z.string().regex(/^[a-zA-Z0-9_-]{1,36}$/)
const amount = z
  .string()
  .regex(/^\d+(?:\.\d{1,18})?$/)
  .refine((s) => /[1-9]/.test(s))
const category = z.literal(P.category)
const identified = z.object({ category, symbol, orderLinkId: clientId }).strict()
const lookup = identified.extend({ limit: z.literal('50') })

type Rule = { privateCall: boolean; query: z.ZodType; body?: z.ZodType }
// No generic signed request can escape these endpoints and exact parameter shapes.
const rules = new Map<string, Rule>([
  ['/v5/market/time', { privateCall: false, query: empty }],
  [
    '/v5/market/instruments-info',
    {
      privateCall: false,
      query: z.object({ category, symbol: symbol.optional() }).strict(),
    },
  ],
  ['/v5/market/tickers', { privateCall: false, query: z.object({ category }).strict() }],
  [
    '/v5/market/kline',
    {
      privateCall: false,
      query: z
        .object({ category, symbol, interval: z.literal('1'), limit: z.literal('121') })
        .strict(),
    },
  ],
  [
    '/v5/market/orderbook',
    {
      privateCall: false,
      query: z.object({ category, symbol, limit: z.literal('50') }).strict(),
    },
  ],
  ['/v5/user/query-api', { privateCall: true, query: empty }],
  ['/v5/account/info', { privateCall: true, query: empty }],
  [
    '/v5/account/wallet-balance',
    {
      privateCall: true,
      query: z.object({ accountType: z.literal('UNIFIED') }).strict(),
    },
  ],
  ['/v5/account/fee-rate', { privateCall: true, query: z.object({ category, symbol }).strict() }],
  [
    '/v5/order/realtime',
    {
      privateCall: true,
      query: z.union([
        lookup,
        z.object({ category, openOnly: z.literal('0'), limit: z.literal('50') }).strict(),
      ]),
    },
  ],
  ['/v5/order/history', { privateCall: true, query: lookup }],
  [
    '/v5/execution/list',
    {
      privateCall: true,
      query: z
        .object({ category, symbol, orderId: z.string().min(1).max(100), limit: z.literal('100') })
        .strict(),
    },
  ],
  [
    '/v5/order/create',
    {
      privateCall: true,
      query: empty,
      body: identified.extend({
        side: z.enum(['Buy', 'Sell']),
        orderType: z.literal(P.orderType),
        qty: amount,
        price: amount,
        timeInForce: z.literal(P.timeInForce),
        isLeverage: z.literal(P.isLeverage),
      }),
    },
  ],
  ['/v5/order/cancel', { privateCall: true, query: empty, body: identified }],
])

/** Runs before credentials are read, the signature is built or the transport is contacted. */
export function assertBybitSpotRequest(
  path: string,
  query: Record<string, string>,
  body: Record<string, unknown> | undefined,
  privateCall: boolean,
) {
  const rule = rules.get(path)
  if (
    !rule ||
    rule.privateCall !== privateCall ||
    !rule.query.safeParse(query).success ||
    (rule.body ? !rule.body.safeParse(body).success : body !== undefined)
  )
    throw new Error('TRADING_BYBIT_REQUEST_FORBIDDEN')
}
