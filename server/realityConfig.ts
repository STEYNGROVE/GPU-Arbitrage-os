/**
 * Authoritative Reality Level & Production Mode Enforcement (Requirement 1 & 3)
 *
 * Enforces strict LIVE operation in production and when REALITY_LEVEL=LIVE.
 * Prevents any mock/demo/paper financial execution, synthetic customers, jobs,
 * GPU instances, balances, or local JSON financial fallbacks from entering production.
 */

export type RealityLevel = 'LIVE' | 'DEVELOPMENT';

export interface RealityConfigStatus {
  mode: RealityLevel;
  realityLevel: RealityLevel;
  nodeEnv: string;
  isProduction: boolean;
  isStrictLive: boolean;
  allowLocalJsonFallback: boolean;
  allowSyntheticSeedData: boolean;
  allowDevAuthBypass: boolean;
  violations: string[];
}

/**
 * Evaluates the current runtime reality level.
 * Defaults to 'LIVE' unless explicitly running in non-production with REALITY_LEVEL=DEVELOPMENT.
 */
export function getRealityLevel(): RealityLevel {
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) {
    return 'LIVE';
  }
  const raw = (process.env.REALITY_LEVEL || process.env.EXECUTION_MODE || 'LIVE').trim().toUpperCase();
  if (raw === 'DEVELOPMENT' || raw === 'DEV_TEST') {
    return 'DEVELOPMENT';
  }
  return 'LIVE';
}

/**
 * Returns true when running in production (`NODE_ENV === 'production'`).
 */
export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Returns true when strict LIVE reality rules apply (always true in production or when REALITY_LEVEL=LIVE).
 */
export function isStrictLiveReality(): boolean {
  return isProductionEnv() || getRealityLevel() === 'LIVE';
}

/**
 * JSON/local financial fallback is strictly development-only and only permitted when
 * NODE_ENV !== 'production' AND REALITY_LEVEL === 'DEVELOPMENT' (or during isolated unit tests that explicitly opt in).
 */
export function isLocalJsonFallbackAllowed(): boolean {
  if (process.env.NODE_ENV === 'production') {
    return false;
  }
  if (process.env.REALITY_LEVEL && process.env.REALITY_LEVEL.trim().toUpperCase() === 'LIVE') {
    return false;
  }
  return process.env.ALLOW_DEV_JSON_FALLBACK === 'true';
}

/**
 * Asserts that no mock/paper/simulation configuration is active in production.
 */
export function evaluateRealityGate(): RealityConfigStatus {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  const realityLevel = getRealityLevel();
  const isStrictLive = isStrictLiveReality();
  const violations: string[] = [];

  const rawReality = (process.env.REALITY_LEVEL || 'LIVE').trim().toUpperCase();
  if (isProduction && rawReality !== 'LIVE' && rawReality !== 'STRICT' && rawReality !== 'PRODUCTION') {
    violations.push(`REALITY_LEVEL is set to '${rawReality}' in production; must be 'LIVE'.`);
  }

  const rawExecMode = (process.env.EXECUTION_MODE || 'LIVE').trim().toUpperCase();
  if (isProduction && (rawExecMode === 'PAPER' || rawExecMode === 'SIMULATION' || rawExecMode === 'MOCK' || rawExecMode === 'DEMO')) {
    violations.push(`EXECUTION_MODE='${rawExecMode}' is forbidden in production.`);
  }

  if (isProduction && process.env.ALLOW_PREVIEW_SESSION === 'true') {
    violations.push('ALLOW_PREVIEW_SESSION=true is forbidden in production.');
  }

  if (isProduction && process.env.ALLOW_DEV_JSON_FALLBACK === 'true') {
    violations.push('ALLOW_DEV_JSON_FALLBACK=true is forbidden in production.');
  }

  return {
    mode: realityLevel,
    realityLevel,
    nodeEnv,
    isProduction,
    isStrictLive,
    allowLocalJsonFallback: isLocalJsonFallbackAllowed(),
    allowSyntheticSeedData: false,
    allowDevAuthBypass: !isProduction && process.env.ALLOW_DEV_SESSION_BYPASS === 'true',
    violations
  };
}

export const getRealityConfiguration = evaluateRealityGate;

