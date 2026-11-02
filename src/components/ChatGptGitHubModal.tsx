import React, { useState, useEffect } from 'react';
import {
  X,
  Bot,
  GitBranch,
  Copy,
  Check,
  RefreshCw,
  ExternalLink,
  Code2,
  FileText,
  ShieldCheck,
  Cpu,
  Layers,
  Sparkles,
  Send,
  Terminal,
} from 'lucide-react';

interface ChatGptModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface RepoStatus {
  github: {
    targetRepo: string;
    branch: string;
    htmlUrl: string;
    isPublic: boolean;
    tokenConfigured: boolean;
    latestCommit?: {
      sha: string;
      message: string;
      author: string;
      date: string;
    };
    stargazersCount: number;
    openIssuesCount: number;
  };
  chatGptIntegration: {
    status: string;
    openapiSchemaUrl: string;
    actionAuthentication: string;
    capabilities: string[];
  };
}

export const ChatGptGitHubModal: React.FC<ChatGptModalProps> = ({ isOpen, onClose }) => {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [commits, setCommits] = useState<any[]>([]);
  const [tree, setTree] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>('server.ts');
  const [fileContent, setFileContent] = useState<string>('');
  const [fileLoading, setFileLoading] = useState(false);
  const [copiedSchema, setCopiedSchema] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [activeTab, setActiveTab] = useState<'setup' | 'commits' | 'explorer' | 'tester'>('setup');

  // AI prompt tester state
  const [prompt, setPrompt] = useState('Audit server.ts and Dockerfile for Render cloud deployment readiness.');
  const [aiOutput, setAiOutput] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadData();
    }
  }, [isOpen]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [statusRes, commitsRes, treeRes] = await Promise.all([
        fetch('/api/chatgpt/status'),
        fetch('/api/chatgpt/commits?limit=8'),
        fetch('/api/chatgpt/tree'),
      ]);
      if (statusRes.ok) {
        setStatus(await statusRes.json());
      }
      if (commitsRes.ok) {
        const c = await commitsRes.json();
        setCommits(c.commits || []);
      }
      if (treeRes.ok) {
        const t = await treeRes.json();
        setTree(t.files || []);
      }
    } catch (e) {
      console.error('Failed to load ChatGPT-GitHub bridge data:', e);
    } finally {
      setLoading(false);
    }
  };

  const loadFile = async (path: string) => {
    setSelectedFile(path);
    setFileLoading(true);
    try {
      const res = await fetch(`/api/chatgpt/file?path=${encodeURIComponent(path)}`);
      if (res.ok) {
        const data = await res.json();
        setFileContent(data.content || '');
      } else {
        setFileContent('Error loading file content.');
      }
    } catch {
      setFileContent('Error loading file content.');
    } finally {
      setFileLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'explorer' && !fileContent) {
      loadFile(selectedFile);
    }
  }, [activeTab]);

  const copyOpenApiUrl = () => {
    const url = `${window.location.origin}/api/chatgpt/openapi.json`;
    navigator.clipboard.writeText(url);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2500);
  };

  const copyFullSchema = async () => {
    try {
      const res = await fetch('/api/chatgpt/openapi.json');
      const data = await res.json();
      navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopiedSchema(true);
      setTimeout(() => setCopiedSchema(false), 2500);
    } catch {
      // Fallback
    }
  };

  const runAiPrompt = async () => {
    if (!prompt.trim() || aiLoading) return;
    setAiLoading(true);
    setAiOutput(null);
    try {
      const res = await fetch('/api/chatgpt/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      setAiOutput(data.response || data.error || 'No response returned.');
    } catch (e: any) {
      setAiOutput(`Request error: ${e.message}`);
    } finally {
      setAiLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[#0b101b] border border-cyan-500/40 rounded-xl w-full max-w-5xl h-[88vh] flex flex-col shadow-2xl overflow-hidden font-sans">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-[#0d1424]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Bot className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white tracking-wide">
                  ChatGPT ↔ GitHub Autonomous Bridge
                </h2>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                  CONNECTED · MAIN
                </span>
              </div>
              <p className="text-xs text-slate-400 font-mono mt-0.5">
                {status?.github.targetRepo || 'STEYNGROVE/gpu-compute-arbitrage-os-and-connect-it-to-Render.'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={loadData}
              disabled={loading}
              className="p-2 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
              title="Refresh repository state"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-cyan-400' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-2 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center gap-1 px-6 pt-3 border-b border-slate-800/80 bg-[#0a0f1d] text-xs">
          <button
            onClick={() => setActiveTab('setup')}
            className={`px-4 py-2 font-medium border-b-2 transition-all cursor-pointer ${
              activeTab === 'setup'
                ? 'border-emerald-400 text-emerald-300 bg-emerald-500/5'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            ChatGPT Action Setup
          </button>
          <button
            onClick={() => setActiveTab('commits')}
            className={`px-4 py-2 font-medium border-b-2 transition-all cursor-pointer ${
              activeTab === 'commits'
                ? 'border-emerald-400 text-emerald-300 bg-emerald-500/5'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            GitHub Commits ({commits.length})
          </button>
          <button
            onClick={() => setActiveTab('explorer')}
            className={`px-4 py-2 font-medium border-b-2 transition-all cursor-pointer ${
              activeTab === 'explorer'
                ? 'border-emerald-400 text-emerald-300 bg-emerald-500/5'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Repository Explorer ({tree.length} files)
          </button>
          <button
            onClick={() => setActiveTab('tester')}
            className={`px-4 py-2 font-medium border-b-2 transition-all cursor-pointer ${
              activeTab === 'tester'
                ? 'border-emerald-400 text-emerald-300 bg-emerald-500/5'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            AI Query Console
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {activeTab === 'setup' && (
            <div className="space-y-6">
              {/* Quick Status Cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="p-4 rounded-lg bg-slate-900/60 border border-slate-800">
                  <div className="flex items-center gap-2 text-xs text-slate-400 mb-1">
                    <GitBranch className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Upstream GitHub Target</span>
                  </div>
                  <div className="text-sm font-bold text-white truncate font-mono">
                    {status?.github.targetRepo}
                  </div>
                  <div className="text-[11px] text-emerald-400 mt-1 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                    <span>Branch: {status?.github.branch || 'main'} (Public)</span>
                  </div>
                </div>

                <div className="p-4 rounded-lg bg-slate-900/60 border border-slate-800">
                  <div className="flex items-center gap-2 text-xs text-slate-400 mb-1">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Latest Remote Commit</span>
                  </div>
                  <div className="text-sm font-bold text-cyan-300 font-mono">
                    SHA: {status?.github.latestCommit?.sha || '6c9e4c9'}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1 truncate">
                    {status?.github.latestCommit?.message || 'feat: complete production release'}
                  </div>
                </div>

                <div className="p-4 rounded-lg bg-slate-900/60 border border-slate-800">
                  <div className="flex items-center gap-2 text-xs text-slate-400 mb-1">
                    <Bot className="w-3.5 h-3.5 text-purple-400" />
                    <span>ChatGPT OpenAPI 3.1.0</span>
                  </div>
                  <div className="text-sm font-bold text-emerald-300">
                    Ready for Custom GPT
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1">
                    Public Auth (None required)
                  </div>
                </div>
              </div>

              {/* Step by step guide */}
              <div className="p-5 rounded-lg bg-slate-900/40 border border-slate-800 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-white">
                      Connect ChatGPT to this Repository via Custom GPT Action
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Follow these 4 steps to let ChatGPT directly query, read, and audit this project:
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={copyOpenApiUrl}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-cyan-200 bg-cyan-950/70 hover:bg-cyan-900 border border-cyan-600/70 rounded-md transition-all cursor-pointer"
                    >
                      {copiedUrl ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedUrl ? 'URL Copied!' : 'Copy Schema URL'}</span>
                    </button>
                    <button
                      onClick={copyFullSchema}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-200 bg-emerald-950/70 hover:bg-emerald-900 border border-emerald-600/70 rounded-md transition-all cursor-pointer"
                    >
                      {copiedSchema ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Code2 className="w-3.5 h-3.5" />}
                      <span>{copiedSchema ? 'Schema Copied!' : 'Copy OpenAPI JSON'}</span>
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                  <div className="p-4 rounded-md bg-slate-950/70 border border-slate-800/80 space-y-2">
                    <div className="flex items-center gap-2 text-xs font-bold text-cyan-400">
                      <span className="w-5 h-5 rounded-full bg-cyan-950 border border-cyan-500/50 flex items-center justify-center text-[11px]">1</span>
                      <span>Create or Edit Custom GPT</span>
                    </div>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      In ChatGPT (chatgpt.com), click your profile → <strong>Explore GPTs</strong> → <strong>Create a GPT</strong>. Give it a name like <em className="text-slate-300">GPU Arbitrage Architect</em>.
                    </p>
                  </div>

                  <div className="p-4 rounded-md bg-slate-950/70 border border-slate-800/80 space-y-2">
                    <div className="flex items-center gap-2 text-xs font-bold text-cyan-400">
                      <span className="w-5 h-5 rounded-full bg-cyan-950 border border-cyan-500/50 flex items-center justify-center text-[11px]">2</span>
                      <span>Add New Action</span>
                    </div>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      Go to the <strong>Configure</strong> tab, scroll down to <strong>Actions</strong>, and click <strong>Create new action</strong>.
                    </p>
                  </div>

                  <div className="p-4 rounded-md bg-slate-950/70 border border-slate-800/80 space-y-2">
                    <div className="flex items-center gap-2 text-xs font-bold text-cyan-400">
                      <span className="w-5 h-5 rounded-full bg-cyan-950 border border-cyan-500/50 flex items-center justify-center text-[11px]">3</span>
                      <span>Import OpenAPI Schema</span>
                    </div>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      Click <strong>Import from URL</strong> and paste:
                      <code className="block mt-1 p-1 bg-black/60 rounded text-[11px] text-cyan-300 font-mono select-all">
                        {window.location.origin}/api/chatgpt/openapi.json
                      </code>
                      Or click <strong>Copy OpenAPI JSON</strong> above and paste it directly into the schema box.
                    </p>
                  </div>

                  <div className="p-4 rounded-md bg-slate-950/70 border border-slate-800/80 space-y-2">
                    <div className="flex items-center gap-2 text-xs font-bold text-cyan-400">
                      <span className="w-5 h-5 rounded-full bg-cyan-950 border border-cyan-500/50 flex items-center justify-center text-[11px]">4</span>
                      <span>Set Authentication & Publish</span>
                    </div>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      Authentication can remain set to <strong>None</strong> since the repository and endpoints are publicly queryable. Save and test your custom GPT!
                    </p>
                  </div>
                </div>

                <div className="p-3 bg-emerald-950/20 border border-emerald-800/40 rounded text-xs text-emerald-300 flex items-start gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <div>
                    <strong>Direct GitHub Browsing also supported:</strong> Because the GitHub repository is public, you can also paste the URL <a href={`https://github.com/${status?.github.targetRepo}`} target="_blank" rel="noreferrer" className="underline font-mono text-cyan-300 inline-flex items-center gap-0.5">https://github.com/{status?.github.targetRepo} <ExternalLink className="w-3 h-3" /></a> directly into standard ChatGPT chat.
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'commits' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <GitBranch className="w-4 h-4 text-cyan-400" />
                  <span>Recent GitHub Commits (branch: main)</span>
                </h3>
                <a
                  href={`https://github.com/${status?.github.targetRepo}/commits/main`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-1"
                >
                  View on GitHub <ExternalLink className="w-3 h-3" />
                </a>
              </div>

              <div className="divide-y divide-slate-800/80 rounded-lg border border-slate-800 bg-slate-900/40 overflow-hidden font-mono text-xs">
                {commits.map((c, idx) => (
                  <div key={idx} className="p-3 hover:bg-slate-800/50 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="px-2 py-0.5 rounded bg-cyan-950 border border-cyan-800 text-cyan-300 font-bold shrink-0">
                        {c.sha}
                      </span>
                      <span className="text-slate-200 truncate">{c.message}</span>
                    </div>
                    <div className="flex items-center gap-4 text-slate-400 shrink-0 text-[11px]">
                      <span>{c.author}</span>
                      <span>{c.date ? new Date(c.date).toLocaleDateString() : ''}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'explorer' && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 h-[55vh]">
              {/* File list */}
              <div className="border border-slate-800 rounded-lg bg-slate-900/40 p-2 overflow-y-auto space-y-1 font-mono text-xs">
                {tree.map((filePath, i) => (
                  <button
                    key={i}
                    onClick={() => loadFile(filePath)}
                    className={`w-full text-left px-2 py-1.5 rounded truncate transition-colors flex items-center gap-2 cursor-pointer ${
                      selectedFile === filePath
                        ? 'bg-cyan-950 text-cyan-300 border border-cyan-800 font-semibold'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                    }`}
                  >
                    <FileText className="w-3.5 h-3.5 shrink-0 opacity-70" />
                    <span className="truncate">{filePath}</span>
                  </button>
                ))}
              </div>

              {/* File viewer */}
              <div className="md:col-span-2 border border-slate-800 rounded-lg bg-slate-950/80 p-4 flex flex-col h-full font-mono text-xs">
                <div className="flex items-center justify-between pb-2 border-b border-slate-800 text-slate-400">
                  <span className="text-cyan-300 font-bold">{selectedFile}</span>
                  <span>{fileLoading ? 'Loading...' : `${fileContent.split('\n').length} lines`}</span>
                </div>
                <div className="flex-1 overflow-auto pt-3 text-slate-300 select-text">
                  <pre className="whitespace-pre">{fileContent}</pre>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'tester' && (
            <div className="space-y-4">
              <div className="p-4 rounded-lg bg-slate-900/40 border border-slate-800 space-y-3">
                <label className="block text-xs font-bold text-white">
                  Test Query / Code Inspection Prompt
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="Enter prompt for ChatGPT / AI Auditor..."
                    className="flex-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded-md text-xs text-white focus:outline-none focus:border-cyan-500 font-mono"
                  />
                  <button
                    onClick={runAiPrompt}
                    disabled={aiLoading}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-md transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {aiLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                    <span>{aiLoading ? 'Analyzing...' : 'Run Query'}</span>
                  </button>
                </div>
              </div>

              {aiOutput && (
                <div className="p-4 rounded-lg bg-slate-950 border border-slate-800 font-mono text-xs text-slate-200 whitespace-pre-wrap leading-relaxed max-h-[40vh] overflow-y-auto">
                  {aiOutput}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
