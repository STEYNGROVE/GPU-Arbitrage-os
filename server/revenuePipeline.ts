import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { financialLedger } from './financialLedger.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REVENUE_STORAGE_PATH = path.resolve(process.env.APP_DATA_DIR || path.join(__dirname, '../data'), 'revenue_pipeline.json');

export type CustomerLifecycleStage =
  | 'LEAD'
  | 'QUOTED'
  | 'ORDERED'
  | 'DELIVERED'
  | 'INVOICED'
  | 'PAID'
  | 'RECONCILED'
  | 'CANCELLED';

export interface CustomerProspect {
  id: string;
  name: string;
  company: string;
  email: string;
  stage: CustomerLifecycleStage;
  targetGpuModel: string;
  nodeCount: number;
  durationHours: number;
  quotedRatePerHourUsd: number;
  totalQuoteAmountUsd: number;
  createdAt: string;
  updatedAt: string;
  notes: string;
}

export interface CustomerInvoice {
  invoiceId: string;
  customerProspectId: string;
  customerName: string;
  customerEmail: string;
  issueDate: string;
  dueDate: string;
  lineItems: Array<{
    description: string;
    gpuModel: string;
    hours: number;
    hourlyRateUsd: number;
    totalUsd: number;
  }>;
  subtotalUsd: number;
  taxUsd: number;
  totalUsd: number;
  currency: 'USD' | 'ZAR';
  exchangeRateZarPerUsd: number;
  totalZar: number;
  status: 'DRAFT' | 'SENT' | 'PAID' | 'VOID' | 'RECONCILED';
  paidAt?: string;
  paymentMethod?: 'BINANCE_PAY' | 'PAYFAST' | 'GOTYME' | 'WIRE_TRANSFER';
  paymentReferenceId?: string;
  deliveryProof?: {
    clusterEndpoint: string;
    assignedNodes: string[];
    provisionedAt: string;
    uptimeSlaAchieved: number;
  };
}

export interface RevenuePipelineSummary {
  totalLeadsCount: number;
  activeQuotesCount: number;
  orderedContractsCount: number;
  deliveredComputeCount: number;
  invoicesIssuedCount: number;
  paidInvoicesCount: number;
  totalQuotedValueUsd: number;
  totalInvoicedValueUsd: number;
  totalCollectedRevenueUsd: number; // Only from verified PAID / RECONCILED invoices
  totalCollectedRevenueZar: number;
  unreconciledRevenueUsd: number;
}

class CustomerRevenueService {
  private prospects: Map<string, CustomerProspect> = new Map();
  private invoices: Map<string, CustomerInvoice> = new Map();

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk() {
    try {
      if (fs.existsSync(REVENUE_STORAGE_PATH)) {
        const raw = fs.readFileSync(REVENUE_STORAGE_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.prospects && Array.isArray(parsed.prospects)) {
          for (const p of parsed.prospects) this.prospects.set(p.id, p);
        }
        if (parsed.invoices && Array.isArray(parsed.invoices)) {
          for (const inv of parsed.invoices) this.invoices.set(inv.invoiceId, inv);
        }
      }
    } catch (err: any) {
      console.warn('[Revenue Pipeline] Disk notice:', err.message);
    }
  }

