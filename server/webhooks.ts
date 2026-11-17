// CasiWorks Pro - Webhooks: tell other programs when something happens in the library
//
// Each webhook gets a JSON POST:
//   { "event": "document.saved", "deliveredAt": "…", "data": { … } }
// with headers
//   X-CasiWorks-Event:     the event name
//   X-CasiWorks-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed by the webhook's secret>
// A network error, timeout or 5xx answer is retried twice (after 0.5 s and 2 s).
// Every attempt is recorded and listed under the webhook's deliveries.
import { createHmac, randomUUID } from 'node:crypto';
import type { Library, WebhookEvent } from './library.ts';

export const RETRY_DELAYS_MS = [500, 2000];
const TIMEOUT_MS = 5000;

/** The signature header value for a body (what a receiver recomputes to check it). */
export function signature(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export class Webhooks {
  private lib: Library;
  private pending = new Set<Promise<void>>();
  private retryDelays: number[];

  constructor(lib: Library, retryDelays = RETRY_DELAYS_MS) {
    this.lib = lib;
    this.retryDelays = retryDelays;
  }

  /** Send an event to every active webhook that wants it (in the background). */
  emit(event: WebhookEvent, data: Record<string, unknown>): void {
    for (const hook of this.lib.listWebhooks()) {
      if (!hook.active || !hook.events.includes(event)) continue;
      const p = this.deliver(hook.id, hook.url, event, data).finally(() => this.pending.delete(p));
      this.pending.add(p);
    }
  }

  /** Settles when every delivery under way has finished (tests and shutdown). */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private async deliver(id: string, url: string, event: WebhookEvent, data: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify({ event, deliveryId: randomUUID(), deliveredAt: new Date().toISOString(), data });
    const headers = {
      'content-type': 'application/json',
      'user-agent': 'CasiWorks-Webhooks/1',
      'x-casiworks-event': event,
      'x-casiworks-signature': signature(this.lib.webhookSecret(id), body),
    };
    for (let attempt = 0; ; attempt++) {
      let status: number | null = null, error: string | null = null;
      try {
        const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
        status = res.status;
        await res.body?.cancel();
        if (status >= 500) error = `HTTP ${status}`;
      } catch (err) {
        error = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
      }
      try { this.lib.recordDelivery(id, event, status, error); } catch { return; } // the webhook was deleted meanwhile
      if (!error || attempt >= this.retryDelays.length) return;
      await new Promise(r => setTimeout(r, this.retryDelays[attempt]));
    }
  }
}
