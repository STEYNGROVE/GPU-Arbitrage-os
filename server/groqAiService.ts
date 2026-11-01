/**
 * @file server/groqAiService.ts
 * Primary AI Engine: Groq Ultra-Low Latency LPU Inference Engine
 * 
 * Strict Guarantees:
 * 1. Server-side credential isolation (never exposed to client).
 * 2. Token, latency, and cost tracking with audit trail.
 * 3. Request timeouts, model compatibility fallbacks, and rate-limit handling.
 * 4. Fail-closed financial boundary: AI recommendations CANNOT automatically
 *    authorize disbursements, withdrawals, or binding purchases.
 */

import Groq from 'groq-sdk';
import { config } from './config.ts';

export interface GroqAiStatus {
  provider: 'GROQ_LPU_INFERENCE';
  isPrimary: boolean;
  status: 'CONNECTED_LIVE' | 'STANDBY_SIMULATION' | 'OFFLINE' | 'CONFIGURED_UNVERIFIED';
  model: string;
  baseUrl: string;
  enabled: boolean;
  hasLiveKey: boolean;
  keyMasked: string;
  verifiedAt: string | null;
  inferenceArchitecture: string;
  averageSpeedTokensPerSec: number;
  averageLatencyMs: number;
  capabilities: string[];
  metrics: {
    totalTokensUsed: number;
    promptTokensTotal: number;
    completionTokensTotal: number;
    estimatedCostUsd: number;
  };
  safetyDisclaimer: string;
}

export interface GroqDecisionAuditEntry {
  id: string;
  timestamp: string;
  action: 'COPILOT_QUERY' | 'SPREAD_ANALYSIS_REQUEST' | 'FLEET_INSIGHTS_REQUEST' | 'PING_VERIFICATION';
  model: string;
  tokensProcessed: number;
  outcome: 'COMPLETED' | 'BLOCKED' | 'ERROR';
  safetyEnforced: string;
}

export interface SpreadAnalysisResult {
  opportunityId: string;
  recommendation: 'EXECUTE_IMMEDIATELY' | 'EXECUTE_WITH_HEDGE' | 'HOLD_FOR_BETTER_FILL' | 'REJECT_HIGH_PREEMPTION';
  confidenceScore: number;
  executiveSummary: string;
  strategicRationale: string;
  riskAssessment: {
    preemptionRisk: string;
    spreadDurabilityHours: number;
    providerSlaRisk: string;
    liquidityRisk: string;
  };
  hedgingRecommendation: {
    recommendedToken: string;
    hedgeRatio: number;
    action: string;
  };
  netYieldProjectionUsdPerHour: number;
  lpuInferenceTimeMs: number;
  modelUsed: string;
  tokensProcessed: number;
  generatedAt: string;
}

export interface FleetOptimizationInsights {
  fleetHealth: 'OPTIMAL' | 'REBALANCE_RECOMMENDED' | 'UNDER_UTILIZED';
  summary: string;
  discoveryRecommendation: string;
  optimizerRecommendation: string;
  suggestedProviderPriority: Array<{ provider: string; weightPct: number; reason: string }>;
  expectedYieldIncreasePct: number;
  lpuInferenceTimeMs: number;
  modelUsed: string;
}

class GroqAiService {
  private groqClient: Groq | null = null;
  private key = '';
  private verifiedAt: string | null = null;
  private latencyMs = 0;
  private tokensPerSecond = 0;
  private primaryModel = process.env.GROQ_MODEL || process.env.GROQ_PRIMARY_MODEL || config.groq.primaryModel || 'llama-3.3-70b-versatile';
  private baseUrl = process.env.GROQ_API_BASE_URL || config.groq.baseUrl || 'https://api.groq.com/openai/v1';
  private isEnabled = process.env.GROQ_ENABLED !== 'false' && config.groq.enabled !== false;

  // Token and cost tracking
  private promptTokensTotal = 0;
  private completionTokensTotal = 0;
  private totalTokensUsed = 0;
  private estimatedCostUsd = 0;

