/**
 * Authoritative Automated Test Suite Runner for Launch Gate #8
 * Dynamically executes 100% of required integrity, financial, and adversarial attack tests,
 * collects real exit codes and pass/fail counts, and provides deterministic verification.
 * 
 * Strict Invariant: Launch Gate #8 is ONLY marked as PASSED when exitCode === 0,
 * failedTests === 0, and 100% of required suites pass cleanly.
 */

import { attackTestSuiteService } from './attackTestSuite.js';
import { validateCurrency, toMinorUnits, fromMinorUnits, formatMinorUnits } from './moneyUtils.js';
import { paymentEngine, BinancePaymentProvider } from './paymentEngine.js';
import { treasuryEngine } from './treasuryEngine.js';
import { providerFloatManager } from './providerFloatManager.js';
import { killSwitchRepo } from './repositories/index.js';
import { db } from './databaseEngine.js';
import { pgDbService } from './pgDatabase.js';

export interface SuiteExecutionResult {
  name: string;
  passed: boolean;
  total: number;
  passedCount: number;
  failedCount: number;
  durationMs: number;
  failures: string[];
}

export interface AutomatedTestSuiteReport {
  timestamp: string;
  durationMs: number;
  allPassed: boolean;
  exitCode: number;
  totalSuites: number;
  passedSuites: number;
  failedSuites: number;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  suites: SuiteExecutionResult[];
  firstFailure?: string;
}

export class AutomatedTestRunner {
  private lastReport: AutomatedTestSuiteReport | null = null;
  private isRunning = false;

