import crypto from 'crypto';
import { pgDbService } from './pgDatabase.js';
import { timingSafeMatch, getEffectiveEscrowSecret } from './auth.js';
import { validateCurrency, toMinorUnits, fromMinorUnits, SupportedCurrency, CanonicalPaymentState } from './moneyUtils.js';
import { paymentRepo, auditRepo, killSwitchRepo } from './repositories/index.js';
import { binanceTreasuryProvider } from './binanceProvider.js';
import { hotWalletService, OFFICIAL_BSC_USDT_CONTRACT, OFFICIAL_BSC_CHAIN_ID } from './hotWalletService.js';
import { PayFastPaymentProvider, payfastProvider } from './payfastProvider.js';

export type PaymentProviderType = 'BINANCE' | 'PAYFAST';

export interface PaymentIntentRecord {
  id: string;
  customerId: string;
  provider: PaymentProviderType;
  amountCents: number; // Integer minor units
  amountFormatted: number;
  currency: SupportedCurrency;
  status: CanonicalPaymentState | 'EXPIRED';
  reference: string;
  orderId?: string;
  paymentUrl?: string;
  destinationAddress?: string;
  network?: string;
  tokenContract?: string;
  expiresAt?: string;
  providerTransactionId?: string;
  settledAt?: string;
  createdAt: string;
  metadata?: Record<string, any>;
}

export interface VerificationResult {
  verified: boolean;
  status: 'VERIFIED' | 'SETTLED' | 'CLEARED' | 'PENDING' | 'REJECTED' | 'FAILED' | 'UNVERIFIED';
  providerTransactionId?: string;
  amountCents?: number;
  currency?: SupportedCurrency;
  reference?: string;
  destinationAddress?: string;
  network?: string;
  tokenContract?: string;
  confirmations?: number;
  reason?: string;
}

export interface PaymentProvider {
  name: PaymentProviderType;
  isConfigured(): boolean;
  createPaymentIntent(params: {
    intentId: string;
    amountCents: number;
    currency: SupportedCurrency;
    reference: string;
    customerEmail?: string;
    customerName?: string;
    orderId?: string;
    destinationAddress?: string;
  }): Promise<{
    success: boolean;
    paymentUrl?: string;
    providerReference?: string;
    destinationAddress?: string;
    network?: string;
    tokenContract?: string;
    expiresAt?: string;
    error?: string;
  }>;
  verifyPayment(params: {
    intent: PaymentIntentRecord;
    providerTransactionId?: string;
    rawPayload?: any;
    signature?: string;
    depositRecordsOverride?: any[];
  }): Promise<VerificationResult>;
  verifyWebhookSignature(payload: string | Buffer | any, signature?: string): boolean;
}

// =========================================================================
// 1. BINANCE CANONICAL PAYMENT & TREASURY PROVIDER (Primary Production Rail)
// =========================================================================
export class BinancePaymentProvider implements PaymentProvider {
  readonly name: PaymentProviderType = 'BINANCE';

  isConfigured(): boolean {
    return (
      binanceTreasuryProvider.isConfigured() &&
      Boolean(process.env.BINANCE_WEBHOOK_SECRET && process.env.BINANCE_WEBHOOK_SECRET.trim().length >= 8) &&
      Boolean(getEffectiveEscrowSecret())
    );
  }

  /**
   * Resolves the authoritative expected destination address EXCLUSIVELY from the
   * PostgreSQL payment intent.
   * NEVER trusts any destination supplied by an incoming webhook or global fallback.
   */
  public resolveAuthoritativeIntentDestination(intent: PaymentIntentRecord): string {
    return (
      intent.destinationAddress ||
      intent.metadata?.destinationAddress ||
      ''
    ).trim();
  }

