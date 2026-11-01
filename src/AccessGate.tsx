import React, { useState, useEffect } from 'react';
import App from './App';
import { signIn, verifyCurrentSession } from './apiSession';

export default function AccessGate() {
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);

  useEffect(() => {
    // Check if an existing HttpOnly session cookie is already active
    verifyCurrentSession()
      .then((session) => {
        if (session.authenticated) {
          setReady(true);
        }
      })
      .finally(() => {
        setChecking(false);
      });
  }, []);

  const handlePasteKey = async () => {
    setPasteNotice(null);
    setError('');
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text && text.trim()) {
          const clean = text.trim();
          setKey(clean);
          setPasteNotice(`Pasted key (${clean.length} chars) from clipboard`);
          setTimeout(() => setPasteNotice(null), 3000);
          return;
        }
      }
    } catch (err: any) {
      console.warn('Clipboard readText restricted by browser iframe sandbox:', err);
    }
    setPasteNotice('Press Ctrl+V / Cmd+V directly in the input box to paste your key');
    setTimeout(() => setPasteNotice(null), 4000);
  };

  if (checking) {
    return (
      <main className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6">
        <div className="flex items-center gap-3 text-cyan-400 font-mono text-sm">
          <div className="w-3 h-3 rounded-full bg-cyan-400 animate-ping" />
          Verifying security session...
        </div>
      </main>
    );
  }

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
        <div className="flex items-center gap-3">
          <div className="w-3 h-3 rounded-full bg-cyan-400" />
          <h1 className="text-2xl font-bold tracking-tight">GPU Compute Arbitrage OS</h1>
        </div>
        <p className="text-sm text-slate-300">
          Enter your server access key. Owner administrative operations require OWNER_API_KEY. Session cookies are protected with HttpOnly and CSRF validation.
        </p>
        <div>
          <div className="flex items-center justify-between">
            <label htmlFor="access-key-input" className="block text-sm font-medium text-slate-200">
              Access key
            </label>
            <button
              type="button"
              onClick={handlePasteKey}
              className="text-xs text-cyan-400 hover:text-cyan-300 underline font-medium cursor-pointer"
            >
              Paste Key
            </button>
          </div>
          <input
            id="access-key-input"
            aria-label="Access key"
            type="password"
            autoComplete="off"
            required
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onPaste={(e) => {
              const pasted = e.clipboardData.getData('text');
              if (pasted) {
                setKey(pasted.trim());
                setPasteNotice(`Directly pasted ${pasted.trim().length} chars`);
                setTimeout(() => setPasteNotice(null), 3000);
              }
            }}
            className="block w-full mt-2 p-3 bg-slate-900 rounded border border-slate-700 font-mono text-sm text-slate-100 focus:border-cyan-400 outline-none transition"
            placeholder="Enter operator or owner key..."
          />
          {pasteNotice && (
            <p className="mt-1 text-xs text-amber-300 font-mono">{pasteNotice}</p>
          )}
        </div>
        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            className="w-full px-4 py-2.5 rounded bg-cyan-600 hover:bg-cyan-500 font-semibold text-sm cursor-pointer transition text-white shadow-lg shadow-cyan-950"
          >
            Authenticate Session
          </button>
        </div>
        {error && (
          <div role="alert" className="p-3 rounded bg-rose-950/60 border border-rose-800/80 text-rose-300 text-sm">
            {error}
          </div>
        )}
      </form>
    </main>
  );
}
