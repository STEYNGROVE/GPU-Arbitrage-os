/**
 * Strict Financial Calculation & Minor Unit (Cents) Precision Utilities
 * BANS floating-point inaccuracies for ledger, payment, and treasury operations.
 * Enforces strict two-currency clearinghouse support: USD and ZAR.
 */

export type SupportedCurrency = 'USD' | 'ZAR';

export const SUPPORTED_CURRENCIES: SupportedCurrency[] = ['USD', 'ZAR'];

/**
 * Canonical Reconciliation Status:
 * Strictly enforced across database, reconciliation engine, treasury engine,
 * system readiness, API contracts, frontend, and test suites.
 */
export type CanonicalReconciliationStatus =
  | 'UNVERIFIED'
  | 'RECONCILIATION_REQUIRED'
  | 'RECONCILED'
  | 'STALE'
  | 'DISCREPANCY'
  | 'ERROR';

export const CANONICAL_RECONCILIATION_STATUSES: CanonicalReconciliationStatus[] = [
  'UNVERIFIED',
  'RECONCILIATION_REQUIRED',
  'RECONCILED',
  'STALE',
  'DISCREPANCY',
  'ERROR'
];

/**
 * Canonical Payment State:
 * Single canonical payment state model across the application.
 */
export type CanonicalPaymentState =
  | 'CREATED'
  | 'PENDING'
  | 'VERIFIED'
  | 'SETTLED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REFUNDED'
  | 'DISPUTED'
  | 'RECONCILIATION_REQUIRED';

export const CANONICAL_PAYMENT_STATES: CanonicalPaymentState[] = [
  'CREATED',
  'PENDING',
  'VERIFIED',
  'SETTLED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
  'DISPUTED',
  'RECONCILIATION_REQUIRED'
];

export interface VerifiedSpendableCapitalParams {
  binanceAvailableMinor: bigint;
  customerReservedMinor: bigint;
  pendingOutflowsMinor: bigint;
  accruedProviderCostsMinor: bigint;
  estimatedRemainingProviderCostsMinor: bigint;
  contractualMaxExposureMinor: bigint;
  pendingProviderChargesMinor: bigint;
  minBinanceReserveMinor: bigint;
  riskBufferMinor: bigint;
  unresolvedReconciliationExposureMinor: bigint;
}

/**
 * Verified Spendable Capital:
 * Only verified spendable capital may support new autonomous commitments.
 *
 * verifiedSpendableCapital =
 *   Binance available balance
 *   - customer reserved capital
 *   - pending outflows
 *   - accrued provider costs
 *   - estimated remaining provider costs
 *   - contractual maximum exposure
 *   - pending provider charges
 *   - minimum Binance reserve
 *   - risk buffer
 *   - unresolved reconciliation exposure
 */
export function calculateVerifiedSpendableCapital(params: VerifiedSpendableCapitalParams): bigint {
  const deductions =
    params.customerReservedMinor +
    params.pendingOutflowsMinor +
    params.accruedProviderCostsMinor +
    params.estimatedRemainingProviderCostsMinor +
    params.contractualMaxExposureMinor +
    params.pendingProviderChargesMinor +
    params.minBinanceReserveMinor +
    params.riskBufferMinor +
    params.unresolvedReconciliationExposureMinor;

  const spendable = params.binanceAvailableMinor - deductions;
  return spendable > 0n ? spendable : 0n;
}

// Global BigInt JSON serialization polyfill
if (typeof (BigInt.prototype as any).toJSON !== 'function') {
  (BigInt.prototype as any).toJSON = function () {
    const num = Number(this);
    return Number.isSafeInteger(num) ? num : this.toString();
  };
}

export function safeJsonStringify(obj: any, space?: number | string): string {
  return JSON.stringify(
    obj,
    (_, v) => (typeof v === 'bigint' ? (Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()) : v),
    space
  );
}

/**
 * Validates currency string against strict clearinghouse whitelist.
 * Explicitly rejects EUR and any other unsupported currency.
 */
export function validateCurrency(curr: string): SupportedCurrency {
  const upper = (curr || '').trim().toUpperCase();
  if (upper === 'USD' || upper === 'ZAR') {
    return upper as SupportedCurrency;
  }
  throw new Error(
    `UNSUPPORTED_CURRENCY: Currency '${curr}' is not supported. The clearinghouse strictly enforces USD and ZAR only. EUR and unbonded currencies are prohibited.`
  );
}

/**
 * Converts a major currency value (e.g. $10.50 or R150.25) to exact integer minor units (cents).
 * e.g. 10.50 -> 1050n
 */
export function toMinorUnits(amountMajor: number | string | bigint): bigint {
  if (typeof amountMajor === 'bigint') {
    return amountMajor;
  }
  if (typeof amountMajor === 'string') {
    const trimmed = amountMajor.trim();
    if (!trimmed) return 0n;
    const match = trimmed.match(/^(-)?(\d+)(?:\.(\d+))?$/);
    if (match) {
      const isNegative = match[1] === '-';
      const intPart = BigInt(match[2]);
      const fracRaw = match[3] || '';
      let fracCents = 0n;
      if (fracRaw.length >= 2) {
        const centsStr = fracRaw.slice(0, 2);
        fracCents = BigInt(centsStr);
        if (fracRaw.length >= 3 && Number(fracRaw[2]) >= 5) {
          fracCents += 1n;
        }
      } else if (fracRaw.length === 1) {
        fracCents = BigInt(fracRaw) * 10n;
      }
      const res = intPart * 100n + fracCents;
      return isNegative ? -res : res;
    }
    throw new Error(`Invalid monetary amount format: ${amountMajor}`);
  }
  if (typeof amountMajor === 'number') {
    if (isNaN(amountMajor)) throw new Error('Monetary amount is NaN');
    const fixed = amountMajor.toFixed(2);
    const match = fixed.match(/^(-)?(\d+)\.(\d{2})$/);
    if (match) {
      const isNegative = match[1] === '-';
      const intPart = BigInt(match[2]);
      const fracPart = BigInt(match[3]);
      const res = intPart * 100n + fracPart;
      return isNegative ? -res : res;
    }
    return BigInt(Math.round(amountMajor * 100));
  }
  throw new Error(`Invalid monetary type: ${typeof amountMajor}`);
}

/**
 * Converts integer minor units (cents) to a standard float for display formatting.
 * e.g. 1050n -> 10.50
 */
export function fromMinorUnits(cents: bigint | number): number {
  if (typeof cents === 'bigint') {
    return Number(cents) / 100;
  }
  return Math.round(cents) / 100;
}

/**
 * Formats minor units to currency string
 */
export function formatMinorUnits(cents: bigint | number, currency: SupportedCurrency = 'USD'): string {
  const value = fromMinorUnits(cents);
  const symbol = currency === 'USD' ? '$' : 'R';
  return `${symbol}${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