  /**
   * Independently verifies actual Binance/blockchain settlement using:
   * 1. transaction ID (txId / txHash)
   * 2. network (BSC / BEP20 / Chain ID 56)
   * 3. token contract (Official BSC USDT: 0x55d398326f99059fF775485246999027B3197955)
   * 4. destination (strictly bound to authoritative PostgreSQL payment intent destination)
   * 5. amount (exact match within $0.01 to authoritative payment intent)
   * 6. confirmations (>= 15 confirmations on BSC or settled status === 1 on Binance Deposit API)
   * before crediting customer funds.
   */
  async verifyIndependentSettlement(params: {
    txId: string;
    expectedNetwork?: string;
    expectedTokenContract?: string;
    expectedAsset?: string;
    expectedAmountMajor: number;
    expectedDestination?: string;
    webhookSuppliedDestination?: string;
    webhookSuppliedNetwork?: string;
    webhookSuppliedTokenContract?: string;
    minConfirmations?: number;
    depositRecordsOverride?: Array<{
      id?: string;
      txId?: string;
      coin: string;
      network?: string;
      tokenContract?: string;
      amount: number;
      status: number;
      address: string;
      confirmations?: number;
    }>;
  }): Promise<{
    verified: boolean;
    txId: string;
    network: string;
    tokenContract: string;
    asset: string;
    amountMajor: number;
    destination: string;
    confirmations: number;
    source: 'BINANCE_DEPOSIT_API' | 'BSC_ONCHAIN_RPC' | 'UNVERIFIED';
    reason?: string;
  }> {
    const txId = String(params.txId || '').trim();
    const expectedNetwork = String(params.expectedNetwork || 'BSC').trim().toUpperCase();
    const expectedTokenContract = String(params.expectedTokenContract || OFFICIAL_BSC_USDT_CONTRACT).trim();
    const expectedAsset = String(params.expectedAsset || 'USDT').toUpperCase();
    const expectedAmount = Number(params.expectedAmountMajor);
    const minConfirmations = params.minConfirmations ?? 15;
    const authoritativeDestination = String(params.expectedDestination || '').trim();

    if (!txId) {
      return {
        verified: false,
        txId: '',
        network: expectedNetwork,
        tokenContract: expectedTokenContract,
        asset: expectedAsset,
        amountMajor: 0,
        destination: '',
        confirmations: 0,
        source: 'UNVERIFIED',
        reason: 'TRANSACTION_ID_REQUIRED: Missing transaction ID for independent settlement verification.'
      };
    }

    if (!authoritativeDestination) {
      return {
        verified: false,
        txId,
        network: expectedNetwork,
        tokenContract: expectedTokenContract,
        asset: expectedAsset,
        amountMajor: 0,
        destination: '',
        confirmations: 0,
        source: 'UNVERIFIED',
        reason: 'DESTINATION_MISSING: Authoritative payment intent has no bound destination address.'
      };
    }

    // Security Gate: If webhook supplied a destination, it MUST match the authoritative intent destination
    if (params.webhookSuppliedDestination !== undefined && String(params.webhookSuppliedDestination).trim() !== '') {
      const webhookDest = String(params.webhookSuppliedDestination).trim();
      if (webhookDest.toLowerCase() !== authoritativeDestination.toLowerCase()) {
        return {
          verified: false,
          txId,
          network: expectedNetwork,
          tokenContract: expectedTokenContract,
          asset: expectedAsset,
          amountMajor: 0,
          destination: webhookDest,
          confirmations: 0,
          source: 'UNVERIFIED',
          reason: `DESTINATION_MISMATCH: Incoming webhook destination '${webhookDest}' does not match authoritative PostgreSQL payment intent destination '${authoritativeDestination}'.`
        };
      }
    }

    // Security Gate: Validate network is strictly BSC Mainnet (Chain ID 56 / BEP20)
    const authorizedNetworks = ['BSC', 'BEP20', 'BNB', '56'];
    if (!authorizedNetworks.includes(expectedNetwork)) {
      return {
        verified: false,
        txId,
        network: expectedNetwork,
        tokenContract: expectedTokenContract,
        asset: expectedAsset,
        amountMajor: 0,
        destination: authoritativeDestination,
        confirmations: 0,
        source: 'UNVERIFIED',
        reason: `NETWORK_MISMATCH: Expected network '${expectedNetwork}' is not authorized. Only BSC (Chain ID ${OFFICIAL_BSC_CHAIN_ID}) is permitted.`
      };
    }

    if (params.webhookSuppliedNetwork !== undefined && String(params.webhookSuppliedNetwork).trim() !== '') {
      const suppliedNet = String(params.webhookSuppliedNetwork).trim().toUpperCase();
      if (!authorizedNetworks.includes(suppliedNet)) {
        return {
          verified: false,
          txId,
          network: suppliedNet,
          tokenContract: expectedTokenContract,
          asset: expectedAsset,
          amountMajor: 0,
          destination: authoritativeDestination,
          confirmations: 0,
          source: 'UNVERIFIED',
          reason: `NETWORK_MISMATCH: Webhook network '${suppliedNet}' is not authorized. Only BSC (Chain ID ${OFFICIAL_BSC_CHAIN_ID}) is permitted.`
        };
      }
    }

    // Security Gate: Validate token contract is strictly Official BSC USDT contract
    if (expectedTokenContract.toLowerCase() !== OFFICIAL_BSC_USDT_CONTRACT.toLowerCase()) {
      return {
        verified: false,
        txId,
        network: expectedNetwork,
        tokenContract: expectedTokenContract,
        asset: expectedAsset,
        amountMajor: 0,
        destination: authoritativeDestination,
        confirmations: 0,
        source: 'UNVERIFIED',
        reason: `TOKEN_CONTRACT_MISMATCH: Expected token contract '${expectedTokenContract}' does not match official BSC USDT contract '${OFFICIAL_BSC_USDT_CONTRACT}'.`
      };
    }

    if (params.webhookSuppliedTokenContract !== undefined && String(params.webhookSuppliedTokenContract).trim() !== '') {
      const suppliedContract = String(params.webhookSuppliedTokenContract).trim();
      if (suppliedContract.toLowerCase() !== OFFICIAL_BSC_USDT_CONTRACT.toLowerCase()) {
        return {
          verified: false,
          txId,
          network: expectedNetwork,
          tokenContract: suppliedContract,
          asset: expectedAsset,
          amountMajor: 0,
          destination: authoritativeDestination,
          confirmations: 0,
          source: 'UNVERIFIED',
          reason: `TOKEN_CONTRACT_MISMATCH: Webhook token contract '${suppliedContract}' does not match official BSC USDT contract '${OFFICIAL_BSC_USDT_CONTRACT}'.`
        };
      }
    }

    if (!['USDT', 'USDC', 'USD'].includes(expectedAsset)) {
      return {
        verified: false,
        txId,
        network: expectedNetwork,
        tokenContract: expectedTokenContract,
        asset: expectedAsset,
        amountMajor: 0,
        destination: '',
        confirmations: 0,
        source: 'UNVERIFIED',
        reason: `ASSET_MISMATCH: Unsupported settlement asset '${expectedAsset}'. Only USDT/USDC/USD accepted.`
      };
    }

    // Path A: Check Binance Deposit History (or injected test deposit records)
    const deposits = params.depositRecordsOverride || (await binanceTreasuryProvider.getDepositHistory({ coin: 'USDT', limit: 100 }));
    const matchedDeposit = deposits.find(d => d.txId === txId || d.id === txId);
    if (matchedDeposit) {
      const depAsset = String(matchedDeposit.coin || '').toUpperCase();
      const depNetwork = String((matchedDeposit as any).network || 'BSC').trim().toUpperCase();
      const depContract = String((matchedDeposit as any).tokenContract || OFFICIAL_BSC_USDT_CONTRACT).trim();

      if (!authorizedNetworks.includes(depNetwork)) {
        return {
          verified: false,
          txId,
          network: depNetwork,
          tokenContract: depContract,
          asset: depAsset,
          amountMajor: matchedDeposit.amount,
          destination: matchedDeposit.address || '',
          confirmations: 0,
          source: 'BINANCE_DEPOSIT_API',
          reason: `NETWORK_MISMATCH: Deposit occurred on unauthorized network '${depNetwork}'. Strictly requires BSC (Chain ID 56).`
        };
      }

      if (depContract.toLowerCase() !== OFFICIAL_BSC_USDT_CONTRACT.toLowerCase()) {
        return {
          verified: false,
          txId,
          network: depNetwork,
          tokenContract: depContract,
          asset: depAsset,
          amountMajor: matchedDeposit.amount,
          destination: matchedDeposit.address || '',
          confirmations: 0,
          source: 'BINANCE_DEPOSIT_API',
          reason: `TOKEN_CONTRACT_MISMATCH: Deposit token contract '${depContract}' does not match official BSC USDT '${OFFICIAL_BSC_USDT_CONTRACT}'.`
        };
      }

      if (depAsset !== 'USDT' && depAsset !== expectedAsset) {
        return {
          verified: false,
          txId,
          network: depNetwork,
          tokenContract: depContract,
          asset: depAsset,
          amountMajor: matchedDeposit.amount,
          destination: matchedDeposit.address || '',
          confirmations: 0,
          source: 'BINANCE_DEPOSIT_API',
          reason: `ASSET_MISMATCH: Expected ${expectedAsset}, Binance deposit recorded ${depAsset}.`
        };
      }

      if (Math.abs(matchedDeposit.amount - expectedAmount) > 0.01) {
        return {
          verified: false,
          txId,
          network: depNetwork,
          tokenContract: depContract,
          asset: depAsset,
          amountMajor: matchedDeposit.amount,
          destination: matchedDeposit.address || '',
          confirmations: 0,
          source: 'BINANCE_DEPOSIT_API',
          reason: `AMOUNT_MISMATCH: Expected ${expectedAmount.toFixed(2)}, Binance deposit recorded ${matchedDeposit.amount.toFixed(2)}.`
        };
      }

      const depDest = String(matchedDeposit.address || '').trim();
      if (!depDest || depDest.toLowerCase() !== authoritativeDestination.toLowerCase()) {
        return {
          verified: false,
          txId,
          network: depNetwork,
          tokenContract: depContract,
          asset: depAsset,
          amountMajor: matchedDeposit.amount,
          destination: depDest,
          confirmations: 0,
          source: 'BINANCE_DEPOSIT_API',
          reason: `DESTINATION_MISMATCH: Deposit destination '${depDest}' does not match authoritative payment intent destination '${authoritativeDestination}'.`
        };
      }

      const depConfirmations = (matchedDeposit as any).confirmations !== undefined
        ? Number((matchedDeposit as any).confirmations)
        : matchedDeposit.status === 1
        ? minConfirmations
        : 0;

      if (matchedDeposit.status !== 1 || depConfirmations < minConfirmations) {
        return {
          verified: false,
          txId,
          network: depNetwork,
          tokenContract: depContract,
          asset: depAsset,
          amountMajor: matchedDeposit.amount,
          destination: depDest,
          confirmations: depConfirmations,
          source: 'BINANCE_DEPOSIT_API',
          reason: `INSUFFICIENT_CONFIRMATIONS: Deposit status=${matchedDeposit.status}, confirmations=${depConfirmations} (minimum ${minConfirmations} required).`
        };
      }

      return {
        verified: true,
        txId,
        network: 'BSC',
        tokenContract: OFFICIAL_BSC_USDT_CONTRACT,
        asset: depAsset,
        amountMajor: matchedDeposit.amount,
        destination: depDest,
        confirmations: depConfirmations,
        source: 'BINANCE_DEPOSIT_API'
      };
    }

    // Path B: Check On-Chain BSC Mainnet Transaction Receipt if 66-char txHash
    if (/^0x[a-fA-F0-9]{64}$/.test(txId)) {
      const onchain = await hotWalletService.verifyAndRecordOnchainDeposit({
        txHash: txId,
        expectedAmount
      });

      if (!onchain.success) {
        return {
          verified: false,
          txId,
          network: 'BSC',
          tokenContract: OFFICIAL_BSC_USDT_CONTRACT,
          asset: 'USDT',
          amountMajor: onchain.amount || 0,
          destination: onchain.recipient || '',
          confirmations: onchain.confirmationCount || 0,
          source: 'BSC_ONCHAIN_RPC',
          reason: onchain.error || 'ONCHAIN_VERIFICATION_FAILED'
        };
      }

      const confirmations = onchain.confirmationCount || 0;
      const recipient = (onchain.recipient || '').trim();
      if (!recipient || recipient.toLowerCase() !== authoritativeDestination.toLowerCase()) {
        return {
          verified: false,
          txId,
          network: 'BSC',
          tokenContract: OFFICIAL_BSC_USDT_CONTRACT,
          asset: 'USDT',
          amountMajor: onchain.amount || 0,
          destination: recipient,
          confirmations,
          source: 'BSC_ONCHAIN_RPC',
          reason: `DESTINATION_MISMATCH: On-chain recipient '${recipient}' does not match authoritative payment intent destination '${authoritativeDestination}'.`
        };
      }

      if (confirmations < minConfirmations) {
        return {
          verified: false,
          txId,
          network: 'BSC',
          tokenContract: OFFICIAL_BSC_USDT_CONTRACT,
          asset: 'USDT',
          amountMajor: onchain.amount || 0,
          destination: recipient,
          confirmations,
          source: 'BSC_ONCHAIN_RPC',
          reason: `INSUFFICIENT_CONFIRMATIONS: On-chain confirmations ${confirmations} < required ${minConfirmations}.`
        };
      }

      return {
        verified: true,
        txId,
        network: 'BSC',
        tokenContract: OFFICIAL_BSC_USDT_CONTRACT,
        asset: 'USDT',
        amountMajor: onchain.amount || expectedAmount,
        destination: recipient,
        confirmations,
        source: 'BSC_ONCHAIN_RPC'
      };
    }

    return {
      verified: false,
      txId,
      network: expectedNetwork,
      tokenContract: expectedTokenContract,
      asset: expectedAsset,
      amountMajor: 0,
      destination: '',
      confirmations: 0,
      source: 'UNVERIFIED',
      reason: `SETTLEMENT_NOT_FOUND: Transaction '${txId}' was not found in verified Binance Deposit History or on BSC Mainnet RPC.`
    };
  }

