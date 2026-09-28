import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthUnknownError,
  AuthWeakPasswordError,
} from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { mapSendCodeError, mapVerifyCodeError } from './loginErrors'

const neutral = { codeStep: true, messageKey: 'pro.login.codeSentNeutral' }
const network = { codeStep: false, messageKey: 'pro.login.errorNetwork' }
const tooMany = { codeStep: false, messageKey: 'pro.login.errorTooManyRequests' }

describe('mapSendCodeError (ADR-0009 §4: the screen never reveals which emails exist)', () => {
  it('success → the neutral message and the code step', () => {
    expect(mapSendCodeError(null)).toEqual(neutral)
    expect(mapSendCodeError(undefined)).toEqual(neutral)
  })

  it('unknown email (422 otp_disabled) → exactly the same as success', () => {
    const error = new AuthApiError('Signups not allowed for otp', 422, 'otp_disabled')
    expect(mapSendCodeError(error)).toEqual(mapSendCodeError(null))
  })

  it('per-address limit (429 over_email_send_rate_limit) → exactly the same as success', () => {
    const error = new AuthApiError(
      'For security purposes, you can only request this after 60 seconds.',
      429,
      'over_email_send_rate_limit',
    )
    expect(mapSendCodeError(error)).toEqual(mapSendCodeError(null))
  })

  it.each([
    ['signup_disabled', 422],
    ['user_not_found', 404],
    ['email_address_invalid', 400],
    ['validation_failed', 400],
    [undefined, 400],
  ])('any other Auth answer (%s) stays neutral as well', (code, status) => {
    expect(mapSendCodeError(new AuthApiError('x', status, code))).toEqual(neutral)
  })

  it('an unexpected error type stays neutral', () => {
    expect(mapSendCodeError(new AuthWeakPasswordError('x', 422, []))).toEqual(neutral)
    expect(mapSendCodeError(new Error('x'))).toEqual(neutral)
    expect(mapSendCodeError('x')).toEqual(neutral)
  })

  it('per-IP limit (429 over_request_rate_limit) → its own message, stays on the email step', () => {
    const error = new AuthApiError('Request rate limit reached', 429, 'over_request_rate_limit')
    expect(mapSendCodeError(error)).toEqual(tooMany)
  })

  it('offline (fetch failed) → the network message', () => {
    expect(mapSendCodeError(new AuthRetryableFetchError('Failed to fetch', 0))).toEqual(network)
    expect(mapSendCodeError(new TypeError('Failed to fetch'))).toEqual(network)
  })

  it('server or gateway errors (5xx) and non-JSON answers → the network message', () => {
    expect(mapSendCodeError(new AuthRetryableFetchError('Bad Gateway', 502))).toEqual(network)
    expect(mapSendCodeError(new AuthUnknownError('Unexpected token <', {}))).toEqual(network)
  })
})

describe('mapVerifyCodeError', () => {
  it('success → signed in, no message', () => {
    expect(mapVerifyCodeError(null)).toEqual({ signedIn: true, messageKey: null })
  })

  it.each([
    ['otp_expired', 403],
    ['validation_failed', 400],
    [undefined, 400],
  ])('wrong, expired or unknown (%s) → one message for all', (code, status) => {
    expect(
      mapVerifyCodeError(new AuthApiError('Token has expired or is invalid', status, code)),
    ).toEqual({ signedIn: false, messageKey: 'pro.login.errorCodeInvalid' })
  })

  it('network and per-IP limit keep their own messages', () => {
    expect(mapVerifyCodeError(new AuthRetryableFetchError('Failed to fetch', 0))).toEqual({
      signedIn: false,
      messageKey: 'pro.login.errorNetwork',
    })
    expect(
      mapVerifyCodeError(new AuthApiError('Too many', 429, 'over_request_rate_limit')),
    ).toEqual({ signedIn: false, messageKey: 'pro.login.errorTooManyRequests' })
  })
})
