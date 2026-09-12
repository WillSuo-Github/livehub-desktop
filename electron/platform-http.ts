const defaultHeaders = {
  Accept: "application/json, text/plain, */*",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
};

async function request(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        headers: { ...defaultHeaders, ...headers },
        signal: controller.signal,
      });

      if (response.status >= 500 && attempt < 4) {
        await response.text();
        await wait(500 * (attempt + 1));
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;
      if (attempt < 4) {
        await wait(500 * (attempt + 1));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export async function fetchJson<T>(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 20_000,
): Promise<T> {
  const response = await request(url, headers, timeoutMs);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`Invalid JSON from ${new URL(url).hostname}`);
  }
}

export async function fetchText(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 20_000,
): Promise<string> {
  const response = await request(url, headers, timeoutMs);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }

  return await response.text();
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  const run = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }

      results[index] = await worker(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => run()));
  return results;
}

export function toNumber(value: unknown): number {
  const normalized = typeof value === "string" ? value.replace(/,/g, "") : value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function cleanText(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const text = value.replace(/\s+/g, " ").trim();
  return text || fallback;
}
