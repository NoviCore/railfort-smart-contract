// scripts/deploy-mainnet.js
//
// Usage:
//   node scripts/deploy-mainnet.js              — dry run (validates config, shows plan, no TRX spent)
//   node scripts/deploy-mainnet.js --broadcast  — deploy for real on TRON mainnet
//
// Before running:
//   1. Copy scripts/deployment-config.example.json → scripts/deployment-config.json and fill in values
//   2. Set PRIVATE_KEY_MAINNET and MAINNET_RPC_URL in .env
//   3. Run: node scripts/deploy-mainnet.js        (verify the plan looks right)
//   4. Run: node scripts/deploy-mainnet.js --broadcast

require('dotenv').config();
const { TronWeb } = require('tronweb');
const fs          = require('fs');
const path        = require('path');

const BROADCAST = process.argv.includes('--broadcast');

// ─── Load config and ABIs ─────────────────────────────────────────────────────

const configPath = path.join(__dirname, 'deployment-config.json');
if (!fs.existsSync(configPath)) {
  console.error('ERROR: scripts/deployment-config.json not found.');
  console.error('       Copy scripts/deployment-config.example.json and fill in your values.');
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const ARTIFACTS_DIR = path.join(__dirname, '..', 'build', 'contracts');
const factoryArtifact = JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, 'SpendingManagerFactory.json')));
const managerArtifact = JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, 'SpendingManager.json')));
const erc20Artifact   = JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, 'ITRC20.json')));

// ─── TronWeb ─────────────────────────────────────────────────────────────────

const PRIVATE_KEY = process.env.PRIVATE_KEY_MAINNET;
const RPC_URL     = process.env.MAINNET_RPC_URL || 'https://api.trongrid.io';

if (!PRIVATE_KEY) {
  console.error('ERROR: PRIVATE_KEY_MAINNET is not set in .env');
  process.exit(1);
}

const tronWeb = new TronWeb({
  fullHost:   RPC_URL,
  privateKey: PRIVATE_KEY,
});

const DEPLOYER = tronWeb.defaultAddress.base58;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const USDT_DECIMALS = 6;
const fmt = (n) => (Number(n) / 10 ** USDT_DECIMALS).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' USDT';
const sep = () => console.log('─'.repeat(60));

function isTronAddress(addr) {
  // tronweb v6 moved isAddress from tronWeb.utils to the static TronWeb class
  try { return TronWeb.isAddress(addr); } catch { return false; }
}

// ─── Config validation ────────────────────────────────────────────────────────

function validateConfig() {
  const errors = [];

  if (!isTronAddress(cfg.token))          errors.push('token is not a valid TRON address');
  if (!isTronAddress(cfg.corporateOwner)) errors.push('corporateOwner is not a valid TRON address');

  if (!Array.isArray(cfg.managers) || cfg.managers.length === 0)
    errors.push('managers must be a non-empty array');

  const n = cfg.managers.length;
  const arrayFields = ['weights', 'dailyLimits', 'weeklyLimits', 'monthlyLimits', 'totalLimits'];
  for (const f of arrayFields) {
    if (!Array.isArray(cfg[f]) || cfg[f].length !== n)
      errors.push(`${f} must be an array of length ${n} (same as managers)`);
  }

  cfg.managers.forEach((m, i) => {
    if (!isTronAddress(m)) errors.push(`managers[${i}] is not a valid TRON address: ${m}`);
  });

  if (!Array.isArray(cfg.tiers) || cfg.tiers.length === 0)
    errors.push('tiers must be a non-empty array');
  else {
    for (let i = 1; i < cfg.tiers.length; i++) {
      if (cfg.tiers[i].maxAmount <= cfg.tiers[i - 1].maxAmount)
        errors.push(`tiers[${i}].maxAmount must be > tiers[${i - 1}].maxAmount (tiers must be ascending)`);
    }
    const totalWeight = cfg.weights.reduce((s, w) => s + w, 0);
    for (let i = 0; i < cfg.tiers.length; i++) {
      const t = cfg.tiers[i];
      if (t.threshold > totalWeight)
        errors.push(`tiers[${i}].threshold=${t.threshold} exceeds total weight=${totalWeight} — transfer would always fail`);
    }
  }

  if (!cfg.maxBatchSize || cfg.maxBatchSize < 1)
    errors.push('maxBatchSize must be >= 1');

  if (errors.length > 0) {
    console.error('\nConfig validation FAILED:');
    errors.forEach(e => console.error('  ✗', e));
    process.exit(1);
  }
}