  async createPaymentIntent(params: {
    intentId: string;
    amountCents: number;
    currency: SupportedCurrency;
    reference: string;
    customerEmail?: string;
    customerName?: string;
    orderId?: string;
    destinationAddress?: string;
  }): Promise<{
    success: boolean;
    paymentUrl?: string;
    providerReference?: string;
    destinationAddress?: string;
    network?: string;
    tokenContract?: string;
    expiresAt?: string;
    error?: string;
  }> {
    if (!this.isConfigured()) {
      return {
        success: false,
        error: 'BINANCE_NOT_CONFIGURED: BINANCE_API_KEY, BINANCE_API_SECRET, and ESCROW_SIGNING_SECRET are required for canonical Binance payment intents.'
      };
    }

    let depositAddress = (params.destinationAddress || '').trim();
    if (!depositAddress) {
      try {
        const dep = await binanceTreasuryProvider.getDepositAddress('USDT', 'BSC');
        if (dep && dep.address) {
          depositAddress = dep.address.trim();
        }
      } catch {
        // Fallback to authoritative configured treasury hot-wallet address
      }
    }
    if (!depositAddress) {
      depositAddress = (
        hotWalletService.getAddress() ||
        process.env.TREASURY_HOT_WALLET_ADDRESS ||
        ''
      ).trim();
    }

    if (!depositAddress) {
      return {
        success: false,
        error: 'DESTINATION_UNCONFIGURED: No authoritative Binance or BSC treasury deposit address is configured.'
      };
    }

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    return {
      success: true,
      paymentUrl: `binance:bsc:usdt:${depositAddress}?ref=${params.intentId}`,
      providerReference: params.intentId,
      destinationAddress: depositAddress,
      network: 'BSC',
      tokenContract: OFFICIAL_BSC_USDT_CONTRACT,
      expiresAt
    };
  }

