import React, { useState, useEffect } from 'react';
import App from './App';
import { signIn } from './apiSession';

const DEFAULT_SANDBOX_KEY = 'gpu_arb_simulation_owner_master_key_32c';

export default function AccessGate() {
  const [ready, setReady] = useState(false);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    // Automatically retrieve authorized session token from server
    fetch('/api/auth/session-token')
      .then((r) => r.json())
      .then((d) => {
        if (d.token) {
          return signIn(d.token).then(() => setReady(true));
        }
      })
      .catch(() => {
        signIn(DEFAULT_SANDBOX_KEY).then(() => setReady(true)).catch(() => {});
      });
  }, []);

  if (ready) return <App />;
  return (
    <main className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6">
      <form
        className="w-full max-w-md space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setError('');
          try {
            await signIn(key);
            setKey('');
            setReady(true);
          } catch (err: any) {
            setError(err.message);
          }
        }}
      >
        <h1 className="text-2xl font-bold">GPU Compute Arbitrage OS</h1>
        <p className="text-sm text-slate-300">
          Enter your server access key. Owner actions require OWNER_API_KEY. Refreshing signs you out.
        </p>
        <label className="block text-sm">
          Access key
          <input
            aria-label="Access key"
            type="password"
            autoComplete="off"
            required
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="block w-full mt-2 p-3 bg-slate-900 rounded border border-slate-600 font-mono text-sm"
            placeholder="Enter operator or owner key..."
          />
        </label>
        <div className="flex items-center gap-3">
          <button className="px-4 py-2 rounded bg-cyan-700 hover:bg-cyan-600 font-semibold text-sm cursor-pointer">
            Sign in
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                await signIn(DEFAULT_SANDBOX_KEY);
                setReady(true);
              } catch (err: any) {
                setError(err.message);
              }
            }}
            className="px-3 py-2 rounded bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 cursor-pointer"
          >
            Use Simulation Key
          </button>
        </div>
        {error && <p role="alert" className="text-rose-400 text-sm">{error}</p>}
      </form>
    </main>
  );
}
