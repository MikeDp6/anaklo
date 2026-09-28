import { useTranslation } from 'react-i18next'
import { useRevalidator } from 'react-router'
import { SignOutButton } from '@/features/auth/components/SignOutButton'
import { Button } from '@/shared/ui/Button'
import { Notice } from '@/shared/ui/Notice'
import { Page } from '@/shared/ui/Page'

/**
 * A route guard failed (offline, Supabase unreachable, a session the database rejects).
 * Retry runs the guards again; sign-out is the way out of a session that keeps failing.
 */
export function RouteErrorPage() {
  const { t } = useTranslation(['pro', 'common'])
  const { revalidate, state } = useRevalidator()
  return (
    <Page>
      <Notice
        tone="error"
        headingLevel={1}
        title={t('loadErrorTitle')}
        body={t('loadErrorBody')}
        action={
          <Button onClick={() => void revalidate()} disabled={state === 'loading'}>
            {t('common:retry')}
          </Button>
        }
      />
      <SignOutButton />
    </Page>
  )
}
