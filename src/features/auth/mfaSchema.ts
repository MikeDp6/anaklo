import { z } from 'zod/mini'
import { normaliseCode } from './schema'

/**
 * The forms of the code screens (enrolment, sign-in code, code sheet), for React Hook Form via
 * `zodResolver`. Messages are i18n keys of the `pro` namespace. Only the shape is checked here;
 * GoTrue decides whether a code is right.
 */
export const MFA_FORM_ERRORS = {
  codeFormat: 'mfa.errors.codeFormat',
  nameRequired: 'mfa.errors.nameRequired',
  nameTooLong: 'mfa.errors.nameTooLong',
} as const

export type MfaFormErrorKey = (typeof MFA_FORM_ERRORS)[keyof typeof MFA_FORM_ERRORS]

/** A device name as the authenticator list shows it; long names only crowd the list. */
export const MAX_DEVICE_NAME_LENGTH = 40

/** A pasted «123 456» or an autofilled code still works: only the digits count. */
export const CodeFormSchema = z.object({
  factorId: z.string().check(z.minLength(1)),
  code: z
    .string()
    .check(z.overwrite(normaliseCode), z.regex(/^\d{6}$/, MFA_FORM_ERRORS.codeFormat)),
})
export type CodeFormValues = z.infer<typeof CodeFormSchema>

export const DeviceNameFormSchema = z.object({
  name: z
    .string()
    .check(
      z.trim(),
      z.minLength(1, MFA_FORM_ERRORS.nameRequired),
      z.maxLength(MAX_DEVICE_NAME_LENGTH, MFA_FORM_ERRORS.nameTooLong),
    ),
})
export type DeviceNameFormValues = z.infer<typeof DeviceNameFormSchema>

/** Narrows a form error message to one of ours (anything else: the code-format text). */
export function mfaFormErrorKey(message: string | undefined): MfaFormErrorKey | null {
  if (message === undefined) return null
  const keys: readonly string[] = Object.values(MFA_FORM_ERRORS)
  return keys.includes(message) ? (message as MfaFormErrorKey) : MFA_FORM_ERRORS.codeFormat
}

/** What a refused verification says (GoTrue's answer, never guessed). */
export type VerifyErrorKey =
  'mfa.errors.invalidCode' | 'mfa.errors.rateLimited' | 'mfa.errors.offline' | 'mfa.errors.unknown'

export function verifyErrorKey(
  reason: 'invalid_code' | 'rate_limited' | 'offline' | 'unknown',
): VerifyErrorKey {
  switch (reason) {
    case 'invalid_code':
      return 'mfa.errors.invalidCode'
    case 'rate_limited':
      return 'mfa.errors.rateLimited'
    case 'offline':
      return 'mfa.errors.offline'
    case 'unknown':
      return 'mfa.errors.unknown'
  }
}
