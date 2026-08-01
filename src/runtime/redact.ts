const SENSITIVE_KEY = /(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|cookie|credential)/i;
const EMAIL_KEY = /^email$/i;
const ACCOUNT_KEY = /(?:account|organization|org)[-_]?id/i;
const SENSITIVE_QUERY_KEY = /(?:key|token|secret|password|credential|auth|code)/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactText(value: string, secrets: readonly string[] = []): string {
  let output = value.replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]");

  for (const secret of secrets) {
    if (!secret) continue;
    output = output.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]");
  }

  return output;
}

export function redactHeaders(
  headers: Readonly<Record<string, string>>,
  secrets: readonly string[] = [],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) =>
      SENSITIVE_KEY.test(key) ? [key, "[REDACTED]"] : [key, redactText(value, secrets)],
    ),
  );
}

export function redactUrl(value: string, secrets: readonly string[] = []): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return redactText(value, secrets);
  }

  const query = [...url.searchParams.entries()]
    .map(([key, queryValue]) => {
      const safeKey = encodeURIComponent(key);
      const safeValue = SENSITIVE_QUERY_KEY.test(key)
        ? "[REDACTED]"
        : redactText(encodeURIComponent(queryValue), secrets);
      return `${safeKey}=${safeValue}`;
    })
    .join("&");

  const base = `${url.origin}${url.pathname}`;
  return `${base}${query ? `?${query}` : ""}${url.hash}`;
}

export function maskEmail(value: string): string {
  const at = value.indexOf("@");
  if (at <= 0 || at === value.length - 1) return "[REDACTED]";
  return `${value[0]}***${value.slice(at)}`;
}

export function maskAccountId(value: string): string {
  if (value.length <= 7) return "[REDACTED]";
  return `${value.slice(0, 4)}***${value.slice(-3)}`;
}

function redactUnknown(value: unknown, secrets: readonly string[], seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[REDACTED]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, secrets, seen));

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      output[key] = "[REDACTED]";
    } else if (EMAIL_KEY.test(key) && typeof nested === "string") {
      output[key] = maskEmail(nested);
    } else if (ACCOUNT_KEY.test(key) && typeof nested === "string") {
      output[key] = maskAccountId(nested);
    } else {
      output[key] = redactUnknown(nested, secrets, seen);
    }
  }

  return output;
}

export function redactValue(value: unknown, secrets: readonly string[] = []): unknown {
  return redactUnknown(value, secrets, new WeakSet<object>());
}

function errorMessage(error: unknown, secrets: readonly string[], depth: number): string {
  if (depth > 8) return "[REDACTED]";
  if (error instanceof Error) {
    const cause = "cause" in error ? error.cause : undefined;
    const suffix = cause === undefined ? "" : `; cause: ${errorMessage(cause, secrets, depth + 1)}`;
    return `${error.name}: ${redactText(error.message, secrets)}${suffix}`;
  }
  return redactText(String(error), secrets);
}

export function redactError(error: unknown, secrets: readonly string[] = []): string {
  return errorMessage(error, secrets, 0);
}