  // AI decision audit trail
  private decisionAuditTrail: GroqDecisionAuditEntry[] = [];
  private maxAuditEntries = 100;

  constructor() {
    this.initClient();
  }

  public initClient(apiKeyOverride?: string) {
    const rawKey = apiKeyOverride || process.env.GROQ_API_KEY || '';
    this.key = (rawKey && rawKey !== 'YOUR_GROQ_API_KEY_HERE' && rawKey !== 'MY_GROQ_API_KEY') ? rawKey : '';
    this.primaryModel = process.env.GROQ_MODEL || process.env.GROQ_PRIMARY_MODEL || config.groq.primaryModel || 'llama-3.3-70b-versatile';
    this.baseUrl = process.env.GROQ_API_BASE_URL || config.groq.baseUrl || 'https://api.groq.com/openai/v1';
    this.isEnabled = process.env.GROQ_ENABLED !== 'false' && config.groq.enabled !== false;
    this.verifiedAt = null;

    const cleanBaseUrl = this.baseUrl
      ? this.baseUrl.replace(/\/openai\/v1\/?$/, '').replace(/\/+$/, '')
      : undefined;

    this.groqClient = (this.key.startsWith('gsk_') && this.isEnabled)
      ? new Groq({ apiKey: this.key, baseURL: cleanBaseUrl, timeout: 15000, maxRetries: 1 })
      : null;
  }

  public setPrimaryModel(model: string) {
    if (!model || model.length > 128) throw new Error('A valid Groq model identifier is required.');
    this.primaryModel = model;
    this.verifiedAt = null;
  }