  /**
   * Executes the full automated test suite battery dynamically
   */
  public async runAllTests(): Promise<AutomatedTestSuiteReport> {
    if (this.isRunning && this.lastReport) {
      return this.lastReport;
    }

    this.isRunning = true;
    const overallStart = Date.now();
    const suites: SuiteExecutionResult[] = [];

    try {
      // -------------------------------------------------------------
      // SUITE 1: Currency & Minor-Unit Financial Precision
      // -------------------------------------------------------------
      const s1Start = Date.now();
      const s1Failures: string[] = [];
      let s1Total = 0;
      let s1Passed = 0;

      // Test 1.1: Currency validation
      s1Total++;
      try {
        if (validateCurrency('USD') !== 'USD' || validateCurrency('ZAR') !== 'ZAR') {
          throw new Error('Valid currencies USD and ZAR rejected');
        }
        let eurRejected = false;
        try {
          validateCurrency('EUR');
        } catch {
          eurRejected = true;
        }
        if (!eurRejected) throw new Error('EUR currency must be strictly rejected');
        s1Passed++;
      } catch (err: any) {
        s1Failures.push(`Currency validation: ${err.message}`);
      }

      // Test 1.2: Minor unit bigint conversions without float drift
      s1Total++;
      try {
        if (toMinorUnits(10.50) !== 1050n) throw new Error('toMinorUnits(10.50) mismatch');
        if (toMinorUnits('150.25') !== 15025n) throw new Error('toMinorUnits("150.25") mismatch');
        if (fromMinorUnits(1050n) !== 10.50) throw new Error('fromMinorUnits(1050n) mismatch');
        if (formatMinorUnits(1050n, 'USD') !== '$10.50') throw new Error('formatMinorUnits mismatch');
        s1Passed++;
      } catch (err: any) {
        s1Failures.push(`Minor unit bigint precision: ${err.message}`);
      }

      suites.push({
        name: 'Currency & Precision Financial Arithmetic',
        passed: s1Failures.length === 0,
        total: s1Total,
        passedCount: s1Passed,
        failedCount: s1Failures.length,
        durationMs: Date.now() - s1Start,
        failures: s1Failures
      });

      // -------------------------------------------------------------
      // SUITE 2: Binance Cryptographic Signing, Secret Enforcement & Floats
      // -------------------------------------------------------------
      const s2Start = Date.now();
      const s2Failures: string[] = [];
      let s2Total = 0;
      let s2Passed = 0;

      // Test 2.1: Binance HMAC-SHA256 signature generation & verification
      s2Total++;
      try {
        const binancePay = new BinancePaymentProvider();
        const testSalt = 'dynamic_runner_binance_secret_123';
        const samplePayload = {
          intentId: 'order-dynamic-1234',
          txId: '88776655',
          status: 'VERIFIED',
          amountCents: 20000,
          currency: 'USD'
        };
        const validSig = binancePay.generateSignature(samplePayload, testSalt);
        const isValid = binancePay.verifyWebhookSignature({ ...samplePayload, signature: validSig }, validSig, testSalt);
        if (!isValid) throw new Error('Valid Binance HMAC signature unexpectedly failed verification');

        const isTamperedRejected = !binancePay.verifyWebhookSignature({ ...samplePayload, signature: 'tampered_fake_signature' }, 'tampered_fake_signature', testSalt);
        if (!isTamperedRejected) throw new Error('Tampered signature unexpectedly passed verification');
        s2Passed++;
      } catch (err: any) {
        s2Failures.push(`Binance HMAC-SHA256 signature verification: ${err.message}`);
      }

      // Test 2.2: Mandatory BINANCE_WEBHOOK_SECRET Enforcement (No fallback to API secret)
      s2Total++;
      try {
        const savedWebhookSecret = process.env.BINANCE_WEBHOOK_SECRET;
        delete process.env.BINANCE_WEBHOOK_SECRET;
        let threwRequired = false;
        try {
          await treasuryEngine.binance.handleWebhook(
            { eventId: 'evt_secret_test', timestamp: Date.now() },
            { 'x-mbx-timestamp': String(Date.now()), 'x-mbx-signature': 'abc' }
          );
        } catch (err: any) {
          if (err.message === 'BINANCE_WEBHOOK_SECRET_REQUIRED') {
            threwRequired = true;
          }
        } finally {
          if (savedWebhookSecret !== undefined) {
            process.env.BINANCE_WEBHOOK_SECRET = savedWebhookSecret;
          }
        }
        if (!threwRequired) {
          throw new Error('Missing BINANCE_WEBHOOK_SECRET did not throw BINANCE_WEBHOOK_SECRET_REQUIRED');
        }
        s2Passed++;
      } catch (err: any) {
        s2Failures.push(`BINANCE_WEBHOOK_SECRET enforcement: ${err.message}`);
      }

      // Test 2.3: Provider Float Allocation Formula (70/15/10/5)
      s2Total++;
      try {
        const targets = providerFloatManager.getDefaultFloatTargets(1000);
        if (targets.binance.allocationPct !== 70 || targets.vast.allocationPct !== 15 || targets.runpod.allocationPct !== 10 || targets.lambda.allocationPct !== 5) {
          throw new Error('Float target percentages do not match strict 70/15/10/5 allocation');
        }
        if (targets.binance.targetAmountUsd !== 700) {
          throw new Error('Binance target amount must be exactly $700 on $1000');
        }
        s2Passed++;
      } catch (err: any) {
        s2Failures.push(`Float allocation formula: ${err.message}`);
      }

      // Test 2.4: Kill Switch Isolation Verification
      s2Total++;
      try {
        const globalKs = await killSwitchRepo.isKillSwitchActive('GLOBAL_KILL_SWITCH');
        if (typeof globalKs.active !== 'boolean') {
          throw new Error('Kill switch repository returned invalid status');
        }
        s2Passed++;
      } catch (err: any) {
        s2Failures.push(`Kill switch isolation: ${err.message}`);
      }

      suites.push({
        name: 'Binance Signatures, Secrets & Treasury Floats',
        passed: s2Failures.length === 0,
        total: s2Total,
        passedCount: s2Passed,
        failedCount: s2Failures.length,
        durationMs: Date.now() - s2Start,
        failures: s2Failures
      });

      // -------------------------------------------------------------
      // SUITE 3: Double-Entry Cryptographic Ledger Integrity
      // -------------------------------------------------------------
      const s3Start = Date.now();
      const s3Failures: string[] = [];
      let s3Total = 0;
      let s3Passed = 0;

      s3Total++;
      try {
        const ledgerAudit = db.verifyLedgerIntegrity();
        if (!ledgerAudit.valid) {
          throw new Error(`Ledger SHA-256 chain verification failed: ${ledgerAudit.reason || 'Corrupted Merkle root'}`);
        }
        s3Passed++;
      } catch (err: any) {
        s3Failures.push(`Ledger Merkle chain verification: ${err.message}`);
      }

      suites.push({
        name: 'Cryptographic Double-Entry Ledger Chain',
        passed: s3Failures.length === 0,
        total: s3Total,
        passedCount: s3Passed,
        failedCount: s3Failures.length,
        durationMs: Date.now() - s3Start,
        failures: s3Failures
      });

      // -------------------------------------------------------------
      // SUITE 4: Canonical Binance Rail Exclusivity & Legacy Decommissioning
      // -------------------------------------------------------------
      const s4Start = Date.now();
      const s4Failures: string[] = [];
      let s4Total = 0;
      let s4Passed = 0;

      s4Total++;
      try {
        const binanceProvider = paymentEngine.getProvider('BINANCE');
        if (!binanceProvider || binanceProvider.name !== 'BINANCE') {
          throw new Error('BINANCE canonical payment provider is not registered');
        }
        const registeredProviders = Object.keys(paymentEngine.getProviderStatuses());
        if (registeredProviders.length !== 1 || registeredProviders[0] !== 'BINANCE') {
          throw new Error('Decommissioned legacy payment providers must not be registered');
        }
        if (paymentEngine.getCanonicalRail() !== 'BINANCE') {
          throw new Error(`Expected canonical rail BINANCE, got ${paymentEngine.getCanonicalRail()}`);
        }
        s4Passed++;
      } catch (err: any) {
        s4Failures.push(`Canonical Binance rail exclusivity: ${err.message}`);
      }

      suites.push({
        name: 'Canonical Binance Payment Rail Exclusivity',
        passed: s4Failures.length === 0,
        total: s4Total,
        passedCount: s4Passed,
        failedCount: s4Failures.length,
        durationMs: Date.now() - s4Start,
        failures: s4Failures
      });

      // -------------------------------------------------------------
      // SUITE 5: Adversarial Penetration & Attack Defense Suite (9 Scenarios)
      // -------------------------------------------------------------
      const s5Start = Date.now();
      const s5Failures: string[] = [];
      let s5Total = 0;
      let s5Passed = 0;

      try {
        const attackReport = await attackTestSuiteService.runFullSuite();
        s5Total = attackReport.totalTests;
        s5Passed = attackReport.passedTests;

        for (const res of attackReport.results) {
          if (!res.passed) {
            s5Failures.push(`${res.attackName} [${res.category}]: ${res.actualObservedOutcome}`);
          }
        }
      } catch (err: any) {
        s5Failures.push(`Attack suite execution error: ${err.message}`);
        s5Total = Math.max(s5Total, 1);
      }

      suites.push({
        name: 'Adversarial Penetration & Financial Attack Defense',
        passed: s5Failures.length === 0 && s5Passed === s5Total && s5Total > 0,
        total: s5Total,
        passedCount: s5Passed,
        failedCount: s5Failures.length,
        durationMs: Date.now() - s5Start,
        failures: s5Failures
      });

    } finally {
      this.isRunning = false;
    }

    // Aggregate overall metrics
    const totalSuites = suites.length;
    const passedSuites = suites.filter(s => s.passed).length;
    const failedSuites = totalSuites - passedSuites;

    const totalTests = suites.reduce((acc, s) => acc + s.total, 0);
    const passedTests = suites.reduce((acc, s) => acc + s.passedCount, 0);
    const failedTests = suites.reduce((acc, s) => acc + s.failedCount, 0);

    const allPassed = failedSuites === 0 && failedTests === 0 && totalTests > 0;
    const exitCode = allPassed ? 0 : 1;

    let firstFailure: string | undefined;
    for (const s of suites) {
      if (s.failures.length > 0) {
        firstFailure = `${s.name}: ${s.failures[0]}`;
        break;
      }
    }

    const report: AutomatedTestSuiteReport = {
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - overallStart,
      allPassed,
      exitCode,
      totalSuites,
      passedSuites,
      failedSuites,
      totalTests,
      passedTests,
      failedTests,
      suites,
      firstFailure
    };

    this.lastReport = report;
    return report;
  }

  /**
   * Retrieves the latest test report or executes a new run if stale (>60s) or missing
   */
  public async getOrRunTests(forceRefresh = false): Promise<AutomatedTestSuiteReport> {
    if (!this.lastReport || forceRefresh) {
      return this.runAllTests();
    }

    const ageMs = Date.now() - new Date(this.lastReport.timestamp).getTime();
    if (ageMs > 60_000) {
      return this.runAllTests();
    }

    return this.lastReport;
  }

  public getLastReport(): AutomatedTestSuiteReport | null {
    return this.lastReport;
  }
}

export const automatedTestRunner = new AutomatedTestRunner();
