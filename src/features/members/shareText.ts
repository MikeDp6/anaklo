import type { TFunction } from 'i18next'

/** What the owner sends the new member after `invite-member` answered (contract 1.7 §6.8). */
export interface ShareInput {
  readonly businessName: string
  /** `common:app.name` (the name the home-screen icon shows). */
  readonly appName: string
  readonly email: string
  /** The pro app's address on this host: `appUrl(location.origin)`. */
  readonly appUrl: string
}

/** The pro app on the host the owner is using (local, dev or production alike). */
export function appUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/app/`
}

/**
 * The invitation text: where to open the app, «add it to the home screen», which email to sign in
 * with. No code and no link with a token: the member signs in with the email code (ADR-0009).
 */
export function shareText(t: TFunction<'pro'>, input: ShareInput): string {
  return t('members.shareText', {
    business: input.businessName,
    app: input.appName,
    url: input.appUrl,
    email: input.email,
  })
}
