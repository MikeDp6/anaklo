import type { AnakloEnv, SmsProviderName } from './booking-config.ts'
import type { SendResult } from './push-provider.ts'

/**
 * The SMS adapter behind `send.ts` (contract 1.3 §6, 1.5 §3.2). Pure (ADR-0002 §3): the
 * settings come in as arguments from each `index.ts`. Only the fake adapter exists until the
 * real provider (1.10); `booking-config.ts` refuses it when `ANAKLO_ENV` is prod, and so does
 * this factory.
 */

export type SmsSendRequest = {
  /** E.164 */
  readonly to: string
  /** Already prepared by `renderSms` (GSM-7, one segment). */
  readonly text: string
  readonly segments: number
}

/**
 * The adapter's answer: the result type shared with the push senders (contract 1.5 §3.3). On
 * success `segments` and `costCents` are as the provider reports them (SPEC §12), which is what
 * `messages_log` records; a failure says whether the SMS certainly did not leave (`failed`), was
 * refused for good (`rejected`) or may have left (`unknown`, never retried).
 */
export type SmsSendResult = SendResult

export interface SmsProvider {
  readonly name: string
  send(message: SmsSendRequest): Promise<SmsSendResult>
}

export type SmsProviderLog = (line: string) => void

export type CreateSmsProviderOptions = {
  readonly env: AnakloEnv
  readonly provider: SmsProviderName
  /** Defaults to `console.info`. Only the fake adapter in `local` logs, and never a full number. */
  readonly log?: SmsProviderLog
  /** For tests; defaults to `crypto.randomUUID()`. */
  readonly randomId?: () => string
}

/** `+306900000001` → `+30690****001`: enough to tell test numbers apart, not to dial. */
export function maskPhone(e164: string): string {
  if (e164.length <= 9) return '****'
  return `${e164.slice(0, 6)}****${e164.slice(-3)}`
}

/**
 * Never sends. Answers like a provider that accepted the message, at no cost. With
 * `ANAKLO_ENV=local` it logs the text (with the number masked), so a developer can read the
 * code sent to a number that is not a test number; elsewhere it logs nothing.
 */
export function createFakeSmsProvider(options: Omit<CreateSmsProviderOptions, 'provider'>) {
  const log = options.log ?? ((line: string) => console.info(line))
  const randomId = options.randomId ?? (() => crypto.randomUUID())
  const provider: SmsProvider = {
    name: 'fake',
    send(message) {
      if (options.env === 'local') {
        log(`fake-sms to=${maskPhone(message.to)} segments=${message.segments}\n${message.text}`)
      }
      return Promise.resolve({
        ok: true,
        providerMessageId: `fake-${randomId()}`,
        segments: message.segments,
        costCents: 0,
      })
    },
  }
  return provider
}

export function createSmsProvider(options: CreateSmsProviderOptions): SmsProvider {
  switch (options.provider) {
    case 'fake':
      // Second line of defence: parseBookingConfig already refuses this combination.
      if (options.env === 'prod') throw new Error('The fake SMS provider is refused in prod.')
      return createFakeSmsProvider(options)
  }
}
