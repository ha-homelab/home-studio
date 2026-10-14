// Structured UI guidance while keeping the public validator's English messages
// unchanged for callers, logs and compiler-parity checks. No locale dependency.
export class ValidationError extends Error {
  constructor(message, key = message, params = {}, labels = {}) {
    super(message);
    this.translation = Object.freeze({ key, params: Object.freeze({ ...params }), labels: Object.freeze({ ...labels }) });
  }
}

export function formatValidationError(error, translate) {
  if (!(error instanceof ValidationError)) return String(error?.message ?? error);
  const { key, params, labels } = error.translation;
  const values = { ...params };
  // Only code-authored field labels enter `labels`. User names and identifiers
  // stay literal in `params`, including when their value matches a message key.
  for (const [name, label] of Object.entries(labels)) values[name] = translate(label);
  return translate(key, values);
}
