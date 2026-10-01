import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isFresh, parseSamples } from '../core/observation'
try {
  const samples = parseSamples(
    JSON.parse(
      await readFile(join(process.env.HEALTH_DIRECTORY || '.health', 'observation.json'), 'utf8'),
    ),
  )
  process.exit(isFresh(samples.at(-1)?.at, 90000) ? 0 : 1)
} catch {
  process.exit(1)
}
