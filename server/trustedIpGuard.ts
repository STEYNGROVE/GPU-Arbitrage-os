import type { Request, Response, NextFunction } from 'express';
import os from 'os';
import net from 'node:net';
import { extractAuthToken, isAuthorizedPassToken } from './authMiddleware.ts';
import crypto from 'crypto';
import { config } from './config.ts';

export interface SecurityAccessLog {
  id: string;
  timestamp: string;
  ip: string;
  method: string;
  path: string;
  status: 'ALLOWED' | 'BLOCKED';
  reason: string;
}

export interface DetectedEgressInfo {
  ipv4: string;
  ipv6: string;
  timestamp: string;
  provider: string;
}

class TrustedIpGuardService {
  private trustedIps: Set<string>;
  private enforcementMode: 'ENFORCED' | 'AUDIT_MODE' = 'ENFORCED';
  private accessLogs: SecurityAccessLog[] = [];
  private maxLogs: number = 100;
  private totalBlocked: number = 0;
  private totalAllowed: number = 0;
  private lastScanTime: string = new Date().toISOString();
  private autoDetectEnabled: boolean = false;
  private detectedEgress: DetectedEgressInfo = {
    ipv4: '',
    ipv6: '',
    timestamp: new Date().toISOString(),
    provider: 'UNVERIFIED',
  };

  constructor() {
    this.trustedIps = new Set(config.trustedIps);

    // Initial outbound egress probe
    this.probeOutboundEgress().catch(() => {});

    console.log(
      `[Trusted IP Guard] Initialized in ${this.enforcementMode} mode. Zero Auto-Trust: Unknown IPs are DENIED by default. Whitelisted count: ${this.trustedIps.size}`
    );
  }

  public async probeOutboundEgress(): Promise<{ ipv4: string; ipv6: string }> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const resp = await fetch('https://api.ipify.org?format=json', {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (resp.ok) {
        const json = (await resp.json()) as { ip?: string };
        if (json.ip) {
          const currentEgress = this.normalizeIp(json.ip);
          this.detectedEgress.ipv4 = currentEgress;
          this.detectedEgress.timestamp = new Date().toISOString();
        }
      }
    } catch {
      // Retain fallback egress IP
    }
    return { ipv4: this.detectedEgress.ipv4, ipv6: this.detectedEgress.ipv6 };
  }

  public async getEgressIpInfo() {
    return {
      outboundIpv4: this.detectedEgress.ipv4,
      outboundIpv6: this.detectedEgress.ipv6,
      binanceWhitelistedIps: [],
      cloudRegion: 'UNVERIFIED',
      status: this.detectedEgress.ipv4 ? 'EGRESS_OBSERVED_WHITELIST_UNVERIFIED' : 'UNVERIFIED',
      lastScanTime: this.detectedEgress.timestamp,
      enforcementMode: this.enforcementMode,
      totalBlocked: this.totalBlocked,
      totalAllowed: this.totalAllowed,
    };
  }

  public getClientIp(req: Request): string {
    return this.normalizeIp(req.ip || req.socket.remoteAddress || '');
  }

  public normalizeIp(rawIp: string): string {
    if (!rawIp) return '';
    let ip = rawIp.trim();
    if (ip.startsWith('::ffff:')) {
      ip = ip.substring(7);
    }
    if (ip === '::1') {
      ip = '127.0.0.1';
    }
    return ip;
  }

  public isIpTrusted(clientIp: string): boolean {
    return this.trustedIps.has(this.normalizeIp(clientIp));
  }

