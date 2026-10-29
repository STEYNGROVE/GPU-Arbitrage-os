/** Read-only compatibility interface. Capital correction and live address adapters are unavailable. */

import { Spot } from '@binance/connector';
import { config } from './config.ts';
import { financialLedger, type LedgerEntry } from './financialLedger.ts';
import { jakeGroveCfoService } from './jakeGroveCfoService.ts';

export const PROTECTED_MASTER_UID = config.binance.targetUid;
export const PROTECTED_OWNER_EMAIL = '';

export interface DynamicPulledAddress {
  network: string;
  networkName: string;
  coin: string;
  address: string;
  tagOrMemo?: string;
  pulledFromApi: boolean;
  source: 'BINANCE_SAPI_DEPOSIT_ADDRESS' | 'VERIFIED_UID_VAULT';
  verifiedAt: string;
  isLockedToUid16863338: boolean;
}

export interface BlockerAuditItem {
  id: string;
  category: 'SECURITY' | 'UID_MISMATCH' | 'ADDRESS_LEAKAGE' | 'CAPITAL_DISCREPANCY' | 'PENDING_TRANSACTION';
  description: string;
  status: 'RESOLVED_BY_AGENT' | 'CLEAR';
  resolvedAt: string;
  actionTaken: string;
}

export interface CapitalGuardianStatus {
  agentName: 'BinanceCapitalGuardianAgent';
  protectedUid: string;
  protectedOwnerEmail: string;
  agentStatus: 'ACTIVE_CONTINUOUS_ENFORCEMENT';
  lastReconciliationTimestamp: string;
  isBalancedToTheCent: boolean;
  varianceUsd: number;
  systemBalanceUsd: number;
  binanceLiveSpotBalanceUsd: number;
  pulledAddressesCount: number;
  pulledAddresses: DynamicPulledAddress[];
  activeBlockersDetected: number;
  blockersResolvedCount: number;
  blockersHistory: BlockerAuditItem[];
  reconciliationCyclesCompleted: number;
  protectionRules: {
    rejectNonMatchingUids: boolean;
    rejectUnverifiedAddresses: boolean;
    zeroCentDiscrepancyEnforced: boolean;
    autoAddressPullOnBoot: boolean;
  };
}

class BinanceCapitalGuardianAgent {
  public getStatus(): any { return { protectedUid: config.binance.targetUid, protectedOwnerEmail: '',
    agentStatus: 'BLOCKED_UNVERIFIED', isBalancedToTheCent: false, pulledAddressesCount: 0, pulledAddresses: [],
    varianceUsd: null, activeBlockersDetected: 1, blockersResolvedCount: 0, blockersHistory: [], reconciliationCyclesCompleted: 0 }; }
  public async balanceCapitalEverywhere(): Promise<any> { throw new Error('Reconciliation is blocked until independent ledger and exchange evidence can be compared.'); }
  public async pullAddressesFromApiKey(): Promise<any> { throw new Error('Provider-verified deposit address adapter is required.'); }
}
export const binanceCapitalGuardianAgent = new BinanceCapitalGuardianAgent();
