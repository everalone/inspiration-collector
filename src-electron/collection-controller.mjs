/** Capture clipboard changes independently of the much slower article analysis. */
export function createClipboardCollector({ submit, onQueued = () => {}, onError = () => {} }) {
  let lastText = "";
  let running = null;
  const pending = new Map();
  async function drain() {
    for (const [url, entry] of pending) {
      try {
        await submit(url);
        pending.delete(url);
        onQueued(url);
      } catch (error) {
        if (!entry.reported) { entry.reported = true; onError(error); }
        break; // The next clipboard tick retries transport without losing captured URLs.
      }
    }
  }
  const flush = () => {
    if (!running) running = drain().finally(() => { running = null; });
    return running;
  };
  const accept = (value, enabled = true) => {
    const text = String(value ?? "").trim();
    if (text !== lastText) {
      lastText = text;
      const url = text.match(/https:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]+/)?.[0];
      if (enabled && url && !pending.has(url)) pending.set(url, { reported: false });
    }
    return flush();
  };
  return { accept, flush, pendingCount: () => pending.size };
}
