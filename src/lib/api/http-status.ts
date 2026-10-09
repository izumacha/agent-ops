// API が使う HTTP ステータスの唯一の参照元 (各ファイルに数値を散らさない。§6)
export const HTTP_STATUS = {
  // 200 は `Response.json(body)` の既定値だが、**明示して返す経路もある**ので唯一の参照元に含める
  // （メトリクスのようにテキストを返す経路は自分で status を書くし、ラベルの照合もここから導く）
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
} as const;