// ─── Print deployment plan ────────────────────────────────────────────────────

function printPlan() {
  sep();
  console.log(BROADCAST ? '  DEPLOYMENT — MAINNET (BROADCAST ON)' : '  DRY RUN — MAINNET (no transactions will be sent)');
  sep();
  console.log();
  console.log('  RPC:      ', RPC_URL);
  console.log('  Deployer: ', DEPLOYER);
  console.log();

  console.log('STEP 1 — Deploy SpendingManagerFactory');
  console.log('  Deployer becomes factory owner');
  console.log('  Bytecode size:', factoryArtifact.bytecode.length / 2, 'bytes');
  console.log();

  console.log('STEP 2 — factory.createWallet(...)');
  console.log('  corporateOwner :', cfg.corporateOwner);
  console.log('  token          :', cfg.token);
  console.log('  managers       :');
  cfg.managers.forEach((m, i) => {
    console.log(`    [${i}] ${m}  weight=${cfg.weights[i]}`);
    console.log(`         daily=${fmt(cfg.dailyLimits[i])}  weekly=${fmt(cfg.weeklyLimits[i])}  monthly=${fmt(cfg.monthlyLimits[i])}  total=${fmt(cfg.totalLimits[i])}`);
  });
  console.log('  tiers          :');
  cfg.tiers.forEach((t, i) => {
    const forbidden = t.threshold === 0 ? '  FORBIDDEN' : '';
    console.log(`    [${i}] ≤ ${fmt(t.maxAmount).padStart(18)}  →  threshold ${t.threshold}${forbidden}`);
  });
  console.log('  maxBatchSize   :', cfg.maxBatchSize);
  console.log();

  if (cfg.globalLimits && (cfg.globalLimits.daily || cfg.globalLimits.weekly || cfg.globalLimits.monthly || cfg.globalLimits.total)) {
    console.log('STEP 2b — sm.setGlobalLimits(...)');
    console.log(`  daily=${fmt(cfg.globalLimits.daily)}  weekly=${fmt(cfg.globalLimits.weekly)}  monthly=${fmt(cfg.globalLimits.monthly)}  total=${fmt(cfg.globalLimits.total)}`);
    console.log();
  }

  console.log('STEP 3 — Corporate wallet approves SpendingManager');
  console.log('  WHO    : corporateOwner must sign this themselves');
  console.log('  token  :', cfg.token);
  const approvalHuman = cfg.approvalAmount === '115792089237316195423570985008687907853269984665640564039457584007913129639935'
    ? 'MAX (unlimited, approve once)'
    : fmt(cfg.approvalAmount);
  console.log('  amount :', approvalHuman);
  console.log('  (spender address will be known after Step 2)');
  console.log();
}

// ─── Deploy ───────────────────────────────────────────────────────────────────

async function deployFactory() {
  console.log('[1/3] Deploying SpendingManagerFactory...');
  // Factory constructor takes NO args (owner = msg.sender). Older versions
  // of this script passed factoryDelay — the current contract doesn't
  // accept it, so tronweb rejects with "constructor needs 0 but 1 provided".
  const tx = await tronWeb.transactionBuilder.createSmartContract({
    abi:           factoryArtifact.abi,
    bytecode:      factoryArtifact.bytecode,
    parameters:    [],
    feeLimit:      1000_000_000,
    userFeePercentage: 100,
    name: 'SpendingManagerFactory',
  }, DEPLOYER);

  // tronweb v6: createSmartContract returns the tx directly (no `.transaction`
  // wrapper). Sign & fetch the deployed contract address off the tx itself.
  const signed   = await tronWeb.trx.sign(tx, PRIVATE_KEY);
  const result   = await tronWeb.trx.sendRawTransaction(signed);
  const txid     = result.transaction ? result.transaction.txID : (result.txid || tx.txID);
  console.log('  txid:', txid);

  const factoryAddr = TronWeb.address.fromHex('41' + tx.contract_address);
  console.log('  SpendingManagerFactory deployed at:', factoryAddr);
  return factoryAddr;
}

