import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoadError } from '@/features/calendar/components/LoadError'
import { RefreshError } from '@/features/calendar/components/RefreshError'
import { failedRefresh, failedWithoutData } from '@/features/calendar/queryState'
import { ListSkeleton, SettingsScreen } from '@/features/settings/components/SettingsScreen'
import type { SettingsFrame } from '@/features/settings/hooks/useSettingsFrame'
import { failureOf } from '@/shared/lib/rpcError'
import { Button } from '@/shared/ui/Button'
import { useMembers } from '../hooks/useMembers'
import type { Member } from '../schema'
import { InviteSheet } from './InviteSheet'
import { MemberList } from './MemberList'
import { MemberSheet } from './MemberSheet'

type OpenSheet = { readonly kind: 'invite' } | { readonly kind: 'member'; readonly member: Member }

/**
 * /settings/members (owner only, `OwnerOnly`; contract 1.7 §6.8): everyone with a login, one
 * primary action «Πρόσκληση μέλους». A row (never the caller's own, D10) opens the role and the
 * removal. Every write asks for a fresh code when the server says so.
 */
export function MembersPage() {
  const { t } = useTranslation('pro')
  return (
    <SettingsScreen
      title={t('members.title')}
      intro={t('members.intro')}
      loadingLabel={t('members.loading')}
    >
      {(frame) => <Members frame={frame} />}
    </SettingsScreen>
  )
}

function Members({ frame }: { frame: SettingsFrame }) {
  const { t } = useTranslation('pro')
  const members = useMembers(frame.businessId)
  const [sheet, setSheet] = useState<OpenSheet | null>(null)
  const retry = () => void members.refetch()
  const close = () => setSheet(null)

  return (
    <>
      <Button
        block
        disabled={members.data === undefined}
        onClick={() => setSheet({ kind: 'invite' })}
      >
        {t('members.invite')}
      </Button>
      {failedWithoutData(members) ? (
        <LoadError failure={failureOf(members.error)} onRetry={retry} />
      ) : members.data === undefined ? (
        <ListSkeleton label={t('members.loading')} />
      ) : (
        <>
          {failedRefresh(members) && (
            <RefreshError failure={failureOf(members.error)} onRetry={retry} />
          )}
          <MemberList
            members={members.data}
            onOpen={(member) => setSheet({ kind: 'member', member })}
          />
        </>
      )}
      {sheet?.kind === 'invite' && members.data && (
        <InviteSheet
          businessId={frame.businessId}
          businessName={frame.business.name}
          staff={frame.staff}
          members={members.data}
          onClose={close}
        />
      )}
      {sheet?.kind === 'member' && (
        <MemberSheet businessId={frame.businessId} member={sheet.member} onClose={close} />
      )}
    </>
  )
}
