import { useTranslation } from 'react-i18next'
import { formatPhone } from '@/shared/lib/phone'
import { Button } from '@/shared/ui/Button'
import { ButtonLink } from '@/shared/ui/ButtonLink'
import { Notice } from '@/shared/ui/Notice'

/** The one retry that also brings the chunks of a newer deploy. */
function reloadPage(): void {
  window.location.reload()
}

/**
 * The fallback of an ErrorBoundary on the booking page and the manage link: a part of the page
 * did not load (usually its lazy chunk). Says so, offers a reload, and the shop's phone when the
 * page knows it (catalogue).
 */
export function LoadFailed({
  phone = null,
  headingLevel = 2,
  onRetry = reloadPage,
}: {
  phone?: string | null
  headingLevel?: 1 | 2
  onRetry?: () => void
}) {
  const { t } = useTranslation(['booking', 'common'])
  return (
    <Notice
      tone="error"
      headingLevel={headingLevel}
      title={t('errorTitle')}
      body={t('errorBody')}
      action={
        <>
          <Button onClick={onRetry}>{t('common:retry')}</Button>
          {phone && (
            <ButtonLink href={`tel:${phone}`} block>
              {t('call.action', { phone: formatPhone(phone) })}
            </ButtonLink>
          )}
        </>
      }
    />
  )
}
