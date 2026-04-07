/**
 * Opaque trust token used to authorize privileged runtime operations
 * (e.g. bypassing Claude permission checks).
 *
 * Only code that can import this symbol can produce a valid token.
 * A plain boolean in metadata could be spoofed by any caller constructing
 * the metadata object; a Symbol cannot be guessed or serialized over JSON.
 */
export const RUNTIME_TRUST_TOKEN: unique symbol = Symbol.for("aif.runtime.trust");

export type RuntimeTrustToken = typeof RUNTIME_TRUST_TOKEN;

/**
 * Check whether the given value is the valid trust token.
 */
export function isValidTrustToken(value: unknown): value is RuntimeTrustToken {
  return value === RUNTIME_TRUST_TOKEN;
}