  async verifyPayment(params: {
    intent: PaymentIntentRecord;
    providerTransactionId?: string;
    rawPayload?: any;
    signature?: string;
    depositRecordsOverride?: any[];
  }): Promise<VerificationResult> {

    // 1. Check Payment Intent Expiration
    const intentExpiresAt = params.intent.expiresAt || params.intent.metadata?.expiresAt;
    if (
      params.intent.status === 'EXPIRED' ||
      (intentExpiresAt && new Date(intentExpiresAt).getTime() <= Date.now())
    ) {
      return {
        verified: false,
        status: 'REJECTED',
        reason: `PAYMENT_INTENT_EXPIRED: Payment intent '${params.intent.id}' expired at ${intentExpiresAt || 'earlier timestamp'}.`
      };
    }

    const payload = params.rawPayload || {};
    const txId = String(params.providerTransactionId || payload.txId || payload.providerTransactionId || '').trim();
    if (!txId) {
      return {
        verified: false,
        status: 'UNVERIFIED',
        reason: 'Missing Binance deposit/escrow transaction identifier.'
      };
    }

    // 2. Verify cryptographic HMAC signature over the payment confirmation payload
    const sig = params.signature || payload.signature;
    if (!this.verifyWebhookSignature(payload, sig)) {
      return {
        verified: false,
        status: 'UNVERIFIED',
        reason: 'Invalid or missing cryptographic HMAC signature for Binance payment verification.'
      };
    }

    // 3. Resolve expected destination EXCLUSIVELY from the authoritative PostgreSQL payment intent (NEVER from webhook)
    const authoritativeDestination = this.resolveAuthoritativeIntentDestination(params.intent);
    if (!authoritativeDestination) {
      return {
        verified: false,
        status: 'REJECTED',
        reason: 'DESTINATION_MISSING: Authoritative PostgreSQL payment intent has no bound destination address.'
      };
    }

    const webhookSuppliedDestination =
      payload.destinationAddress ??
      payload.address ??
      payload.recipient ??
      payload.to;

    if (
      webhookSuppliedDestination !== undefined &&
      String(webhookSuppliedDestination).trim() !== '' &&
      String(webhookSuppliedDestination).trim().toLowerCase() !== authoritativeDestination.toLowerCase()
    ) {
      return {
        verified: false,
        status: 'REJECTED',
        reason: `DESTINATION_MISMATCH: Webhook supplied destination '${webhookSuppliedDestination}' does not match authoritative PostgreSQL payment intent destination '${authoritativeDestination}'.`
      };
    }

    if (!this.isConfigured()) {
      return {
        verified: false,
        status: 'UNVERIFIED',
        reason: 'Binance canonical payment rail is not configured with live credentials (BINANCE_API_KEY, BINANCE_API_SECRET, ESCROW_SIGNING_SECRET).'
      };
    }

    const amountCents = payload.amountCents !== undefined
      ? Number(payload.amountCents)
      : payload.amountMajor !== undefined
      ? Number(toMinorUnits(payload.amountMajor))
      : params.intent.amountCents;

    if (amountCents !== params.intent.amountCents) {
      return {
        verified: false,
        status: 'REJECTED',
        amountCents,
        reason: `AMOUNT_MISMATCH: Webhook amount (${amountCents} minor units) does not match authoritative payment intent amount (${params.intent.amountCents} minor units).`
      };
    }

    const currency = (payload.currency || params.intent.currency) as SupportedCurrency;
    const statusRaw = String(payload.status || 'VERIFIED').toUpperCase();

    if (statusRaw !== 'VERIFIED' && statusRaw !== 'SETTLED' && statusRaw !== 'CLEARED' && statusRaw !== 'SUCCESS') {
      return {
        verified: false,
        status: 'FAILED',
        reason: `Binance payment status is ${statusRaw}.`
      };
    }

    const authoritativeNetwork = (
      params.intent.network ||
      params.intent.metadata?.network ||
      'BSC'
    ).trim().toUpperCase();

    const authoritativeTokenContract = (
      params.intent.tokenContract ||
      params.intent.metadata?.tokenContract ||
      OFFICIAL_BSC_USDT_CONTRACT
    ).trim();

    // 4. Independently verify actual Binance/blockchain settlement using txId, network, tokenContract, destination (from PostgreSQL intent!), amount & confirmations
    const settlementCheck = await this.verifyIndependentSettlement({
      txId,
      expectedNetwork: authoritativeNetwork,
      expectedTokenContract: authoritativeTokenContract,
      expectedAsset: payload.asset || 'USDT',
      expectedAmountMajor: fromMinorUnits(params.intent.amountCents),
      expectedDestination: authoritativeDestination,
      webhookSuppliedDestination,
      webhookSuppliedNetwork: payload.network ?? payload.chain,
      webhookSuppliedTokenContract: payload.tokenContract ?? payload.contractAddress,
      depositRecordsOverride: params.depositRecordsOverride || payload.depositRecordsOverride
    });

    if (!settlementCheck.verified) {
      return {
        verified: false,
        status: 'UNVERIFIED',
        reason: `INDEPENDENT_SETTLEMENT_VERIFICATION_FAILED: ${settlementCheck.reason}`
      };
    }

    return {
      verified: true,
      status: 'VERIFIED',
      providerTransactionId: txId,
      amountCents: params.intent.amountCents,
      currency,
      reference: payload.reference || params.intent.reference,
      destinationAddress: settlementCheck.destination,
      network: settlementCheck.network,
      tokenContract: settlementCheck.tokenContract,
      confirmations: settlementCheck.confirmations
    };
  }

