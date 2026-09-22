export function redact(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(
      /\b(?:set-cookie|cookie|authorization)\s*:\s*[^\r\n]+/gi,
      (match) => match.split(":")[0] + ": [redacted]",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "$1 [redacted]")
    .replace(
      /((?:password|passwd|secret|token|authorization|cookie|api[_-]?key)["']?\s*[=:]\s*["']?)[^\s,"';}]+/gi,
      "$1[redacted]",
    );
}
export function redactData<T>(data: T): T {
  if (typeof data === "string") return redact(data) as T;
  if (Array.isArray(data)) return data.map((v) => redactData(v)) as T;
  if (data && typeof data === "object")
    return Object.fromEntries(
      Object.entries(data).map(([key, value]) => [
        key,
        /^(?:password|passwd|secret|token|authorization|cookie|api[_-]?key)$/i.test(
          key,
        )
          ? "[redacted]"
          : redactData(value),
      ]),
    ) as T;
  return data;
}
export function safeUrl(value: string) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()])
      url.searchParams.set(key, "[redacted]");
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid URL]";
  }
}
export function actionUrl(value: string) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()])
    if (/token|auth|key|code|session|secret|password/i.test(key))
      url.searchParams.set(key, "[redacted]");
  if (/token|auth|secret|password/i.test(url.hash)) url.hash = "";
  return url.toString();
}