  private recordAudit(action: GroqDecisionAuditEntry['action'], tokens: number, outcome: GroqDecisionAuditEntry['outcome'], safety: string) {
    this.decisionAuditTrail.unshift({
      id: `AI-AUDIT-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      timestamp: new Date().toISOString(),
      action,
      model: this.primaryModel,
      tokensProcessed: tokens,
      outcome,
      safetyEnforced: safety,
    });
    if (this.decisionAuditTrail.length > this.maxAuditEntries) {
      this.decisionAuditTrail.pop();
    }
  }

  public getDecisionAuditTrail(): GroqDecisionAuditEntry[] {
    return [...this.decisionAuditTrail];
  }

  public getStatus(): GroqAiStatus {
    return {
      provider: 'GROQ_LPU_INFERENCE',
      isPrimary: true,
      status: (!this.groqClient || !this.isEnabled)
        ? 'OFFLINE'
        : this.verifiedAt && Date.now() - Date.parse(this.verifiedAt) < 300000
        ? 'CONNECTED_LIVE'
        : 'CONFIGURED_UNVERIFIED',
      model: this.primaryModel,
      baseUrl: this.baseUrl,
      enabled: this.isEnabled,
      hasLiveKey: Boolean(this.groqClient),
      keyMasked: this.key ? 'CONFIGURED' : 'NOT_CONFIGURED',
      verifiedAt: this.verifiedAt,
      inferenceArchitecture: 'Groq LPU Inference Engine',
      averageSpeedTokensPerSec: this.tokensPerSecond,
      averageLatencyMs: this.latencyMs,
      capabilities: [
        'Advisory analysis only; AI output is not execution or payment evidence',
        'Fail-closed spending boundary enforced: recommendations cannot authorize disbursements',
      ],
      metrics: {
        totalTokensUsed: this.totalTokensUsed,
        promptTokensTotal: this.promptTokensTotal,
        completionTokensTotal: this.completionTokensTotal,
        estimatedCostUsd: Number(this.estimatedCostUsd.toFixed(6)),
      },
      safetyDisclaimer: 'AI recommendations are advisory and fail-closed: AI outputs cannot authorize financial commitments or fund releases.',
    };
  }

  private async request(messages: any[], json = false) {
    if (!this.groqClient || !this.isEnabled) {
      this.recordAudit('COPILOT_QUERY', 0, 'BLOCKED', 'No server-side GROQ_API_KEY configured');
      throw new Error('Groq is not configured. Set GROQ_API_KEY on the server.');
    }

    const started = performance.now();
    try {
      let response: any;
      try {
        response = await this.groqClient.chat.completions.create({
          model: this.primaryModel,
          messages,
          temperature: 0.1,
          max_tokens: 1024,
          ...(json ? { response_format: { type: 'json_object' as const } } : {}),
        });
      } catch (err: any) {
        if (err?.status === 404 || err?.message?.includes('model_not_found') || err?.message?.includes('does not exist')) {
          const fallbackModel = 'llama-3.3-70b-versatile';
          console.warn(`[Groq AI] Model ${this.primaryModel} unavailable on key, falling back to ${fallbackModel}`);
          response = await this.groqClient.chat.completions.create({
            model: fallbackModel,
            messages,
            temperature: 0.1,
            max_tokens: 1024,
            ...(json ? { response_format: { type: 'json_object' as const } } : {}),
          });
          this.primaryModel = fallbackModel;
        } else {
          throw err;
        }
      }

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error('Groq returned an empty response.');

      this.latencyMs = Math.round(performance.now() - started);
      const completionTokens = response.usage?.completion_tokens || 0;
      const promptTokens = response.usage?.prompt_tokens || 0;
      const totalTokens = response.usage?.total_tokens || (promptTokens + completionTokens);

      this.promptTokensTotal += promptTokens;
      this.completionTokensTotal += completionTokens;
      this.totalTokensUsed += totalTokens;
      // Groq standard reference cost ~$0.00059 per 1k prompt tokens, ~$0.00079 per 1k completion tokens
      this.estimatedCostUsd += (promptTokens * 0.00000059) + (completionTokens * 0.00000079);

      this.tokensPerSecond = Math.round(completionTokens / Math.max(0.01, this.latencyMs / 1000));
      this.verifiedAt = new Date().toISOString();

      this.recordAudit('COPILOT_QUERY', totalTokens, 'COMPLETED', 'Read-only advisory response issued; no payment authorization');
      return { content, tokens: totalTokens };
    } catch (err) {
      this.verifiedAt = null;
      this.recordAudit('COPILOT_QUERY', 0, 'ERROR', 'Request failed: ' + (err as any)?.message);
      throw err;
    }
  }

  public async verifyConnection() {
    await this.request([{ role: 'user', content: 'Reply OK.' }]);
    return this.getStatus();
  }

  public async queryCopilot(messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>) {
    if (!Array.isArray(messages) || messages.length > 40 || messages.some(m => !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 12000)) {
      throw new Error('Invalid chat messages.');
    }
    const result = await this.request([
      {
        role: 'system',
        content: 'You are an advisory computing assistant. You have no direct access to account balances, jobs or payments. Do not invent facts, customers or execution results. Distinguish estimates from evidence. Fail-closed: do not authorize expenditures.',
      },
      ...messages,
    ]);
    return {
      reply: result.content,
      model: this.primaryModel,
      latencyMs: this.latencyMs,
      tokensPerSecond: this.tokensPerSecond,
    };
  }

  public async analyzeSpread(_opportunity: any): Promise<SpreadAnalysisResult> {
    this.recordAudit('SPREAD_ANALYSIS_REQUEST', 0, 'BLOCKED', 'Fail-closed: requires verified provider quote and customer order adapters');
    throw new Error('Spread execution analysis blocked: verified provider quote and customer order adapters are required. Use the copilot for advisory questions.');
  }

  public async getFleetInsights(_params: any): Promise<FleetOptimizationInsights> {
    this.recordAudit('FLEET_INSIGHTS_REQUEST', 0, 'BLOCKED', 'Fail-closed: verified worker telemetry adapter required');
    throw new Error('Fleet insights unavailable: there is no verified worker telemetry adapter.');
  }
}

export const groqAiService = new GroqAiService();
