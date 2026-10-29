let token = '';

export function getAuthToken(): string {
  return token;
}

export function setAuthToken(val: string): void {
  token = val.trim();
}

const nativeFetch = typeof window !== 'undefined' && window.fetch ? window.fetch.bind(window) : fetch;

export async function signIn(value: string) {
  const clean = value.trim();
  const response = await nativeFetch('/api/session', { headers: { Authorization: `Bearer ${clean}` } });
  if (!response.ok) throw new Error('Access key was rejected. Use a configured server API or owner key.');
  token = clean;
}

export const authenticatedFetch: typeof fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  try {
    const reqUrl = typeof input === 'string'
      ? input
      : input instanceof URL
      ? input.toString()
      : input instanceof Request
      ? input.url
      : String(input);

    const isApi = reqUrl.startsWith('/api/') || (typeof location !== 'undefined' && reqUrl.startsWith(location.origin + '/api/'));

    if (token && isApi) {
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      return nativeFetch(input, { ...init, headers });
    }
  } catch {}
  return nativeFetch(input, init);
};

// Safely wrap window.fetch if writable; never crash if it has only a getter
if (typeof window !== 'undefined') {
  try {
    Object.defineProperty(window, 'fetch', {
      value: authenticatedFetch,
      writable: true,
      configurable: true,
    });
  } catch {
    try {
      (window as any).fetch = authenticatedFetch;
    } catch {
      // Safe fallback when window.fetch is non-configurable in host iframe
    }
  }
}
