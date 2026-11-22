// A single recipient and a stable key per external action. Never log the request body.
export class MarketingMailError extends Error {
  constructor(message, disposition, retryAfterMs = null) {
    super(message);
    this.name = 'MarketingMailError';
    this.disposition = disposition;
    this.retryAfterMs = retryAfterMs;
  }
}

// Retry-After can be a duration in seconds or an HTTP date. A missing or unreadable
// hint warrants a one-minute pause, and even an expired hint gives the queue a second.
function providerRetryDelay(header) {
  const hint = header?.trim() || '';
  if (/^\d+$/.test(hint)) {
    // Keep even an excessive provider hint representable by operators as an ISO date.
    return Math.max(1000, Math.min(253402300799000 - Date.now(), Number(hint) * 1000));
  }
  if (/^[a-z]{3}(?:[a-z]*,| [a-z]{3} )/i.test(hint)) {
    const date = Date.parse(hint);
    if (Number.isFinite(date)) return Math.max(1000, date - Date.now());
  }
  return 60000;
}

export function marketingMailSender(env = process.env) {
  const from = env.HARBOR_MARKETING_FROM || '';
  if (!env.HARBOR_RESEND_API_KEY || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from)) return null;
  return from;
}

export async function sendMarketingEmail(message, env = process.env, fetchImpl = fetch) {
  const from = marketingMailSender(env);
  if (!from || env.HARBOR_MARKETING_DELIVERY_ENABLED !== 'true') {
    throw new MarketingMailError('Marketing delivery is not configured and enabled.', 'retry');
  }
  const {to, subject, html, text, headers, tag, idempotencyKey} = message;
  if (typeof to !== 'string' || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(to) ||
      !subject || /[\r\n]/.test(subject) || !idempotencyKey || !/^[\w:/.-]{1,200}$/.test(idempotencyKey)) {
    throw new MarketingMailError('Invalid email envelope or dispatch key.', 'rejected');
  }
  let response;
  try {
    response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: {authorization: 'Bearer ' + env.HARBOR_RESEND_API_KEY, 'content-type': 'application/json',
        'idempotency-key': idempotencyKey},
      body: JSON.stringify({from, to: [to], subject, html, text, headers,
        ...(tag ? {tags: [{name: 'harbor_delivery', value: tag}]} : {})}),
    });
  } catch {
    throw new MarketingMailError('The provider did not confirm the request.', 'uncertain');
  }
  if (!response.ok) {
    const disposition = response.status === 429 ? 'retry' :
      response.status >= 500 || [408, 409].includes(response.status) ? 'uncertain' : 'rejected';
    const delay = response.status === 429 ? providerRetryDelay(response.headers.get('retry-after')) : null;
    throw new MarketingMailError('Email provider returned HTTP ' + response.status + '.', disposition, delay);
  }
  const result = await response.json().catch(() => null);
  if (!result || typeof result.id !== 'string' || !result.id || result.id.length > 200) {
    throw new MarketingMailError('The provider returned no email receipt.', 'uncertain');
  }
  return {id: result.id};
}
