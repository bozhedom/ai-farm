import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const forbidden = /[—→←↗↓↑]/g

function vueFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? vueFiles(join(dir, entry.name))
      : entry.name.endsWith('.vue')
        ? [join(dir, entry.name)]
        : [],
  )
}

/** The root template block with HTML comments blanked out; line numbers are preserved. */
function template(source: string) {
  const start = source.indexOf('<template')
  const end = source.lastIndexOf('</template>')
  if (start < 0 || end < start) return ''
  return (
    source.slice(0, start).replace(/[^\n]/g, ' ') +
    source
      .slice(start, end)
      .replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '))
  )
}

describe('interface text', () => {
  it('has no long dashes or arrow characters in Vue templates', () => {
    const files = vueFiles('app')
    expect(files.length).toBeGreaterThan(10)
    const found = files.flatMap((file) =>
      template(readFileSync(file, 'utf8'))
        .split('\n')
        .flatMap((line, i) =>
          line.match(forbidden) ? [`${file}:${i + 1}: ${line.trim().slice(0, 120)}`] : [],
        ),
    )
    expect(found).toEqual([])
  })
})