  /**
   * Explicit Binance Webhook & Settlement Protocol Architecture:
   * 1. BINANCE_SPOT_RELAY_HMAC_SHA256 (Primary Spot Treasury Deposit Rail):
   *    Since Binance Spot API (`/sapi/v1/capital/deposit/hisrec`) does not emit native push webhooks
   *    for on-chain BEP-20/ERC-20 deposits, our authenticated deposit relay signs notifications with
   *    `x-mbx-timestamp` + `x-mbx-signature` (HMAC-SHA256 using `BINANCE_WEBHOOK_SECRET`), AND
   *    `verifyPayment()` independently queries Binance Spot `/sapi/v1/capital/deposit/hisrec` and
   *    BscScan RPC to verify actual on-chain finality before crediting.
   * 2. BINANCE_PAY_NATIVE_RSA_SHA256 (Official Binance Pay Merchant Webhook v2):
   *    Verifies `BinancePay-Timestamp`, `BinancePay-Nonce`, and `BinancePay-Signature` (Base64 RSA-SHA256
   *    over `${timestamp}\n${nonce}\n${rawBody}\n`) against `BINANCE_PAY_PUBLIC_KEY`.
   */
  getWebhookProtocolSpec() {
    return {
      primaryProduct: 'BINANCE_SPOT_CAPITAL_DEPOSIT_WITH_AUTHENTICATED_RELAY',
      supportedProtocols: [
        {
          protocolId: 'BINANCE_SPOT_RELAY_HMAC_SHA256',
          headers: ['x-mbx-timestamp', 'x-mbx-signature'],
          algorithm: 'HMAC-SHA256',
          secretEnv: 'BINANCE_WEBHOOK_SECRET',
          independentSettlementApi: 'GET https://api.binance.com/sapi/v1/capital/deposit/hisrec'
        },
        {
          protocolId: 'BINANCE_PAY_NATIVE_RSA_SHA256',
          headers: ['BinancePay-Timestamp', 'BinancePay-Nonce', 'BinancePay-Signature', 'BinancePay-Certificate-SN'],
          algorithm: 'RSA-SHA256',
          publicKeyEnv: 'BINANCE_PAY_PUBLIC_KEY',
          canonicalPayloadFormat: 'timestamp + "\\n" + nonce + "\\n" + body + "\\n"'
        }
      ]
    };
  }

  verifyNativeBinancePayWebhook(params: {
    rawBody: string;
    timestamp: string;
    nonce: string;
    signatureBase64: string;
    publicKeyPem?: string;
  }): boolean {
    const pubKey = params.publicKeyPem || process.env.BINANCE_PAY_PUBLIC_KEY;
    if (!pubKey || !params.rawBody || !params.timestamp || !params.nonce || !params.signatureBase64) {
      return false;
    }
    const tsNum = Number(params.timestamp);
    if (isNaN(tsNum) || Math.abs(Date.now() - tsNum) > 5 * 60 * 1000) {
      return false;
    }
    const canonicalPayload = `${params.timestamp}\n${params.nonce}\n${params.rawBody}\n`;
    try {
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(canonicalPayload, 'utf8');
      verifier.end();
      return verifier.verify(pubKey, params.signatureBase64, 'base64');
    } catch {
      return false;
    }
  }

  generateSignature(payload: any, explicitSecret?: string): string {
    const secret = explicitSecret || process.env.BINANCE_WEBHOOK_SECRET;
    if (!secret) {
      throw new Error('BINANCE_WEBHOOK_SECRET_REQUIRED');
    }
    const canonicalString = typeof payload === 'string'
      ? payload
      : `${payload.intentId || payload.m_payment_id || ''}:${payload.txId || payload.providerTransactionId || ''}:${payload.amountCents ?? payload.amountMajor ?? ''}:${payload.currency || 'USD'}`;
    return crypto.createHmac('sha256', secret).update(canonicalString).digest('hex');
  }

  verifyWebhookSignature(payload: any, signature?: string, explicitSecret?: string): boolean {
    const secret = explicitSecret || process.env.BINANCE_WEBHOOK_SECRET;
    if (!secret || !payload) return false;
    const providedSig = signature || (typeof payload === 'object' ? payload.signature : undefined);
    if (!providedSig || typeof providedSig !== 'string') return false;

    const canonicalString = typeof payload === 'string'
      ? payload
      : `${payload.intentId || payload.m_payment_id || ''}:${payload.txId || payload.providerTransactionId || ''}:${payload.amountCents ?? payload.amountMajor ?? ''}:${payload.currency || 'USD'}`;
    const expectedSig = crypto.createHmac('sha256', secret).update(canonicalString).digest('hex');
    if (timingSafeMatch(providedSig, expectedSig)) return true;

    if (typeof payload === 'object' && payload !== null) {
      const copy = { ...payload };
      delete copy.signature;
      const jsonSig = crypto.createHmac('sha256', secret).update(JSON.stringify(copy)).digest('hex');
      if (timingSafeMatch(providedSig, jsonSig)) return true;
    }
    return false;
  }
}

// =========================================================================
// 2. CENTRAL PAYMENT ENGINE & STRICT POSTGRESQL VERIFICATION PIPELINE
// =========================================================================
export class PaymentEngine {
  private providers: Map<string, PaymentProvider> = new Map();

  constructor() {
    const binance = new BinancePaymentProvider();
    this.providers.set('BINANCE', binance);
  }

  getCanonicalRail(): PaymentProviderType {
    return 'BINANCE';
  }