  private persistToDisk() {
    try {
      const dataDir = path.dirname(REVENUE_STORAGE_PATH);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      const data = {
        prospects: Array.from(this.prospects.values()),
        invoices: Array.from(this.invoices.values()),
        lastSavedAt: new Date().toISOString(),
      };
      fs.writeFileSync(REVENUE_STORAGE_PATH, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err: any) {
      console.error('[Revenue Pipeline] Persist error:', err.message);
    }
  }

  public createProspectLead(params: {
    name: string;
    company: string;
    email: string;
    targetGpuModel: string;
    nodeCount: number;
    durationHours: number;
    quotedRatePerHourUsd: number;
    notes?: string;
  }): CustomerProspect {
    const id = `LEAD-${Date.now().toString(36).toUpperCase()}`;
    const totalQuote = Number((params.nodeCount * params.durationHours * params.quotedRatePerHourUsd).toFixed(2));
    const now = new Date().toISOString();

    const prospect: CustomerProspect = {
      id,
      name: params.name,
      company: params.company,
      email: params.email,
      stage: 'LEAD',
      targetGpuModel: params.targetGpuModel,
      nodeCount: params.nodeCount,
      durationHours: params.durationHours,
      quotedRatePerHourUsd: params.quotedRatePerHourUsd,
      totalQuoteAmountUsd: totalQuote,
      createdAt: now,
      updatedAt: now,
      notes: params.notes || 'Inbound GPU compute lease enquiry',
    };

    this.prospects.set(id, prospect);
    this.persistToDisk();
    return prospect;
  }

  public updateProspectStage(prospectId: string, stage: CustomerLifecycleStage, notes?: string): CustomerProspect {
    const prospect = this.prospects.get(prospectId);
    if (!prospect) {
      throw new Error(`Prospect with ID ${prospectId} not found.`);
    }

    prospect.stage = stage;
    prospect.updatedAt = new Date().toISOString();
    if (notes) prospect.notes = `${prospect.notes} | ${notes}`;

    this.persistToDisk();
    return prospect;
  }

  public generateInvoice(params: {
    customerProspectId: string;
    dueDateDays?: number;
    currency?: 'USD' | 'ZAR';
  }): CustomerInvoice {
    const prospect = this.prospects.get(params.customerProspectId);
    if (!prospect) {
      throw new Error(`Cannot invoice: Prospect ${params.customerProspectId} not found.`);
    }

    const invoiceId = `INV-${Date.now().toString(36).toUpperCase()}`;
    const now = new Date();
    const dueDate = new Date(now.getTime() + (params.dueDateDays || 7) * 24 * 3600 * 1000);

    const totalHours = prospect.durationHours;
    const subtotal = Number((prospect.nodeCount * totalHours * prospect.quotedRatePerHourUsd).toFixed(2));
    const tax = 0; // B2B export cross-border compute typically zero-rated
    const totalUsd = subtotal + tax;

    const exchangeRateZarPerUsd = Number(process.env.USD_ZAR_RATE);
    if (!Number.isFinite(exchangeRateZarPerUsd) || exchangeRateZarPerUsd <= 0) throw new Error('Configure a dated USD_ZAR_RATE before invoicing.');
    const totalZar = Number((totalUsd * exchangeRateZarPerUsd).toFixed(2));

    const invoice: CustomerInvoice = {
      invoiceId,
      customerProspectId: prospect.id,
      customerName: prospect.name,
      customerEmail: prospect.email,
      issueDate: now.toISOString().split('T')[0],
      dueDate: dueDate.toISOString().split('T')[0],
      lineItems: [
        {
          description: `Dedicated Compute Allocation: ${prospect.nodeCount}x ${prospect.targetGpuModel} (${totalHours} hrs)`,
          gpuModel: prospect.targetGpuModel,
          hours: totalHours,
          hourlyRateUsd: prospect.quotedRatePerHourUsd,
          totalUsd: subtotal,
        },
      ],
      subtotalUsd: subtotal,
      taxUsd: tax,
      totalUsd,
      currency: params.currency || 'USD',
      exchangeRateZarPerUsd,
      totalZar,
      status: 'DRAFT',
    };

    this.invoices.set(invoiceId, invoice);
    prospect.stage = 'INVOICED';
    prospect.updatedAt = new Date().toISOString();

    this.persistToDisk();
    return invoice;
  }

  public recordDeliveryEvidence(params: {
    invoiceId: string;
    clusterEndpoint: string;
    assignedNodes: string[];
    uptimeSlaAchieved: number;
  }): CustomerInvoice {
    const invoice = this.invoices.get(params.invoiceId);
    if (!invoice) throw new Error(`Invoice ${params.invoiceId} not found.`);

    invoice.deliveryProof = {
      clusterEndpoint: params.clusterEndpoint,
      assignedNodes: params.assignedNodes,
      provisionedAt: new Date().toISOString(),
      uptimeSlaAchieved: params.uptimeSlaAchieved,
    };

    const prospect = this.prospects.get(invoice.customerProspectId);
    if (prospect) {
      prospect.stage = 'DELIVERED';
      prospect.updatedAt = new Date().toISOString();
    }

    this.persistToDisk();
    return invoice;
  }

  public recordInvoicePayment(params: {
    invoiceId: string;
    paymentMethod: CustomerInvoice['paymentMethod'];
    paymentReferenceId: string;
    amountPaid: number;
    currency: 'USD' | 'ZAR';
  }): CustomerInvoice {
    const invoice = this.invoices.get(params.invoiceId);
    if (!invoice) throw new Error(`Invoice ${params.invoiceId} not found.`);

    const receipt = financialLedger.getAllEntries().find(e =>
      e.providerTransactionId === params.paymentReferenceId && e.state === 'CONFIRMED' &&
      e.verificationStatus === 'VERIFIED' && !e.isSimulated &&
      e.type === 'CUSTOMER_INVOICE_RECEIPT' && e.metadata?.invoiceId === invoice.invoiceId);
    const expected = params.currency === 'ZAR' ? invoice.totalZar : invoice.totalUsd;
    if (!receipt || receipt.asset !== params.currency || !Number.isFinite(params.amountPaid) ||
        Math.abs(receipt.amount - expected) > 0.001 || Math.abs(params.amountPaid - expected) > 0.001) {
      throw new Error('Payment requires an independently verified, matching invoice receipt.');
    }
    invoice.status = 'RECONCILED'; invoice.paidAt = receipt.timestamp;
    invoice.paymentMethod = params.paymentMethod; invoice.paymentReferenceId = params.paymentReferenceId;
    const prospect = this.prospects.get(invoice.customerProspectId);
    if (prospect) { prospect.stage = 'RECONCILED'; prospect.updatedAt = new Date().toISOString(); }

    this.persistToDisk();
    return invoice;
  }

  public getSummary(): RevenuePipelineSummary {
    const prospectsList = Array.from(this.prospects.values());
    const invoicesList = Array.from(this.invoices.values());

    const paidInvoices = invoicesList.filter(inv => inv.status === 'RECONCILED' && financialLedger.getAllEntries().some(e => e.metadata?.invoiceId === inv.invoiceId && e.providerTransactionId === inv.paymentReferenceId && e.state === 'CONFIRMED' && !e.isSimulated && e.verificationStatus === 'VERIFIED'));
    const totalCollectedRevenueUsd = paidInvoices.reduce((sum, inv) => sum + inv.totalUsd, 0);
    const totalCollectedRevenueZar = paidInvoices.reduce((sum, inv) => sum + inv.totalZar, 0);

    const totalQuotedValueUsd = prospectsList.reduce((sum, p) => sum + p.totalQuoteAmountUsd, 0);
    const totalInvoicedValueUsd = invoicesList.reduce((sum, inv) => sum + inv.totalUsd, 0);

    return {
      totalLeadsCount: prospectsList.length,
      activeQuotesCount: prospectsList.filter((p) => p.stage === 'QUOTED').length,
      orderedContractsCount: prospectsList.filter((p) => p.stage === 'ORDERED').length,
      deliveredComputeCount: prospectsList.filter((p) => p.stage === 'DELIVERED').length,
      invoicesIssuedCount: invoicesList.length,
      paidInvoicesCount: paidInvoices.length,
      totalQuotedValueUsd: Number(totalQuotedValueUsd.toFixed(2)),
      totalInvoicedValueUsd: Number(totalInvoicedValueUsd.toFixed(2)),
      totalCollectedRevenueUsd: Number(totalCollectedRevenueUsd.toFixed(2)), // ONLY from verified paid invoices!
      totalCollectedRevenueZar: Number(totalCollectedRevenueZar.toFixed(2)),
      unreconciledRevenueUsd: Number(Math.max(0, totalInvoicedValueUsd - totalCollectedRevenueUsd).toFixed(2)),
    };
  }

  public getAllProspects(): CustomerProspect[] {
    return Array.from(this.prospects.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  public getAllInvoices(): CustomerInvoice[] {
    return Array.from(this.invoices.values()).sort(
      (a, b) => new Date(b.issueDate).getTime() - new Date(a.issueDate).getTime()
    );
  }
}

export const customerRevenueService = new CustomerRevenueService();
