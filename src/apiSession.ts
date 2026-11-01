/**
 * GPU Compute Arbitrage OS - Hardened Session & API Transport Client
 * 
 * Enforces:
 * 1. Zero persistent secret storage in localStorage (ephemeral in-memory only)
 * 2. Automatic HttpOnly SameSite session cookie transport
 * 3. Automatic CSRF token header injection on state-changing requests (POST/PUT/DELETE/PATCH)
 * 4. Graceful session lifecycle handling (login, logout, session verification)
 */

let inMemoryToken: string = '';
let inMemoryCsrfToken: string = '';
let inMemoryRole: 'owner' | 'operator' | 'anonymous' = 'anonymous';

export function getAuthToken(): string {
  return inMemoryToken;
}

export function setAuthToken(val: string): void {
  inMemoryToken = (val || '').trim();
}

export function getCsrfToken(): string {
  return inMemoryCsrfToken;
}

export function setCsrfToken(val: string): void {
  inMemoryCsrfToken = (val || '').trim();
}

export function getSessionRole(): string {
  return inMemoryRole;
}

const nativeFetch = typeof window !== 'undefined' && window.fetch ? window.fetch.bind(window) : fetch;

/**
 * Checks if the browser already holds a valid active session via HttpOnly cookie
 */
export async function verifyCurrentSession(): Promise<{ authenticated: boolean; role?: string; csrfToken?: string }> {
  try {
    const res = await nativeFetch('/api/session', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.authenticated) {
        inMemoryRole = data.role || 'operator';
        if (data.csrfToken) {
          inMemoryCsrfToken = data.csrfToken;
        }
        return { authenticated: true, role: data.role, csrfToken: data.csrfToken };
      }
    }
  } catch {
    // Network or offline error
  }
  return { authenticated: false };
}

/**
 * Authenticates against the server login endpoint, establishing an HttpOnly session cookie
 */
export async function signIn(key: string): Promise<{ success: boolean; role: string; csrfToken: string }> {
  const clean = (key || '').trim();
  if (!clean) {
    throw new Error('Access key is required.');
  }

  const response = await nativeFetch('/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ key: clean }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `Authentication failed (HTTP ${response.status})`);
  }

  inMemoryToken = clean; // Kept in memory only for legacy bridge requests
  inMemoryRole = data.role || (data.isOwner ? 'owner' : 'operator');
  if (data.csrfToken) {
    inMemoryCsrfToken = data.csrfToken;
  }

  return {
    success: true,
    role: inMemoryRole,
    csrfToken: inMemoryCsrfToken,
  };
}

/**
 * Logs out, revoking the session on the server and clearing client credentials
 */
export async function signOut(): Promise<void> {
  try {
    await nativeFetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(inMemoryCsrfToken ? { 'x-csrf-token': inMemoryCsrfToken } : {}),
      },
    });
  } catch {}
  inMemoryToken = '';
  inMemoryCsrfToken = '';
  inMemoryRole = 'anonymous';
}

/**
 * Authenticated Fetch wrapper:
 * Injects session credentials, CSRF tokens, and authorization headers without persisting secrets to disk.
 */
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

    if (isApi) {
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

      // Transmit CSRF token for state-changing requests
      if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method) && inMemoryCsrfToken && !headers.has('x-csrf-token')) {
        headers.set('x-csrf-token', inMemoryCsrfToken);
      }

      // Transmit authorization bearer header if available in memory
      if (inMemoryToken) {
        if (!headers.has('Authorization')) {
          headers.set('Authorization', `Bearer ${inMemoryToken}`);
        }
        if (!headers.has('x-bridge-token')) {
          headers.set('x-bridge-token', inMemoryToken);
        }
        if (!headers.has('x-arbitrage-auth')) {
          headers.set('x-arbitrage-auth', inMemoryToken);
        }
      }

      return nativeFetch(input, {
        ...init,
        credentials: init?.credentials || 'same-origin',
        headers,
      });
    }
  } catch {}
  return nativeFetch(input, init);
};

// Safely wrap window.fetch if configurable in current environment
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
    } catch {}
  }
}
