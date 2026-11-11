/** OpenAI-format error body so client SDKs display it correctly. */
export function openAiError(message: string, type: string, code: string) {
  return { error: { message, type, code } };
}

export type AnthropicErrorType =
  | "authentication_error"
  | "permission_error"
  | "rate_limit_error"
  | "api_error"
  | "invalid_request_error";

/** Anthropic-format error body so their SDKs display it correctly. */
export function anthropicError(type: AnthropicErrorType, message: string, code?: string) {
  return { type: "error", error: { type, message, ...(code ? { code } : {}) } };
}
