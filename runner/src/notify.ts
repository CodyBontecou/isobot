/** Posts runner status to an optional Discord channel webhook. Issue comments carry the detail. */
export class Notifier {
  constructor(private webhookUrl?: string, private fetcher: typeof fetch = fetch) {}

  async discord(content: string): Promise<void> {
    if (!this.webhookUrl) return;
    try {
      const response = await this.fetcher(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Never ping anyone from automated output.
        body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] }, username: "isobot runner" }),
        signal: AbortSignal.timeout(15_000),
      });
      await response.body?.cancel();
      if (!response.ok) console.warn(`[notify] Discord webhook returned HTTP ${response.status}`);
    } catch (error) {
      console.warn("[notify] Discord webhook failed:", (error as Error).message);
    }
  }
}
