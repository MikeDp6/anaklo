import { useEffect } from 'react'
import { setLocale } from '@/shared/i18n'
import type { Locale } from '@/shared/lib/domain'
import { themeVariables } from '@/shared/lib/theme'

/** Applies the business theme, language and page title while its booking page is open. */
export function useBusinessPresentation(options: {
  theme: unknown
  locale: Locale | undefined
  title: string
}) {
  const { theme, locale, title } = options

  useEffect(() => {
    const root = document.documentElement
    const vars = themeVariables(theme)
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value)
    return () => {
      for (const name of Object.keys(vars)) root.style.removeProperty(name)
    }
  }, [theme])

  useEffect(() => {
    if (locale) void setLocale(locale)
  }, [locale])

  useEffect(() => {
    document.title = title
  }, [title])
}
