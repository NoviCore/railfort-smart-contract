/**
 * Ensures the accounts used in tests have enough TRX to pay for bandwidth.
 *
 * On each quickstart container start, accounts begin with ~10 000 TRX each.
 * After many test runs that each send dozens of state-changing transactions,
 * those accounts deplete.  The SR/genesis dev key (da146374…) always holds
 * 94 billion TRX, so we use it as the unlimited faucet.
 *
 * This script:
 *   1. Reads the quickstart's account 0 address from the admin API.
 *   2. Checks its balance via the proxy.
 *   3. If balance < MIN_TRX, tops it up to TOP_UP_TRX from the dev account.
 *   4. Also activates the dev account if it isn't yet (needed on a fresh
 *      container where the genesis account hasn't been touched).
 */

const http = require('http');
const { TronWeb } = require('tronweb');

const QUICKSTART_HOST = '127.0.0.1:9090';
const PROXY_HOST      = '127.0.0.1:9091';
const DEV_KEY         = 'da146374a75310b9666e834ee4ad0866d6f4035967bfc76217c5a495fff9f0d0';

const MIN_TRX    = 5_000;           // top-up when balance drops below this
const TOP_UP_TRX = 50_000;          // top up to this amount

function fetchAdminAccounts() {
  return new Promise((resolve, reject) => {
    http.get(`http://${QUICKSTART_HOST}/admin/accounts`, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseKey0(text) {
  const lines = text.split('\n');
  // Key line: (0)  <64-hex-chars>
  const keyLine = lines.find(l => /^\(0\)\s+[0-9a-f]{64}/.test(l));
  if (!keyLine) throw new Error('Could not parse account 0 key from admin/accounts');
  return keyLine.match(/([0-9a-f]{64})/)[1];
}

function parseAddr0(text) {
  const lines = text.split('\n');
  // Address line: (0)  T<base58>
  const addrLine = lines.find(l => /^\(0\)\s+T/.test(l));
  if (!addrLine) throw new Error('Could not parse account 0 address from admin/accounts');
  return addrLine.match(/^\(\d+\)\s+(\S+)/)[1];
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitConfirm(tw, txid, label) {
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const info = await tw.trx.getTransactionInfo(txid);
    if (info && info.blockNumber) {
      console.log(`  ${label} confirmed in block ${info.blockNumber}.`);
      return;
    }
  }
  console.warn(`  ${label} not confirmed in 30 s — proceeding.`);
}

async function main() {
  const adminText = await fetchAdminAccounts();
  const account0Addr = parseAddr0(adminText);
  const account0Key  = parseKey0(adminText);

  // Dev account sends TRX (genesis account — always funded)
  const tw = new TronWeb({ fullHost: `http://${PROXY_HOST}`, privateKey: DEV_KEY });
  const devAddress = tw.address.fromPrivateKey(DEV_KEY);

  // ── 1. Activate dev account if needed ──────────────────────────────────────
  const devAccount = await tw.trx.getAccount(devAddress);
  if (!devAccount || !devAccount.address) {
    // On a brand-new container the genesis key is already active by definition;
    // this branch runs only if something unusual happened.
    console.log(`Dev account ${devAddress} appears inactive — cannot self-fund.`);
    console.log('Start the Docker container and let it produce at least one block.');
    process.exit(1);
  }

  // ── 2. Top up quickstart account 0 if below threshold ─────────────────────
  const balance0Sun = await tw.trx.getBalance(account0Addr);
  const balance0TRX = balance0Sun / 1_000_000;

  if (balance0TRX >= MIN_TRX) {
    console.log(`Quickstart account 0 (${account0Addr}) has ${balance0TRX.toFixed(2)} TRX — OK.`);
  } else {
    const sendSun = (TOP_UP_TRX - balance0TRX) * 1_000_000;
    console.log(`Quickstart account 0 balance is ${balance0TRX.toFixed(4)} TRX — topping up to ${TOP_UP_TRX} TRX...`);
    const tx = await tw.trx.sendTrx(account0Addr, Math.round(sendSun));
    if (!tx.result && !tx.txid) {
      throw new Error('Top-up transaction failed: ' + JSON.stringify(tx));
    }
    const txid = tx.txid || tx.transaction?.txID;
    await waitConfirm(tw, txid, `Top-up ${account0Addr}`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
