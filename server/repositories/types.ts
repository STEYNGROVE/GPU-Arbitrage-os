import { CanonicalPaymentState } from '../moneyUtils.js';

export interface Customer {
  customerId: string;
  name: string;
  email: string;
  status: 'ACTIVE' | 'SUSPENDED';
  kycStatus: 'PENDING' | 'VERIFIED' | 'REJECTED';
  creditLimit: number;
  escrowBalance?: number;
  createdAt: string;
  permissions?: string[];
}

export type CustomerRecord = Customer;

export interface CustomerApiKey {
  keyId: string;
  customerId: string;
  keyHash: string;
  keyPrefix: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string | null;
  lastUsedAt?: string | null;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
}

export type CustomerApiKeyRecord = CustomerApiKey;

export interface CustomerSession {
  sessionId: string;
  userId: string;
  role: 'OWNER' | 'CUSTOMER';
  customerId?: string | null;
  permissions: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt?: string | null;
  lastSeenAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuthoritativeDemandOrder {
  id: string;
  customerId: string;
  customerName: string;
  demandClass: 'CONFIRMED' | 'PROBABLE' | 'PREDICTED';
  workloadType: string;
  gpuModel: string;
  minVramGb: number;
  gpuCount: number;
  durationHours: number;
  deadlineMinutes: number;
  customerGrossOfferPrice: number;
  customerHourlyRate: number;
  paymentStatus: 'QUOTE_PENDING' | 'ESCROW_AUTHORIZED' | 'PREPAID_CREDIT' | 'SETTLED';
  demandSource: string;
  authSignature: string;
  escrowReferenceId?: string | null;
  isConfirmed: boolean;
  createdAt: string;
}

export interface AuthoritativeQuote {
  quoteId: string;
  customerId: string;
  demandOrderId: string;
  provider: string;
  offerId: string;
  gpuModel: string;
  gpuCount: number;
  region: string;
  durationHours: number;
  verifiedHourlyPrice: number;
  maxTotalCost: number;
  currency: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  signature: string;
  status: 'ISSUED' | 'CONSUMED' | 'EXPIRED' | 'CANCELLED';
  consumedAt?: string | null;
  consumedBy?: string | null;
  createdAt: string;
}

export interface TreasuryAccount {
  id: string;
  provider: 'binance' | 'bank' | 'system';
  externalAccountId: string;
  accountType: 'CLEARING' | 'ESCROW_LIABILITY' | 'TREASURY_CASH' | 'COMPUTE_EXPENSE' | 'REVENUE';
  accountClass?: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  asset: string; // 'USD', 'USDT', 'BTC', 'ETH', 'ZAR'
  currency: string;
  environment: 'LIVE' | 'PAPER';
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt: string;
  updatedAt: string;
}

export interface TreasuryLedgerEntry {
  transactionId: string;
  entryGroupId: string;
  accountId: string;
  asset: string;
  currency: string;
  quantity: number;
  precision: number;
  direction: 'DEBIT' | 'CREDIT';
  transactionType: 'CUSTOMER_PAYMENT' | 'ESCROW_LOCK' | 'COMPUTE_PURCHASE' | 'SETTLEMENT' | 'REFUND' | 'CORRECTION';
  externalReference: string;
  provider: string;
  operationId?: string | null;
  createdAt: string;
  previousHash: string;
  recordHash: string;
}

export interface CapitalReservation {
  reservationId: string;
  demandOrderId: string;
  quoteId: string;
  accountId: string;
  asset: string;
  currency: string;
  amount: number;
  status: 'REQUESTED' | 'RESERVED' | 'CONSUMED' | 'RELEASED' | 'EXPIRED';
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export type ProviderOperationState =
  | 'CREATED'
  | 'RESERVATION_PENDING'
  | 'RESERVED'
  | 'PROVIDER_REQUEST_PENDING'
  | 'PROVIDER_REQUEST_SENT'
  | 'INSTANCE_CREATED'
  | 'INSTANCE_VERIFIED'
  | 'JOB_COMMITTED'
  | 'RUNNING'
  | 'TERMINATION_PENDING'
  | 'TERMINATED'
  | 'SETTLEMENT_PENDING'
  | 'SETTLED'
  | 'FAILED'
  | 'RECOVERY_REQUIRED';

export interface ProviderOperation {
  operationId: string;
  demandOrderId: string;
  quoteId: string;
  reservationId?: string | null;
  customerId: string;
  provider: string;
  offerId: string;
  gpuModel: string;
  gpuCount: number;
  providerInstanceId?: string | null;
  state: ProviderOperationState;
  idempotencyKey?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ComputeJob {
  jobId: string;
  operationId: string;
  demandOrderId: string;
  customerId: string;
  provider: string;
  providerInstanceId: string;
  gpuModel: string;
  gpuCount: number;
  contractedRevenue: number;
  providerHourlyRate: number;
  status: 'PROVISIONING' | 'RUNNING' | 'COMPLETED' | 'TERMINATED' | 'FAILED';
  startedAt: string;
  endedAt?: string | null;
  actualDurationHours?: number | null;
  actualCost?: number | null;
  billingVerified: boolean;
  billingReference?: string | null;
  telemetryStatus: 'LIVE_VERIFIED' | 'LIVE_UNMEASURED' | 'TELEMETRY_UNAVAILABLE';
  createdAt: string;
}

export interface SettlementRecord {
  settlementId: string;
  jobId: string;
  customerId: string;
  grossRevenue: number;
  totalCost: number;
  netProfit: number;
  escrowDebited: number;
  providerCostPaid: number;
  status: 'SETTLED' | 'DISPUTED' | 'RECONCILIATION_REQUIRED';
  idempotencyKey?: string | null;
  settledAt: string;
}

export type OutboxStatus = 'PENDING' | 'CLAIMED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'RETRYING' | 'DEAD_LETTER';

export interface OutboxEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  retryCount: number;
  claimedBy?: string | null;
  claimedAt?: string | null;
  leaseTimeoutAt?: string | null;
  createdAt: string;
  processedAt?: string | null;
  error?: string | null;
}

export interface AuditEvent {
  id: string;
  eventType: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL' | 'SECURITY';
  message: string;
  details?: Record<string, unknown> | null;
  prevHash?: string | null;
  verifiedSignature: string;
  createdAt: string;
}

export interface ReconciliationRun {
  id: string;
  provider: string;
  asset: string;
  externalBalance: number;
  internalBalance: number;
  discrepancy: number;
  status: 'RECONCILED' | 'MISMATCH' | 'ERROR';
  reason?: string | null;
  reconciledAt: string;
}

export interface KillSwitchState {
  id: string;
  isActive: boolean;
  reason?: string | null;
  activatedBy?: string | null;
  activatedAt?: string | null;
  updatedAt: string;
}

export interface PaymentIntentRecord {
  intentId: string;
  customerId: string;
  orderId?: string | null;
  provider: string;
  amountMinor: bigint;
  currency: string;
  status: CanonicalPaymentState;
  providerTransactionId?: string | null;
  createdAt: string;
  settledAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ProviderTransactionRecord {
  id: string;
  provider: string;
  providerTransactionId: string;
  intentId?: string | null;
  customerId: string;
  amountMinor: bigint;
  currency: string;
  status: string;
  creditedAt: string;
  rawPayload?: Record<string, unknown> | null;
}