async function createWallet(factoryAddr) {
  console.log('[2/3] Calling factory.createWallet...');
  const factory = await tronWeb.contract(factoryArtifact.abi, factoryAddr);

  const receipt = await factory.createWallet(
    cfg.corporateOwner,
    cfg.token,
    cfg.managers,
    cfg.weights,
    cfg.dailyLimits,
    cfg.weeklyLimits,
    cfg.monthlyLimits,
    cfg.totalLimits,
    cfg.tiers.map(t => [t.maxAmount, t.threshold]),
    cfg.maxBatchSize
  ).send({ feeLimit: 1000_000_000 });

  console.log('  txid:', receipt);

  // Fetch WalletCreated event to get SpendingManager address
  await new Promise(r => setTimeout(r, 4000)); // wait for confirmation
  const factoryContract = await tronWeb.getEventResult(factoryAddr, { eventName: 'WalletCreated', size: 1, sort: 'desc' });
  const smAddr = factoryContract[0] && factoryContract[0].result && factoryContract[0].result.contractAddress;
  if (smAddr) {
    const smBase58 = TronWeb.address.fromHex(smAddr);
    console.log('  SpendingManager deployed at:', smBase58);
    return smBase58;
  }
  return null;
}

async function setGlobalLimits(smAddr) {
  const g = cfg.globalLimits;
  if (!g || (!g.daily && !g.weekly && !g.monthly && !g.total)) return;
  console.log('[2b] Setting global limits...');
  const sm = await tronWeb.contract(managerArtifact.abi, smAddr);
  const receipt = await sm.setGlobalLimits(g.daily, g.weekly, g.monthly, g.total)
    .send({ feeLimit: 100_000_000 });
  console.log('  txid:', receipt);
}

function printApproveCalldata(smAddr) {
  sep();
  console.log('STEP 3 — Action required: corporate wallet must approve');
  sep();
  console.log();
  console.log('  The corporateOwner wallet must call:');
  console.log('    USDT.approve(spendingManagerAddress, amount)');
  console.log();
  console.log('  token (USDT):          ', cfg.token);
  if (smAddr) console.log('  spender (SpendingMgr): ', smAddr);
  console.log('  amount:                 MAX (unlimited)');
  console.log();
  console.log('  Recommend using TronLink or TronScan to execute this call.');
  console.log('  Function signature: approve(address,uint256)');
  if (smAddr) {
    const encoded = tronWeb.utils.abi.encodeParams(
      ['address', 'uint256'],
      [smAddr, cfg.approvalAmount]
    );
    const selector = '095ea7b3';
    console.log('  Raw calldata: 0x' + selector + encoded.replace('0x', ''));
  }
  console.log();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  validateConfig();
  printPlan();

  if (!BROADCAST) {
    sep();
    console.log('  Dry run complete. No transactions sent.');
    console.log('  Run with --broadcast to deploy for real.');
    sep();
    return;
  }

  sep();
  console.log('  BROADCASTING — this will spend real TRX');
  sep();
  console.log();

  const factoryAddr = await deployFactory();
  const smAddr      = await createWallet(factoryAddr);
  await setGlobalLimits(smAddr);

  console.log();
  console.log('Deployment complete.');
  console.log('  Factory:         ', factoryAddr);
  console.log('  SpendingManager: ', smAddr || '(check tx logs for address)');
  console.log();

  printApproveCalldata(smAddr);

  // Save result to disk for reference
  const result = {
    deployedAt: new Date().toISOString(),
    network: 'mainnet',
    rpc: RPC_URL,
    deployer: DEPLOYER,
    factory: factoryAddr,
    spendingManager: smAddr,
    corporateOwner: cfg.corporateOwner,
    token: cfg.token,
  };
  const resultPath = path.join(__dirname, 'deployment-result.json');
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  console.log('Result saved to scripts/deployment-result.json');
}

main().catch(e => { console.error(e); process.exit(1); });
