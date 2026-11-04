export * from './types.js';
export * from './baseRepo.js';
export * from './customerAndAuthRepo.js';
export * from './demandQuotePaymentRepo.js';
export * from './treasuryAndReservationRepo.js';
export * from './operationJobSettlementOutboxRepo.js';
export * from './auditIdempotencyKillSwitchRepo.js';

import { CustomerRepository, AuthRepository } from './customerAndAuthRepo.js';
import { DemandOrderRepository, QuoteRepository, PaymentRepository, EscrowRepository } from './demandQuotePaymentRepo.js';
import { TreasuryRepository, ReservationRepository } from './treasuryAndReservationRepo.js';
import {
  ProviderOperationRepository,
  ComputeJobRepository,
  SettlementRepository,
  OutboxRepository
} from './operationJobSettlementOutboxRepo.js';
import {
  IdempotencyRepository,
  AuditRepository,
  ReconciliationRepository,
  KillSwitchRepository
} from './auditIdempotencyKillSwitchRepo.js';

export const customerRepo = new CustomerRepository();
export const authRepo = new AuthRepository();
export const demandOrderRepo = new DemandOrderRepository();
export const quoteRepo = new QuoteRepository();
export const paymentRepo = new PaymentRepository();
export const escrowRepo = new EscrowRepository();
export const treasuryRepo = new TreasuryRepository();
export const reservationRepo = new ReservationRepository();
export const providerOperationRepo = new ProviderOperationRepository();
export const computeJobRepo = new ComputeJobRepository();
export const settlementRepo = new SettlementRepository();
export const outboxRepo = new OutboxRepository();
export const idempotencyRepo = new IdempotencyRepository();
export const auditRepo = new AuditRepository();
export const reconciliationRepo = new ReconciliationRepository();
export const killSwitchRepo = new KillSwitchRepository();