  public middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!req.path.startsWith('/api') || req.path === '/api/health') return next();
      const clientIp = this.getClientIp(req);
      if (this.isIpTrusted(clientIp) || isAuthorizedPassToken(extractAuthToken(req)) || this.enforcementMode === 'AUDIT_MODE') {
        this.totalAllowed++; return next();
      }
      this.totalBlocked++;
      return res.status(403).json({ error: 'Authenticated access required', code: 'IP_NOT_WHITELISTED' });
    };
  }

  public addTrustedIp(ip: string): boolean {
    const normalized = this.normalizeIp(ip);
    if (!net.isIP(normalized)) return false;
    this.trustedIps.add(normalized);
    console.log(`[Trusted IP Guard] Authorized new trusted IP: ${normalized}`);
    return true;
  }

  public removeTrustedIp(ip: string): boolean {
    const normalized = this.normalizeIp(ip);
    if (normalized === '127.0.0.1' || normalized === 'localhost') {
      return false; // Prevent accidental lockout of localhost
    }
    const removed = this.trustedIps.delete(normalized);
    if (removed) {
      console.log(`[Trusted IP Guard] Removed IP from allowlist: ${normalized}`);
    }
    return removed;
  }

  public toggleMode(): 'ENFORCED' | 'AUDIT_MODE' {
    this.enforcementMode = this.enforcementMode === 'ENFORCED' ? 'AUDIT_MODE' : 'ENFORCED';
    console.log(`[Trusted IP Guard] Security Enforcement mode switched to: ${this.enforcementMode}`);
    return this.enforcementMode;
  }

  public toggleAutoDetect(enabled?: boolean): boolean {
    if (typeof enabled === 'boolean') {
      this.autoDetectEnabled = enabled;
    } else {
      this.autoDetectEnabled = !this.autoDetectEnabled;
    }
    return this.autoDetectEnabled;
  }

  public async runFullAutoDetectScan(clientIp?: string) {
    await this.probeOutboundEgress();
    const normalized = clientIp ? this.normalizeIp(clientIp) : '';
    if (normalized && this.autoDetectEnabled) {
      this.addTrustedIp(normalized);
    }
    return {
      autoDetectEnabled: this.autoDetectEnabled,
      detectedOutboundIp: this.detectedEgress.ipv4,
      clientIp: normalized,
      isClientIpTrusted: normalized ? this.isIpTrusted(normalized) : false,
      autoDetectedIps: [this.detectedEgress.ipv4].filter(Boolean),
      totalTrustedIps: this.trustedIps.size,
    };
  }

  public getStatus(currentClientIp?: string) {
    const norm = currentClientIp ? this.normalizeIp(currentClientIp) : '';
    return {
      enforcementMode: this.enforcementMode,
      autoDetectEnabled: this.autoDetectEnabled,
      totalTrustedIps: this.trustedIps.size,
      trustedIps: Array.from(this.trustedIps),
      currentClientIp: norm,
      clientIp: norm,
      isCurrentClientTrusted: norm ? this.isIpTrusted(norm) : false,
      isClientIpTrusted: norm ? this.isIpTrusted(norm) : false,
      totalBlocked: this.totalBlocked,
      totalAllowed: this.totalAllowed,
      detectedOutboundIp: this.detectedEgress.ipv4,
      detectedOutboundIpv6: this.detectedEgress.ipv6,
      detectedEgress: this.detectedEgress,
      autoDetectedIps: [this.detectedEgress.ipv4].filter(Boolean),
      recentAccessLogs: this.accessLogs.slice(-20),
    };
  }

  public addLog(entry: SecurityAccessLog) {
    this.accessLogs.unshift(entry);
    if (this.accessLogs.length > this.maxLogs) {
      this.accessLogs.pop();
    }
  }

  public hydrateState(state: {
    enforcementMode?: 'ENFORCED' | 'AUDIT_MODE';
    trustedIps?: string[];
    autoDetectEnabled?: boolean;
  }) {
    if (state.enforcementMode) this.enforcementMode = state.enforcementMode;
    if (typeof state.autoDetectEnabled === 'boolean') this.autoDetectEnabled = state.autoDetectEnabled;
    if (Array.isArray(state.trustedIps)) {
      this.trustedIps = new Set([...this.trustedIps, ...state.trustedIps.map((ip) => this.normalizeIp(ip)).filter(Boolean)]);
    }
  }
}

export const trustedIpGuard = new TrustedIpGuardService();