  getProvider(name?: string): PaymentProvider | undefined {
    const key = (name || this.getCanonicalRail()).toUpperCase();
    if (key === 'PAYFAST') {
      return payfastProvider;
    }
    return this.providers.get(key);
  }

  getProviderStatuses(): Record<string, {
    name: string;
    description: string;
    configured: boolean;
    canonical: boolean;
    supportedCurrencies: SupportedCurrency[];
    requiredConfig?: string[];
    missingConfig?: string[];
  }> {
    const binanceProviderInstance = this.providers.get('BINANCE')!;
    const missingBinance: string[] = [];
    if (!process.env.BINANCE_API_KEY) missingBinance.push('BINANCE_API_KEY');
    if (!process.env.BINANCE_API_SECRET) missingBinance.push('BINANCE_API_SECRET');
    if (!process.env.BINANCE_WEBHOOK_SECRET) missingBinance.push('BINANCE_WEBHOOK_SECRET');

    return {
      BINANCE: {
        name: 'Binance Treasury & Crypto Payment Rail',
        description: 'Canonical Production Payment & Treasury Settlement Rail (USDT/BEP-20)',
        configured: binanceProviderInstance.isConfigured(),
        canonical: true,
        supportedCurrencies: ['USD'],
        requiredConfig: ['BINANCE_API_KEY', 'BINANCE_API_SECRET', 'BINANCE_WEBHOOK_SECRET'],
        missingConfig: missingBinance
      }
    };
  }

  /**
   * Create an authoritative Payment Intent in PostgreSQL
   * FAIL-CLOSED: Blocks financial transaction if PostgreSQL is offline or write fails.
   */
  async createIntent(params: {
    customerId: string;
    provider: PaymentProviderType;
    amountMajor: number;
    currency: string;
    reference?: string;
    orderId?: string;
    customerEmail?: string;
    customerName?: string;
  }): Promise<{ success: boolean; intent?: PaymentIntentRecord; error?: string }> {
    // 0. Strict Fail-Closed Check: PostgreSQL MUST be live for financial transactions
    if (!pgDbService.isLiveDatabaseConnected()) {
      return {
        success: false,
        error: 'POSTGRESQL_OFFLINE_FAIL_CLOSED: Authoritative PostgreSQL ledger is offline. No new financial transactions can be initiated.'
      };
    }

    // Safety Gate: Check Kill Switches
    const globalKs = await killSwitchRepo.isKillSwitchActive('GLOBAL_KILL_SWITCH');
    if (globalKs.active) {
      return {
        success: false,
        error: `KILL_SWITCH_ACTIVE: Global emergency kill switch is active (${globalKs.reason}). Customer payments blocked.`
      };
    }
    const paymentKs = await killSwitchRepo.isKillSwitchActive('NEW_CUSTOMER_PAYMENTS_KILL_SWITCH');
    if (paymentKs.active) {
      return {
        success: false,
        error: `KILL_SWITCH_ACTIVE: NEW_CUSTOMER_PAYMENTS_KILL_SWITCH is active (${paymentKs.reason}). Customer payments blocked.`
      };
    }

    // 1. Currency Validation (Strictly USD or ZAR)
    let validatedCurr: SupportedCurrency;
    try {
      validatedCurr = validateCurrency(params.currency);
    } catch (err: any) {
      return { success: false, error: err.message };
    }

    if (params.amountMajor <= 0) {
      return { success: false, error: 'Payment amount must be strictly greater than 0.' };
    }

    const provider = this.getProvider(params.provider);
    if (!provider) {
      return { success: false, error: `Unknown payment provider: ${params.provider}` };
    }

    const intentId = `pi_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const amountCents = Number(toMinorUnits(params.amountMajor));
    const ref = params.reference || `ref_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

    const providerResult = await provider.createPaymentIntent({
      intentId,
      amountCents,
      currency: validatedCurr,
      reference: ref,
      customerEmail: params.customerEmail,
      customerName: params.customerName,
      orderId: params.orderId
    });

    if (!providerResult.success) {
      return { success: false, error: providerResult.error };
    }

    // Persist Payment Intent in PostgreSQL (Fail-closed)
    try {
      await paymentRepo.createPaymentIntent({
        id: intentId,
        customerId: params.customerId,
        provider: params.provider,
        amountMinor: BigInt(amountCents),
        currency: validatedCurr,
        reference: ref,
        metadata: {
          orderId: params.orderId,
          paymentUrl: providerResult.paymentUrl,
          destinationAddress: providerResult.destinationAddress,
          network: providerResult.network || 'BSC',
          tokenContract: providerResult.tokenContract || OFFICIAL_BSC_USDT_CONTRACT,
          expiresAt: providerResult.expiresAt,
          customerEmail: params.customerEmail,
          customerName: params.customerName
        }
      });
    } catch (err: any) {
      return {
        success: false,
        error: `DATABASE_WRITE_FAILED: Failed to persist payment intent to PostgreSQL: ${err.message}`
      };
    }

    const record: PaymentIntentRecord = {
      id: intentId,
      customerId: params.customerId,
      provider: params.provider,
      amountCents,
      amountFormatted: fromMinorUnits(amountCents),
      currency: validatedCurr,
      status: 'PENDING',
      reference: ref,
      orderId: params.orderId,
      paymentUrl: providerResult.paymentUrl,
      destinationAddress: providerResult.destinationAddress,
      network: providerResult.network || 'BSC',
      tokenContract: providerResult.tokenContract || OFFICIAL_BSC_USDT_CONTRACT,
      expiresAt: providerResult.expiresAt,
      createdAt: new Date().toISOString(),
      metadata: {
        orderId: params.orderId,
        paymentUrl: providerResult.paymentUrl,
        destinationAddress: providerResult.destinationAddress,
        network: providerResult.network || 'BSC',
        tokenContract: providerResult.tokenContract || OFFICIAL_BSC_USDT_CONTRACT,
        expiresAt: providerResult.expiresAt
      }
    };

    return { success: true, intent: record };
  }

