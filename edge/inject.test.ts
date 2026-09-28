// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { escapeHtml, injectBookingShell, serializeJsonForScript } from './inject.ts'

const SHELL = `<!doctype html>
<html lang="el">
  <head>
    <meta charset="UTF-8" />
    <meta name="theme-color" content="#1f3a5f" />
    <title>Anaklo</title>
    <script type="module" crossorigin src="/assets/booking-abc.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`

function initialJson(html: string): unknown {
  const match = /<script id="anaklo-initial" type="application\/json">([\s\S]*?)<\/script>/.exec(
    html,
  )
  return match?.[1] === undefined ? undefined : JSON.parse(match[1])
}

describe('escapeHtml', () => {
  it('escapes & < > " and \'', () => {
    expect(escapeHtml(`Tom & "Jerry's" <b>`)).toBe('Tom &amp; &quot;Jerry&#39;s&quot; &lt;b&gt;')
  })
})

describe('serializeJsonForScript', () => {
  it('cannot close the script or open a comment', () => {
    const json = serializeJsonForScript({ name: '</script><!-- & >' })
    expect(json).not.toMatch(/[<>&]/)
    expect(JSON.parse(json)).toEqual({ name: '</script><!-- & >' })
  })

  it('escapes U+2028 and U+2029', () => {
    const json = serializeJsonForScript({ text: 'a\u2028b\u2029c' })
    expect(json).toContain('\\u2028')
    expect(json).toContain('\\u2029')
    expect(json).not.toMatch(/[\u2028\u2029]/)
    expect(JSON.parse(json)).toEqual({ text: 'a\u2028b\u2029c' })
  })
})

describe('injectBookingShell', () => {
  it('returns the shell unchanged for null', () => {
    expect(injectBookingShell(SHELL, null)).toBe(SHELL)
  })

  it('sets title, Open Graph, theme colour, language and initial data', () => {
    const html = injectBookingShell(SHELL, {
      title: 'Demo Barber',
      description: 'Κλείσε ραντεβού',
      url: 'https://dev.anaklo.gr/demo-barber',
      themeColor: '#123ABC',
      lang: 'en',
      initial: { profile: { slug: 'demo-barber' } },
    })
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('<title>Demo Barber</title>')
    expect(html).not.toContain('Anaklo')
    expect(html).toContain('<meta name="description" content="Κλείσε ραντεβού" />')
    expect(html).toContain('<meta name="theme-color" content="#123ABC" />')
    expect(html).not.toContain('#1f3a5f')
    expect(html).toContain('<meta property="og:type" content="website" />')
    expect(html).toContain('<meta property="og:title" content="Demo Barber" />')
    expect(html).toContain('<meta property="og:description" content="Κλείσε ραντεβού" />')
    expect(html).toContain('<meta property="og:url" content="https://dev.anaklo.gr/demo-barber" />')
    expect(initialJson(html)).toEqual({ profile: { slug: 'demo-barber' } })
    expect(html.indexOf('anaklo-initial')).toBeLessThan(html.indexOf('</head>'))
    expect(html).toContain('<script type="module" crossorigin src="/assets/booking-abc.js">')
  })

  it('keeps a business name with </script>, quotes and $-patterns inert', () => {
    const name = `Joe's "Cuts" </script><script>alert(1)</script> $& $' $\``
    const html = injectBookingShell(SHELL, {
      title: name,
      description: name,
      initial: { profile: { name } },
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html.match(/<\/script>/g)).toHaveLength(2)
    expect(html).toContain(
      '<title>Joe&#39;s &quot;Cuts&quot; &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; $&amp; $&#39; $`</title>',
    )
    expect(html).toContain(
      'content="Joe&#39;s &quot;Cuts&quot; &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; $&amp; $&#39; $`"',
    )
    expect(initialJson(html)).toEqual({ profile: { name } })
  })

  it('omits an empty description and a missing url, keeps the shell theme colour', () => {
    const html = injectBookingShell(SHELL, { title: 'Demo', description: '  ', themeColor: 'red' })
    expect(html).not.toContain('name="description"')
    expect(html).not.toContain('og:description')
    expect(html).not.toContain('og:url')
    expect(html).not.toContain('anaklo-initial')
    expect(html).toContain('<meta name="theme-color" content="#1f3a5f" />')
  })

  it('ignores an invalid language', () => {
    const html = injectBookingShell(SHELL, { title: 'Demo', lang: 'el" onload="x' })
    expect(html).toContain('<html lang="el">')
  })

  it('is idempotent: injecting twice leaves one set of tags', () => {
    const data = {
      title: 'Demo',
      description: 'd',
      url: 'https://x.test/demo',
      themeColor: '#000000',
      initial: { a: 1 },
    }
    const twice = injectBookingShell(injectBookingShell(SHELL, data), data)
    expect(twice).toBe(injectBookingShell(SHELL, data))
    expect(twice.match(/og:title/g)).toHaveLength(1)
    expect(twice.match(/anaklo-initial/g)).toHaveLength(1)
  })

  it('adds a title when the shell has none', () => {
    const html = injectBookingShell('<html lang="el"><head>\n</head><body></body></html>', {
      title: 'Demo',
    })
    expect(html).toContain('<title>Demo</title>')
    expect(html.indexOf('<title>')).toBeLessThan(html.indexOf('</head>'))
  })
})
