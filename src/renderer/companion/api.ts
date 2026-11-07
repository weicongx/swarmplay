// Calls to the Swarmplay server on the PC. The cookie set at pairing goes along
// by itself; every POST also carries X-Swarmplay, which the server requires.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message)
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: method === 'POST' ? { 'Content-Type': 'application/json', 'X-Swarmplay': '1' } : undefined,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined
    })
  } catch {
    throw new ApiError(0, "Can't reach your PC. Is Swarmplay running, and is this phone on the same network or Tailscale?")
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `The PC answered ${res.status}.`, data.code)
  return data as T
}

export const get = <T>(path: string): Promise<T> => call<T>('GET', path)
export const post = <T>(path: string, body?: unknown): Promise<T> => call<T>('POST', path, body)

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// localStorage can throw (private browsing, storage turned off); it only holds conveniences.
export function remember(key: string, value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // not kept, that's all
  }
}

export function recall(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