  /**
   * STRICT PAYMENT VERIFICATION PIPELINE — ZERO BYPASS ALLOWED
   *
   * Must pass all criteria:
   * 1. provider configured
   * 2. intent exists in PostgreSQL, is not already settled, and is not expired
   * 3. expected payment destination resolved exclusively from authoritative PostgreSQL intent (webhook destination never trusted)
   * 4. provider cryptographic & independent settlement verification succeeded (txId, network, tokenContract, destination, amount, confirmations)
   * 5. provider transaction exists
   * 6. amount & currency match intent EXACTLY
   * 7. payment status is confirmed ('VERIFIED', 'SETTLED', or 'CLEARED')
   * 8. transaction hasn't already been credited (PostgreSQL replay protection)
   * Otherwise: REJECT. No exceptions!
   */
  async verifyPayment(params: {
    intentId: string;
    providerTransactionId?: string;
    rawPayload?: any;
    signature?: string;
    depositRecordsOverride?: any[];
  }): Promise<{
    success: boolean;
    errorCode?: string;
    message: string;
    intent?: PaymentIntentRecord;
    creditedAmountFormatted?: number;
  }> {
    // 0. PostgreSQL Fail-Closed Enforcement
    if (!pgDbService.isLiveDatabaseConnected()) {
      return {
        success: false,
        errorCode: 'DATABASE_OFFLINE',
        message: 'POSTGRESQL_OFFLINE_FAIL_CLOSED: Authoritative PostgreSQL ledger is offline. Payment verification is blocked.'
      };
    }

    // Safety Gate: Check Kill Switches
    const globalKs = await killSwitchRepo.isKillSwitchActive('GLOBAL_KILL_SWITCH');
    if (globalKs.active) {
      return {
        success: false,
        errorCode: 'GLOBAL_KILL_SWITCH_ACTIVE',
        message: `KILL_SWITCH_ACTIVE: Global emergency kill switch is active (${globalKs.reason}). Payment settlement blocked.`
      };
    }

    // 1. Authoritative lookup strictly from PostgreSQL
    let intent: PaymentIntentRecord | undefined;
    try {
      const dbIntent = await paymentRepo.getPaymentIntent(params.intentId);
      if (dbIntent) {
        const meta = typeof dbIntent.metadata === 'string'
          ? JSON.parse(dbIntent.metadata)
          : (dbIntent.metadata || {});
        intent = {
          id: dbIntent.id,
          customerId: dbIntent.customerId,
          provider: dbIntent.provider as any,
          amountCents: Number(dbIntent.amountMinor),
          amountFormatted: fromMinorUnits(Number(dbIntent.amountMinor)),
          currency: dbIntent.currency as SupportedCurrency,
          status: dbIntent.status as any,
          reference: dbIntent.reference || '',
          orderId: meta?.orderId,
          paymentUrl: meta?.paymentUrl,
          destinationAddress: meta?.destinationAddress,
          network: meta?.network || 'BSC',
          tokenContract: meta?.tokenContract || OFFICIAL_BSC_USDT_CONTRACT,
          expiresAt: meta?.expiresAt,
          providerTransactionId: dbIntent.providerTransactionId,
          settledAt: dbIntent.settledAt,
          createdAt: dbIntent.createdAt,
          metadata: meta
        };
      }
    } catch (err: any) {
      return {
        success: false,
        errorCode: 'DATABASE_READ_ERROR',
        message: `Failed querying payment intent from PostgreSQL: ${err.message}`
      };
    }

    if (!intent) {
      return {
        success: false,
        errorCode: 'INTENT_NOT_FOUND',
        message: `Payment Intent '${params.intentId}' does not exist in authoritative PostgreSQL database.`
      };
    }

    if (intent.status === 'VERIFIED' || intent.status === 'SETTLED') {
      return {
        success: false,
        errorCode: 'ALREADY_SETTLED',
        message: `Payment Intent '${params.intentId}' has already been verified and credited.`
      };
    }

    if (
      intent.status === 'EXPIRED' ||
      (intent.expiresAt && new Date(intent.expiresAt).getTime() <= Date.now())
    ) {
      return {
        success: false,
        errorCode: 'INTENT_EXPIRED',
        message: `REJECTED: Payment Intent '${params.intentId}' has expired (${intent.expiresAt || 'EXPIRED'}).`
      };
    }

    // Authoritative Destination Binding: Resolve expected destination EXCLUSIVELY from PostgreSQL intent
    const authoritativeDestination = (
      intent.destinationAddress ||
      intent.metadata?.destinationAddress ||
      ''
    ).trim();

    if (!authoritativeDestination) {
      return {
        success: false,
        errorCode: 'DESTINATION_MISSING',
        message: `REJECTED: Payment Intent '${params.intentId}' has no bound authoritative destination address.`
      };
    }

    const webhookPayload = params.rawPayload || {};
    const webhookSuppliedDest =
      webhookPayload.destinationAddress ??
      webhookPayload.address ??
      webhookPayload.recipient ??
      webhookPayload.to;

    if (
      webhookSuppliedDest !== undefined &&
      String(webhookSuppliedDest).trim() !== '' &&
      String(webhookSuppliedDest).trim().toLowerCase() !== authoritativeDestination.toLowerCase()
    ) {
      return {
        success: false,
        errorCode: 'DESTINATION_MISMATCH',
        message: `REJECTED: Webhook supplied destination '${webhookSuppliedDest}' does not match authoritative PostgreSQL payment intent destination '${authoritativeDestination}'.`
      };
    }

    // Bind the resolved authoritative destination onto the intent object before calling provider.verifyPayment
    intent.destinationAddress = authoritativeDestination;

    const provider = this.getProvider(intent.provider);
    if (!provider) {
      return {
        success: false,
        errorCode: 'PROVIDER_INVALID',
        message: `Provider '${intent.provider}' is invalid.`
      };
    }

    // --- GATE 1: PROVIDER CONFIGURED ---
    if (!provider.isConfigured()) {
      return {
        success: false,
        errorCode: 'PROVIDER_NOT_CONFIGURED',
        message: `REJECTED: Provider '${provider.name}' is not configured with live credentials. Unconfigured provider cannot verify payments.`
      };
    }

    // --- GATE 2: PROVIDER VERIFICATION SUCCEEDED ---
    const verifyResult = await provider.verifyPayment({
      intent,
      providerTransactionId: params.providerTransactionId,
      rawPayload: params.rawPayload,
      signature: params.signature,
      depositRecordsOverride: params.depositRecordsOverride
    });

    if (!verifyResult.verified) {
      const reason = verifyResult.reason || 'Unverified';
      const errorCode = reason.includes('DESTINATION_MISMATCH')
        ? 'DESTINATION_MISMATCH'
        : reason.includes('NETWORK_MISMATCH')
        ? 'NETWORK_MISMATCH'
        : reason.includes('TOKEN_CONTRACT_MISMATCH')
        ? 'TOKEN_CONTRACT_MISMATCH'
        : reason.includes('AMOUNT_MISMATCH')
        ? 'AMOUNT_MISMATCH'
        : reason.includes('INSUFFICIENT_CONFIRMATIONS')
        ? 'INSUFFICIENT_CONFIRMATIONS'
        : reason.includes('PAYMENT_INTENT_EXPIRED')
        ? 'INTENT_EXPIRED'
        : 'PROVIDER_VERIFICATION_FAILED';
      return {
        success: false,
        errorCode,
        message: `REJECTED: Provider cryptographic or API verification failed: ${reason}.`
      };
    }

    // --- GATE 3: PROVIDER TRANSACTION EXISTS ---
    const txId = verifyResult.providerTransactionId || params.providerTransactionId;
    if (!txId || txId.trim() === '') {
      return {
        success: false,
        errorCode: 'TRANSACTION_ID_MISSING',
        message: 'REJECTED: Provider returned no valid transaction identifier.'
      };
    }

    // --- GATE 4: AMOUNT MATCHES INTENT EXACTLY (IN MINOR UNITS) ---
    if (verifyResult.amountCents !== undefined && verifyResult.amountCents !== intent.amountCents) {
      return {
        success: false,
        errorCode: 'AMOUNT_MISMATCH',
        message: `REJECTED: Amount mismatch. Expected ${intent.amountCents} minor units, received ${verifyResult.amountCents} minor units.`
      };
    }

    // --- GATE 5: CURRENCY MATCHES ---
    if (!verifyResult.currency || verifyResult.currency.toUpperCase() !== intent.currency.toUpperCase()) {
      return {
        success: false,
        errorCode: 'CURRENCY_MISMATCH',
        message: `REJECTED: Currency mismatch. Expected ${intent.currency}, received ${verifyResult.currency}.`
      };
    }

    // --- GATE 6: PAYMENT STATUS CONFIRMED ---
    if (verifyResult.status !== 'VERIFIED' && verifyResult.status !== 'SETTLED' && verifyResult.status !== 'CLEARED') {
      return {
        success: false,
        errorCode: 'STATUS_NOT_CONFIRMED',
        message: `REJECTED: Transaction status is '${verifyResult.status}', not VERIFIED, SETTLED or CLEARED.`
      };
    }

    // --- GATE 7: TRANSACTION HAS NOT ALREADY BEEN CREDITED (POSTGRESQL REPLAY PROTECTION) ---
    try {
      const existingTx = await paymentRepo.getProviderTransaction(intent.provider, txId);
      if (existingTx) {
        return {
          success: false,
          errorCode: 'TRANSACTION_ALREADY_CREDITED',
          message: `REJECTED: Transaction '${txId}' has already been recorded in PostgreSQL. Replay attack blocked.`
        };
      }
    } catch (err: any) {
      return {
        success: false,
        errorCode: 'REPLAY_CHECK_FAILED',
        message: `PostgreSQL replay verification failed: ${err.message}`
      };
    }

    // =========================================================================
    // ALL 7 GATES PASSED: ATOMIC COMMIT & DOUBLE-ENTRY LEDGER RECORDING IN POSTGRESQL
    // =========================================================================
    try {
      await paymentRepo.settlePaymentAtomic({
        intentId: intent.id,
        provider: intent.provider,
        providerTransactionId: txId,
        amountMinor: BigInt(intent.amountCents),
        currency: intent.currency,
        status: 'VERIFIED',
        rawPayload: params.rawPayload || {},
        demandOrderId: intent.orderId,
        customerId: intent.customerId
      });
    } catch (settleErr: any) {
      return {
        success: false,
        errorCode: 'SETTLEMENT_COMMIT_FAILED',
        message: `POSTGRESQL_COMMIT_FAILED: Double-entry escrow settlement failed: ${settleErr.message}. Fail closed.`
      };
    }

    const settledAmountMajor = fromMinorUnits(intent.amountCents);
    intent.status = 'VERIFIED';
    intent.providerTransactionId = txId;
    intent.settledAt = new Date().toISOString();

    return {
      success: true,
      message: `Payment verified and atomically settled to PostgreSQL escrow ledger via ${intent.provider}.`,
      intent,
      creditedAmountFormatted: settledAmountMajor
    };
  }

