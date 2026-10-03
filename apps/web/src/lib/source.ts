/**
 * Where responses come from, and how a failure is told apart (T053). Separate from
 * `api.ts` so the fixture source can throw the same errors without importing the
 * module that imports it.
 */
import { errorResponseSchema } from '@mandate/shared'

/** An answer in the contract's error format, or a status that came without one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
    /** From `Retry-After` on a 429, in seconds. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** A response the API sent that the contract does not describe. Not worth a retry. */
export class ContractError extends Error {
  constructor(
    readonly path: string,
    readonly issues: unknown,
  ) {
    super(`The response to ${path} does not match the contract`)
    this.name = 'ContractError'
  }
}

/** Resolves with the JSON body of a success; rejects with an `ApiError` otherwise. */
export type Source = (path: string) => Promise<unknown>

const retryAfter = (header: string | null): number | null => {
  if (header === null) return null
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

export const httpSource =
  (baseUrl: string, fetchImpl: typeof fetch = (...args) => fetch(...args)): Source =>
  async (path) => {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      headers: { Accept: 'application/json' },
    })
    const body: unknown = await response.json().catch(() => null)
    if (response.ok) return body

    const error = errorResponseSchema.safeParse(body)
    const wait = retryAfter(response.headers.get('Retry-After'))
    if (!error.success) {
      throw new ApiError(response.status, 'HTTP', `${path} answered ${response.status}`, {}, wait)
    }
    const { code, message, details } = error.data.error
    throw new ApiError(response.status, code, message, details, wait)
  }
