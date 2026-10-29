const secretKey = /token|secret|password|passphrase|apiKey|overrideKey|authorization/i;
export function redact(value: any): any {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([key]) => !secretKey.test(key)).map(([key, v]) => [key, redact(v)]));
  return value;
}