  async getIntent(id: string): Promise<PaymentIntentRecord | undefined> {
    if (!pgDbService.isLiveDatabaseConnected()) {
      return undefined;
    }
    try {
      const dbIntent = await paymentRepo.getPaymentIntent(id);
      if (dbIntent) {
        const meta = typeof dbIntent.metadata === 'string'
          ? JSON.parse(dbIntent.metadata)
          : (dbIntent.metadata || {});
        return {
          id: dbIntent.id,
          customerId: dbIntent.customerId,
          provider: dbIntent.provider as any,
          amountCents: Number(dbIntent.amountMinor),
          amountFormatted: fromMinorUnits(Number(dbIntent.amountMinor)),
          currency: dbIntent.currency as SupportedCurrency,
          status: dbIntent.status as any,
          reference: dbIntent.reference || '',
          orderId: meta?.orderId,
          paymentUrl: meta?.paymentUrl,
          destinationAddress: meta?.destinationAddress,
          network: meta?.network || 'BSC',
          tokenContract: meta?.tokenContract || OFFICIAL_BSC_USDT_CONTRACT,
          expiresAt: meta?.expiresAt,
          providerTransactionId: dbIntent.providerTransactionId,
          settledAt: dbIntent.settledAt,
          createdAt: dbIntent.createdAt,
          metadata: meta
        };
      }
    } catch (err: any) {
      console.warn(`[PAYMENT GET INTENT] PostgreSQL read failed (${err.message})`);
    }
    return undefined;
  }
}

export const paymentEngine = new PaymentEngine();
