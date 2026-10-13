import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pool, query } from '../../core/db'
import { applyMigrations, resetDatabase } from './helpers/db'

const sender = `0x${'ab'.repeat(20)}`
const prepared = (nonce = 3) => ({
  intent: { venue: 'aave' },
  payload: { chainId: 11155111, sender, nonce },
})
let demo: string, live: string, paper: string

async function insert(
  values: {
    op?: string
    chainId?: number | null
    sender?: string | null
    nonce?: number | null
    payload?: object
    sequence?: number
  } = {},
) {
  return query(
    `INSERT INTO execution_legs(id,operation_id,sequence,role,state,prepared,chain_id,sender,nonce)
    VALUES($1,$2,$3,'approve','prepared',$4,$5,$6,$7)`,
    [
      randomUUID(),
      values.op ?? demo,
      values.sequence ?? 0,
      values.payload ?? prepared(),
      values.chainId === undefined ? 11155111 : values.chainId,
      values.sender === undefined ? sender : values.sender,
      values.nonce === undefined ? 3 : values.nonce,
    ],
  )
}

describe('durable chain nonce reservations', () => {
  beforeAll(applyMigrations)
  beforeEach(async () => {
    await resetDatabase()
    demo = randomUUID()
    live = randomUUID()
    paper = randomUUID()
    await query(
      "INSERT INTO execution_portfolios(track,mode,settings) VALUES('defi','demo','{}'),('defi','live','{}'),('defi','paper','{}')",
    )
    await query(
      "INSERT INTO execution_operations(id,track,mode,reserve,plan) VALUES($1,'defi','demo',10,'{}'),($2,'defi','live',10,'{}'),($3,'defi','paper',10,'{}')",
      [demo, live, paper],
    )
  })
  afterAll(() => pool.end())

  it('reserves a physical wallet nonce across mode and operation boundaries', async () => {
    await insert()
    await expect(insert({ op: live })).rejects.toMatchObject({ code: '23505' })
    await insert({ op: live, nonce: 4, payload: prepared(4) })
    expect((await query('SELECT count(*) n FROM execution_legs'))[0]!.n).toBe('2')
  })

  it.each([
    { chainId: null },
    { sender: null },
    { nonce: null },
    { chainId: 0 },
    { nonce: -1 },
    { sender: `0x${'AB'.repeat(20)}` },
    { sender: '0x1234' },
  ])('rejects incomplete or invalid nonce identity: %j', async (input) => {
    await expect(insert(input)).rejects.toMatchObject({ code: '23514' })
  })

  it('requires metadata on private Aave and binds every column to the durable payload', async () => {
    await expect(insert({ chainId: null, sender: null, nonce: null })).rejects.toMatchObject({
      code: '23514',
    })
    await expect(insert({ payload: prepared(4) })).rejects.toMatchObject({ code: '23514' })
    await expect(
      insert({ payload: { intent: { venue: 'aave' }, payload: { chainId: 1, sender, nonce: 3 } } }),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      insert({
        payload: {
          intent: { venue: 'aave' },
          payload: { chainId: 11155111, sender: `0x${'cd'.repeat(20)}`, nonce: 3 },
        },
      }),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('lets virtual Aave legs omit nonce metadata without reserving a real nonce', async () => {
    const payload = { intent: { venue: 'aave' }, payload: { paper: true } }
    await insert({ op: paper, chainId: null, sender: null, nonce: null, payload })
    await insert({ op: paper, sequence: 1, chainId: null, sender: null, nonce: null, payload })
    expect((await query('SELECT count(*) n FROM execution_legs WHERE nonce IS NULL'))[0]!.n).toBe(
      '2',
    )
    await expect(
      insert({ op: live, chainId: null, sender: null, nonce: null, payload }),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ op: paper, sequence: 2 })).rejects.toMatchObject({ code: '23514' })
  })

  it('keeps an unsigned rejection as terminal audit data and cannot later broadcast it', async () => {
    const id = randomUUID()
    const rejected = {
      status: 'rejected',
      externalId: null,
      filledQuantity: '0',
      grossQuote: '0',
      quoteFee: '0',
      baseFee: '0',
    }
    await query(
      "INSERT INTO execution_legs(id,operation_id,sequence,role,state,prepared,receipt) VALUES($1,$2,0,'approve','terminal',$3,$4)",
      [id, demo, { intent: { venue: 'aave' }, payload: {}, externalId: null }, rejected],
    )
    await expect(
      query("UPDATE execution_legs SET state='prepared' WHERE id=$1", [id]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      query('UPDATE execution_legs SET receipt=$2 WHERE id=$1', [
        id,
        { ...rejected, filledQuantity: '1' },
      ]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      query('UPDATE execution_legs SET submitted_at=now() WHERE id=$1', [id]),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('does not permit removing or changing a prepared nonce reservation', async () => {
    await insert()
    await expect(
      query(
        'UPDATE execution_legs SET chain_id=NULL,sender=NULL,nonce=NULL WHERE operation_id=$1',
        [demo],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      query('UPDATE execution_legs SET prepared=$2 WHERE operation_id=$1', [demo, prepared(4)]),
    ).rejects.toMatchObject({ code: '23514' })
    await query(
      "UPDATE execution_legs SET state='submitted',submitted_at=now() WHERE operation_id=$1",
      [demo],
    )
  })
})
