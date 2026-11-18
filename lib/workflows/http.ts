import { z } from "zod";
export const httpMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpCredential = {
  id: string;
  name: string;
  origin: string;
  headerName: string;
  bearer: boolean;
  createdAt: string;
};
export function httpURL(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname) ||
    /\.(localhost|local|internal|lan|home|arpa)$/.test(url.hostname)
  )
    throw new Error(
      "Use a public HTTPS hostname on port 443, without credentials or a fragment.",
    );
  return url;
}
export const httpURLSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .superRefine((v, ctx) => {
    try {
      httpURL(v);
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "Use a public HTTPS URL without embedded credentials, a fragment, or a custom port.",
      });
    }
  });
export const credentialInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    origin: httpURLSchema.transform((v) => httpURL(v).origin),
    headerName: z
      .string()
      .trim()
      .regex(/^[A-Za-z][A-Za-z0-9-]{0,79}$/)
      .refine(
        (v) =>
          ![
            "host",
            "cookie",
            "content-type",
            "content-length",
            "accept",
            "connection",
            "transfer-encoding",
            "idempotency-key",
          ].includes(v.toLowerCase()) && !v.toLowerCase().startsWith("cf-"),
        "Choose an authentication header, such as Authorization or X-API-Key.",
      ),
    bearer: z.boolean(),
    value: z
      .string()
      .min(1)
      .max(4096)
      .regex(
        /^[\x20-\x7e]+$/,
        "Credential must contain printable ASCII characters.",
      ),
  })
  .strict();
export type HttpRequest = {
  url: string;
  method: (typeof httpMethods)[number];
  data: Record<string, unknown>;
  requestKey: string;
};
export type HttpResponse = { status: number; body: unknown };
export class HttpError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}
export function prepareRequest(request: HttpRequest) {
  const url = httpURL(request.url);
  const json = JSON.stringify(request.data);
  if (new TextEncoder().encode(json).length > 32768)
    throw new HttpError("HTTP request data exceeds 32 KB.");
  if (request.method === "GET") {
    for (const [key, value] of Object.entries(request.data)) {
      if (value !== null && typeof value === "object")
        throw new HttpError(
          "GET parameters must be text, numbers, or booleans.",
        );
      url.searchParams.set(key, String(value ?? ""));
    }
    if (url.href.length > 8000)
      throw new HttpError("HTTP request URL exceeds 8,000 characters.");
  }
  return { url: url.href, body: request.method === "GET" ? undefined : json };
}
function redact(value: unknown, secret?: string): unknown {
  if (!secret) return value;
  if (typeof value === "string")
    return value
      .split(secret)
      .join("[redacted]")
      .split(encodeURIComponent(secret))
      .join("[redacted]");
  if (Array.isArray(value)) return value.map((v) => redact(v, secret));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        redact(k, secret),
        redact(v, secret),
      ]),
    );
  return value;
}
export async function sendHttp(
  request: HttpRequest,
  auth: { headerName: string; value: string; bearer: boolean } | undefined,
  beforeSend: () => Promise<void>,
  transport: typeof fetch = fetch,
  timeoutMs = 10000,
): Promise<HttpResponse> {
  const prepared = prepareRequest(request);
  const headers = new Headers({
    Accept: "application/json",
    "Idempotency-Key": request.requestKey,
  });
  if (prepared.body !== undefined)
    headers.set("Content-Type", "application/json");
  if (auth)
    headers.set(auth.headerName, (auth.bearer ? "Bearer " : "") + auth.value);
  await beforeSend();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response | undefined;
  try {
    response = await transport(prepared.url, {
      method: request.method,
      headers,
      body: prepared.body,
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      throw new HttpError(
        response.status >= 300 && response.status < 400
          ? "HTTP redirects are not followed. Configure the final destination URL."
          : `Destination returned HTTP ${response.status}.`,
        response.status,
      );
    }
    let text = "",
      size = 0;
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 65536) {
            await reader.cancel();
            throw new HttpError(
              "HTTP response exceeds 64 KB.",
              response.status,
            );
          }
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
    }
    let body: unknown = null;
    if (text.trim())
      try {
        body = JSON.parse(text);
      } catch {
        throw new HttpError(
          "Destination returned a non-JSON response.",
          response.status,
        );
      }
    return { status: response.status, body: redact(body, auth?.value) };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(
      controller.signal.aborted
        ? "HTTP request timed out. Delivery may have occurred; check the destination before a new enrollment."
        : "HTTP request failed. Delivery may have occurred; check the destination before a new enrollment.",
      response?.status,
    );
  } finally {
    clearTimeout(timer);
  }
}
