import { config } from './config.ts';
import { systemMemoryService } from './systemMemoryService.ts';

export interface RenderDeployHookStatus {
  configured: boolean;
  maskedUrl: string;
  lastTriggeredAt: string | null;
  lastStatus: string | null;
  instructions: {
    step1: string;
    step2: string;
    step3: string;
    step4: string;
    docsUrl: string;
  };
}

export interface TriggerDeployResult {
  success: boolean;
  statusCode?: number;
  message: string;
  details?: any;
  error?: string;
  triggeredAt: string;
}

export class RenderDeployService {
  private hookUrl: string = '';
  private lastTriggeredAt: string | null = null;
  private lastStatus: string | null = null;

  constructor() {
    if (config.renderDeployHookUrl) {
      this.hookUrl = config.renderDeployHookUrl.trim();
    }
  }

  public getHookUrl(): string {
    return this.hookUrl;
  }

  public setHookUrl(url: string): { success: boolean; error?: string } {
    const trimmed = (url || '').trim();
    if (!trimmed) {
      this.hookUrl = '';
      systemMemoryService.updateState({}, 'Render Deploy Hook cleared');
      return { success: true };
    }

    // Basic URL validation
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return { success: false, error: 'Deploy Hook must use HTTPS protocol.' };
      }
      if (!parsed.hostname.includes('render.com')) {
        // Warning but allow if custom proxy
        console.warn('[Render Deploy Hook] Notice: URL hostname is not render.com:', parsed.hostname);
      }
      this.hookUrl = trimmed;
      systemMemoryService.updateState({}, `Render Deploy Hook URL updated (${this.getMaskedUrl()})`);
      return { success: true };
    } catch {
      return { success: false, error: 'Invalid Deploy Hook URL format.' };
    }
  }

  public getMaskedUrl(): string {
    if (!this.hookUrl) return '';
    try {
      const parsed = new URL(this.hookUrl);
      const pathParts = parsed.pathname.split('/');
      const lastPart = pathParts[pathParts.length - 1] || '';
      const maskedPath = lastPart.length > 8 
        ? `${lastPart.substring(0, 7)}••••••••` 
        : '••••••••';
      
      const keyParam = parsed.searchParams.get('key');
      const maskedQuery = keyParam ? `?key=${keyParam.substring(0, 3)}••••` : '';
      return `${parsed.protocol}//${parsed.hostname}/deploy/${maskedPath}${maskedQuery}`;
    } catch {
      return 'https://api.render.com/deploy/••••••••';
    }
  }

  public getStatus(): RenderDeployHookStatus {
    return {
      configured: Boolean(this.hookUrl && this.hookUrl.length > 10),
      maskedUrl: this.getMaskedUrl(),
      lastTriggeredAt: this.lastTriggeredAt,
      lastStatus: this.lastStatus,
      instructions: {
        step1: 'Sign in to Render Dashboard at https://dashboard.render.com',
        step2: 'Navigate to your Web Service ("gpu-compute-arbitrage-os")',
        step3: 'Go to Settings -> scroll to "Deploy Hook" section',
        step4: 'Copy the URL (e.g. https://api.render.com/deploy/srv-xxxxxx?key=yyyyyy) and paste it here',
        docsUrl: 'https://render.com/docs/deploy-hooks',
      },
    };
  }

  public async triggerDeploy(): Promise<TriggerDeployResult> {
    const now = new Date().toISOString();
    if (!this.hookUrl) {
      return {
        success: false,
        message: 'No Render Deploy Hook URL configured. Enter your Render Deploy Hook URL to enable one-click deployments.',
        triggeredAt: now,
      };
    }

    try {
      console.log(`[Render Deploy Hook] Triggering deployment via ${this.getMaskedUrl()}...`);
      const response = await fetch(this.hookUrl, {
        method: 'POST',
        headers: {
          'User-Agent': 'GPU-Arbitrage-OS-DeployHook/1.0',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      });

      let responseData: any = null;
      const text = await response.text();
      try {
        responseData = JSON.parse(text);
      } catch {
        responseData = { rawResponse: text.substring(0, 300) };
      }

      this.lastTriggeredAt = now;
      if (response.ok) {
        this.lastStatus = 'DEPLOY_TRIGGERED_SUCCESS';
        systemMemoryService.updateState({}, `Render deploy hook triggered successfully (HTTP ${response.status})`);
        return {
          success: true,
          statusCode: response.status,
          message: 'Render deployment triggered successfully! Your service is rebuilding.',
          details: responseData,
          triggeredAt: now,
        };
      } else {
        this.lastStatus = `DEPLOY_TRIGGER_FAILED_HTTP_${response.status}`;
        return {
          success: false,
          statusCode: response.status,
          message: `Render returned HTTP ${response.status} (${response.statusText})`,
          details: responseData,
          triggeredAt: now,
        };
      }
    } catch (err: any) {
      this.lastTriggeredAt = now;
      this.lastStatus = 'DEPLOY_TRIGGER_ERROR';
      return {
        success: false,
        message: `Failed to reach Render Deploy Hook: ${err.message}`,
        error: err.message,
        triggeredAt: now,
      };
    }
  }
}

export const renderDeployService = new RenderDeployService();
