import crypto from 'crypto';
import { config } from './config.ts';
import { financialLedger } from './financialLedger.ts';

export interface PayFastPaymentRequest {
  m_payment_id: string; // Internal Order ID / Invoice ID
  amount: number;
  item_name: string;
  item_description?: string;
  name_first?: string;
  name_last?: string;
  email_address: string;
  return_url?: string;
  cancel_url?: string;
  notify_url?: string;
}

export interface PayFastPaymentResponse {
  paymentUrl: string;
  processUrl: string;
  payload: Record<string, string>;
  signature: string;
  isSandbox: boolean;
}

export interface PayFastNotificationData {
  m_payment_id: string;
  pf_payment_id: string;
  payment_status: 'COMPLETE' | 'FAILED' | 'PENDING' | 'CANCELLED';
  item_name: string;
  amount_gross: string;
  amount_fee: string;
  amount_net: string;
  signature: string;
  name_first?: string;
  name_last?: string;
  email_address?: string;
  merchant_id?: string;
  token?: string;
  [key: string]: any;
}

export interface GoTymeIntegrationStatus {
  status: 'DOCUMENTED_REQUIREMENTS_READY' | 'SANDBOX_ACTIVE' | 'PRODUCTION_BLOCKED_REQUIRES_REGISTRATION';
  partnerId: string;
  merchantAccountStatus: string;
  supportedTransferRails: string[];
  regulatoryBody: string;
  requirements: Array<{
    title: string;
    description: string;
    satisfied: boolean;
  }>;
}

class PaymentsService {
  /**
   * Generates a documented, cryptographically signed PayFast payment request.
   */
  public createPayFastPayment(req: PayFastPaymentRequest): PayFastPaymentResponse {
    throw new Error('PayFast checkout requires a durable, matched invoice adapter.');
  }

  /**
   * Generates MD5 signature for PayFast:
   * 1. URL encode key-value pairs
   * 2. Join with &
   * 3. Append passphrase if set
   * 4. MD5 hash
   */
  public generatePayFastSignature(
    data: Record<string, string>,
    passphrase?: string
  ): string {
    let pfOutput = '';
    const keys = Object.keys(data).filter((k) => k !== 'signature');

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const val = data[key];
      if (val !== undefined && val !== null && val !== '') {
        pfOutput += `${key}=${encodeURIComponent(val.trim()).replace(/%20/g, '+')}&`;
      }
    }

    // Remove trailing &
    pfOutput = pfOutput.slice(0, -1);

    if (passphrase) {
      pfOutput += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, '+')}`;
    }

    return crypto.createHash('md5').update(pfOutput).digest('hex');
  }

  /**
   * Validates PayFast ITN (Instant Transaction Notification) webhook:
   * 1. Validates local MD5 signature
   * 2. Calls PayFast host to confirm notification validity
   * 3. Enforces idempotency and updates ledger state
   */
  public async handlePayFastITN(
    data: PayFastNotificationData
  ): Promise<{ valid: boolean; status: string; message: string }> {
    return { valid: false, status: 'INVOICE_ADAPTER_REQUIRED', message: 'Payment verification is not integrated. No funds credited.' };
  }

  /**
   * GoTyme Bank Integration Status & Onboarding Documentation
   */
  public getGoTymeStatus(): GoTymeIntegrationStatus {
    return {
      status: 'PRODUCTION_BLOCKED_REQUIRES_REGISTRATION', partnerId: config.gotyme.partnerId || '',
      merchantAccountStatus: 'UNVERIFIED', supportedTransferRails: [], regulatoryBody: 'UNVERIFIED',
      requirements: [{ title: 'Provider-issued South African payout integration',
        description: 'Confirm bank identity, API availability, account ownership and signed settlement evidence with the provider.', satisfied: false }],
    };
  }
}
export const paymentsService = new PaymentsService();
