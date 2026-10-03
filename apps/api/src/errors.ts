// The error shape every route answers with (docs/PLAN.md → «API-контракти»).
// The rate limit (T052) answers in it too, from `middleware.ts`.

import type { ErrorResponse } from '@mandate/shared'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export type ErrorCode = ErrorResponse['error']['code']

export const errorBody = (
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): ErrorResponse => ({ error: { code, message, details } })

export const fail = (
  c: Context,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> = {},
) => c.json(errorBody(code, message, details), status)

/** Before the first census there is no moment to report, so nothing is served as state. */
export const notIndexedYet = (c: Context) =>
  fail(c, 503, 'INTERNAL', 'The index has not read the chain yet')
