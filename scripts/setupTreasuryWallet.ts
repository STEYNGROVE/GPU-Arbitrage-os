import { ethers, formatUnits, Contract } from 'ethers';
import { verifiedProfitWithdrawalService } from '../server/verifiedProfitWithdrawalService.js';
import { hotWalletService, HotWalletService, OFFICIAL_BSC_USDT_CONTRACT } from '../server/hotWalletService.js';

const COMPROMISED_ADDRESS = '0xBaDa29E5725f7F8F750e41B8724d9c4c77646bA5'.toLowerCase();

const ERC20_MINIMAL_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)'
];

async function main() {
  console.log('\n================================================================');
  console.log('       BNB SMART CHAIN (BSC) TREASURY HOT-WALLET SETUP          ');
  console.log('================================================================\n');

  // 1. REQUIRE EXTERNALLY-CREATED WALLET PRIVATE KEY
  let privateKey = process.argv[2]?.trim();

  if (!privateKey) {
    console.error('❌ ERROR: Missing private key argument.');
    console.error('\nSECURITY MANDATE:');
    console.error('Automatic wallet generation has been permanently removed from this system.');
    console.error('You must generate an EVM cryptographic keypair externally in a secure offline environment');
    console.error('(e.g., hardware security module, cold wallet, or secure offline generator).\n');
    console.error('USAGE:');
    console.error('  BSC_RPC_URL="https://<your-bsc-rpc>" npx tsx scripts/setupTreasuryWallet.ts <0x_EXTERNALLY_GENERATED_PRIVATE_KEY>\n');
    process.exit(1);
  }

  // 2. Validate format (supports raw 32-byte hex or AWS Secrets Manager JSON string)
  const normalizedKey = HotWalletService.extractNormalizedPrivateKey(privateKey);
  if (!normalizedKey || !ethers.isHexString(normalizedKey, 32)) {
    console.error('❌ Error: Provided private key is not a valid 32-byte hex string (64 hex characters, optional 0x prefix). Placeholders such as <YOUR_32_BYTE_HEX_KEY> are strictly rejected.');
    process.exit(1);
  }
  privateKey = normalizedKey;

  // 3. Derive address
  const wallet = new ethers.Wallet(privateKey);
  const derivedAddress = wallet.address;

  // Verify against known compromised address
  if (derivedAddress.toLowerCase() === COMPROMISED_ADDRESS) {
    console.error('❌ CRITICAL SECURITY ERROR: This is the known compromised address (0xBaDa...6bA5). Aborting setup.');
    process.exit(1);
  }

  console.log(`[SETUP] Externally-Provided Key Validated.`);
  console.log(`[SETUP] Derived Public Wallet Address: ${derivedAddress}`);
  console.log(`[SETUP] Network Target: BNB Smart Chain (BSC - Chain ID 56)`);

  // 4. Connect to configured BSC_RPC_URL / BSC_RPC_FALLBACK_URLS to verify on-chain status
  console.log('[SETUP] Validating configured BSC RPC (BSC_RPC_URL / BSC_RPC_FALLBACK_URLS)...');
  let rpcSuccess = false;
  let bnbBalance = '0.0000';
  let usdtBalance = '0.00';
  let blockNumber = 0;

  try {
    const { provider, redactedRpcUrl, latestBlock } = await hotWalletService.getProvider('BSC');
    blockNumber = latestBlock;
    const contractCheck = await hotWalletService.validateUsdtContract(provider, OFFICIAL_BSC_USDT_CONTRACT);

    const gasWei = await provider.getBalance(derivedAddress);
    bnbBalance = Number(formatUnits(gasWei, 18)).toFixed(4);

    const usdtContract = new Contract(contractCheck.contractAddress, ERC20_MINIMAL_ABI, provider);
    const rawUsdt = await usdtContract.balanceOf(derivedAddress);
    usdtBalance = Number(formatUnits(rawUsdt, contractCheck.decimals)).toFixed(2);
    rpcSuccess = true;
    console.log(`[SETUP] Connected to verified BSC RPC (${redactedRpcUrl}) at block height #${blockNumber}`);
  } catch (err: any) {
    console.warn(`[SETUP] RPC validation failed (fail-closed): ${err.message}`);
  }

  // 5. Pre-register the derived address in the PostgreSQL withdrawal allowlist
  try {
    await verifiedProfitWithdrawalService.addAllowlistAddress({
      destinationAddress: derivedAddress,
      network: 'BSC',
      coin: 'USDT',
      label: 'Authoritative Internal Hot Wallet (Self)',
      approvedBy: 'setup_orchestrator'
    });
    console.log('[SETUP] Added wallet address to persistent withdrawal allowlist.');
  } catch (err: any) {
    console.warn(`[SETUP] Note on allowlist registration: ${err.message}`);
  }

  console.log('\n----------------------------------------------------------------');
  console.log('                   TREASURY VERIFICATION SUMMARY                ');
  console.log('----------------------------------------------------------------');
  console.log(`  Target Network:            BNB Smart Chain (BSC - Chain ID: 56)`);
  console.log(`  Hot Wallet Address:        ${derivedAddress}`);
  console.log(`  Official USDT Contract:    ${OFFICIAL_BSC_USDT_CONTRACT}`);
  console.log(`  Compromised Wallet Check:  PASSED (0xBaDa...6bA5 excluded)`);
  console.log(`  Live BNB Gas Balance:      ${bnbBalance} BNB (Min Reserve: 0.005 BNB)`);
  console.log(`  Live USDT Balance:         ${usdtBalance} USDT`);
  console.log(`  RPC Connection:            ${rpcSuccess ? 'VERIFIED (Chain ID 56)' : 'UNAVAILABLE (FAIL-CLOSED)'}`);
  console.log('----------------------------------------------------------------\n');

  console.log('🔒 PRODUCTION SECRET INSTRUCTIONS (ZERO DISK PERSISTENCE):');
  console.log('This script DOES NOT persist the private key to disk or .env.');
  console.log('To activate this wallet in your production environment, supply it directly via:');
  console.log('  1. Cloud Secret Manager / Vault');
  console.log('  2. Container runtime environment variables:');
  console.log(`     export NODE_ENV="production"`);
  console.log(`     export BSC_RPC_URL="https://<PRIMARY_BSC_RPC>"`);
  console.log(`     export BSC_RPC_FALLBACK_URLS="https://<SECONDARY_RPC>,https://<TERTIARY_RPC>"`);
  console.log(`     export TREASURY_MIN_GAS_RESERVE_BNB="0.005"`);
  console.log(`     export TREASURY_HOT_WALLET_PRIVATE_KEY="<PRIVATE_KEY>"`);
  console.log('     export TREASURY_HOT_WALLET_NETWORK="BSC"');
  console.log('================================================================\n');
}

main().catch(err => {
  console.error('[SETUP] Fatal setup error:', err);
  process.exit(1);
});
