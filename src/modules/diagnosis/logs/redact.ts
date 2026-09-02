/**
 * Strip secrets and personal data from log text before it is stored or sent to the model.
 * Conservative by design: it targets shapes that appear in the Luna app's API dumps.
 */
const RULES: [RegExp, string][] = [
  [/(authorization\s*[:=]\s*)bearer\s+[a-z0-9\-._~+/]+=*/gi, '$1Bearer [REDACTED]'],
  [/("?(?:access_?token|refresh_?token|id_?token|token|api[_-]?key|secret|password|passcode|otp|pin)"?\s*[:=]\s*"?)([^",\s}]{3,})/gi, '$1[REDACTED]'],
  [/\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
  [/("?(?:mobile|phone|phone_?number|contact|msisdn)"?\s*[:=]\s*"?)(\+?\d[\d\s-]{7,}\d)/gi, '$1[REDACTED]'],
  [/\b(\+91[\s-]?)?[6-9]\d{9}\b/g, '[REDACTED_PHONE]'],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}
