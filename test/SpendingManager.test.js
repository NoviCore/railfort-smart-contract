require('dotenv').config();
const SpendingManager = artifacts.require('SpendingManager');
const MockTRC20       = artifacts.require('MockTRC20');
const { toEthHex, privateKeyToTronAddr, n, signTransfer, signTransferTron, ZERO_ADDR, fetchQuickstartKey, withRetry } = require('./helpers');

// Energy tracking (populated during test run, printed in after())
const energyLog = [];

// Fetch confirmed energy usage for a transaction from the local node.
// TronBox contract calls return the txid as the transaction hash.
async function getEnergy(txidOrResult) {
  const { TronWeb } = require('tronweb');
  const tw = new TronWeb({ fullHost: 'http://127.0.0.1:9091' });
  const txid = (typeof txidOrResult === 'string')
    ? txidOrResult
    : (txidOrResult && (txidOrResult.txid || txidOrResult.transaction_id));
  if (!txid) return 0;
  // feeLimit = 1000 TRX → at 420 sun/energy, max possible ≈ 2.4M energy.
  // Values above 3M are a quickstart node artifact — skip and keep polling.
  const SANITY_CAP = 3_000_000;
  // Poll until the tx is confirmed (up to 10 s)
  for (let i = 0; i < 10; i++) {
    try {
      const info = await tw.trx.getTransactionInfo(txid);
      if (info && info.receipt) {
        const e = info.receipt.energy_usage_total || info.receipt.energy_usage || 0;
        if (e > 0 && e <= SANITY_CAP) return e;
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return 0;
}

// ─── Test accounts ───────────────────────────────────────────────────────────

// OWNER_KEY is resolved dynamically in before():
//   - on Nile: matched via PRIVATE_KEY_NILE env var
//   - on local quickstart: fetched from http://127.0.0.1:9090/admin/accounts
//     (quickstart generates fresh random accounts on every container start)
const NILE_KEY  = process.env.PRIVATE_KEY_NILE;
const ALICE_KEY = '75065f100e38d3f3b4c5c4235834ba8216de62272a4f03532c44b31a5734360a';
const CAROL_KEY = '0350196b53aabc0cddf5e04e814a12e39a1230e24c024f4aeeb32ef2d0d2d1d0';

const ALICE = privateKeyToTronAddr(ALICE_KEY);
const CAROL = privateKeyToTronAddr(CAROL_KEY);

let OWNER_KEY; // set in before() once accounts[0] is known

// Limit values mirroring the client diagram
const CFO_DAILY  = 5000;
const MGR_DAILY  = 1000;

// Default tiers for the main deployment: all amounts require weight=2 (both managers).
// Using a single tier with a high maxAmount preserves the original 2-of-2 multisig
// behaviour for all existing tests.
const DEFAULT_TIERS = [[999999, 2]];

// ─────────────────────────────────────────────────────────────────────────────

contract('SpendingManager', (accounts) => {
  const OWNER = accounts[0];

  let token;
  let sm;
  let nonce = 1000;
  const nextNonce = () => nonce++;

  before(async () => {
    // Determine which private key corresponds to accounts[0] on this network
    const nileAddr = NILE_KEY ? toEthHex(privateKeyToTronAddr(NILE_KEY)) : null;
    if (toEthHex(OWNER) === nileAddr) {
      OWNER_KEY = NILE_KEY;
    } else {
      OWNER_KEY = await fetchQuickstartKey(OWNER);
      if (!OWNER_KEY) throw new Error('No known private key for accounts[0]: ' + OWNER);
    }

    // Wait for a new TRON block (3 s) before deploying — prevents DUP_TRANSACTION_ERROR
    // when factory tests deployed the same MockTRC20 bytecode within the same block
    await new Promise(r => setTimeout(r, 4000));
    token = await MockTRC20.new();

    sm = await SpendingManager.new(
      OWNER,
      token.address,
      [OWNER,     ALICE],
      [1,         1],
      [CFO_DAILY, MGR_DAILY],
      [20000,     5000],
      [80000,     20000],
      [500000,    100000],
      DEFAULT_TIERS,
      10   // MAX_BATCH_SIZE
    );

    await withRetry(() => token.mint(OWNER, 1_000_000));
    await withRetry(() => token.approve(sm.address, 1_000_000));
  });

  // ─── Deployment ────────────────────────────────────────────────────────────

  describe('deployment', () => {
    it('sets owner', async () => {
      assert.equal(toEthHex(await sm.owner()), toEthHex(OWNER));
    });

    it('sets token', async () => {
      assert.equal(toEthHex(await sm.token()), toEthHex(token.address));
    });

    it('sets initial tiers', async () => {
      const tiers = await sm.getTiers();
      assert.equal(tiers.length, 1);
      assert.equal(n(tiers[0][0]), 999999); // maxAmount
      assert.equal(n(tiers[0][1]), 2);      // threshold
    });

    it('registers initial managers', async () => {
      assert.equal(await sm.isManager(OWNER), true);
      assert.equal(await sm.isManager(ALICE), true);
    });

    it('unknown address is not a manager', async () => {
      assert.equal(await sm.isManager(CAROL), false);
    });

    it('VERSION is 1.0.0', async () => {
      assert.equal(await sm.VERSION(), '1.0.0');
    });
  });

  // ─── Owner: addManager ─────────────────────────────────────────────────────

  describe('addManager', () => {
    it('owner can add a manager', async () => {
      await withRetry(async () => {
        await sm.addManager(CAROL, 1, 500, 2000, 8000, 50000);
        if (!await sm.isManager(CAROL)) throw new Error('SERVER_BUSY');
      });
      assert.equal(await sm.isManager(CAROL), true);
    });

    it('reverts on duplicate', async () => {
      try {
        await sm.addManager(CAROL, 1, 500, 2000, 8000, 50000);
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
    });

    it('reverts when weight is 0', async () => {
      try {
        await sm.addManager(accounts[3], 0, 500, 2000, 8000, 50000);
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
    });
  });

  // ─── Owner: removeManager ──────────────────────────────────────────────────

  describe('removeManager', () => {
    it('owner can remove a manager', async () => {
      await withRetry(async () => {
        await sm.removeManager(CAROL);
        if (await sm.isManager(CAROL)) throw new Error('SERVER_BUSY');
      });
      assert.equal(await sm.isManager(CAROL), false);
    });

    it('reverts when already inactive', async () => {
      try {
        await sm.removeManager(CAROL);
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
    });
  });

  // ─── Owner: updateManagerLimits ────────────────────────────────────────────

  describe('updateManagerLimits', () => {
    it('updates all four limits', async () => {
      await sm.updateManagerLimits(ALICE, 2000, 10000, 40000, 200000);
      const info = await sm.getManager(ALICE);
      assert.equal(n(info.dailyLimit),   2000);
      assert.equal(n(info.weeklyLimit),  10000);
      assert.equal(n(info.monthlyLimit), 40000);
      assert.equal(n(info.totalLimit),   200000);
    });

    after(async () => {
      await withRetry(() => sm.updateManagerLimits(ALICE, MGR_DAILY, 5000, 20000, 100000));
    });
  });

  // ─── Owner: updateManagerWeight ────────────────────────────────────────────

  describe('updateManagerWeight', () => {
    it('updates weight', async () => {
      await withRetry(async () => {
        await sm.updateManagerWeight(ALICE, 5);
        if (n((await sm.getManager(ALICE)).weight) !== 5) throw new Error('SERVER_BUSY');
      });
      assert.equal(n((await sm.getManager(ALICE)).weight), 5);
    });

    after(async () => {
      await withRetry(() => sm.updateManagerWeight(ALICE, 1));
    });
  });

  // ─── Owner: setTiers ───────────────────────────────────────────────────────

  describe('setTiers', () => {
    it('owner can set new valid tiers', async () => {
      await withRetry(async () => {
        await sm.setTiers([[200, 1], [999999, 2]]);
        const tiers = await sm.getTiers();
        if (tiers.length !== 2) throw new Error('SERVER_BUSY');
      });
      const tiers = await sm.getTiers();
      assert.equal(tiers.length, 2);
      assert.equal(n(tiers[0][0]), 200);
      assert.equal(n(tiers[0][1]), 1);
      assert.equal(n(tiers[1][0]), 999999);
      assert.equal(n(tiers[1][1]), 2);
    });

    after(async () => {
      await withRetry(() => sm.setTiers(DEFAULT_TIERS));
    });
  });

  // ─── Owner: setGlobalLimits ────────────────────────────────────────────────

  describe('setGlobalLimits', () => {
    it('sets all four global limits', async () => {
      await sm.setGlobalLimits(10000, 50000, 200000, 1_000_000);
      assert.equal(n(await sm.globalDailyLimit()),   10000);
      assert.equal(n(await sm.globalWeeklyLimit()),  50000);
      assert.equal(n(await sm.globalMonthlyLimit()), 200000);
      assert.equal(n(await sm.globalTotalLimit()),   1_000_000);
    });

    after(async () => {
      await withRetry(() => sm.setGlobalLimits(0, 0, 0, 0));
    });
  });

  // ─── Owner: setManagerSpent ───────────────────────────────────────────────

  describe('setManagerSpent', () => {
    it('owner can set all four spent counters for a manager', async () => {
      await sm.setManagerSpent(ALICE, 100, 200, 300, 400);
      const info = await sm.getManager(ALICE);
      assert.equal(n(info.dailySpent),   100);
      assert.equal(n(info.weeklySpent),  200);
      assert.equal(n(info.monthlySpent), 300);
      assert.equal(n(info.totalSpent),   400);
    });

    it('setting spent above limit blocks subsequent transfers for that manager', async () => {
      // Set alice daily spent to her full daily limit so she cannot sign
      await sm.setManagerSpent(ALICE, MGR_DAILY, 0, 0, 0);
      const no = nextNonce();
      const sigOwner = signTransfer(sm.address, ALICE, 1, no, OWNER_KEY);
      const sigAlice = signTransfer(sm.address, ALICE, 1, no, ALICE_KEY);
      // Only OWNER's sig counts (ALICE is over limit) → weight 1 < threshold 2 → no-op
      await sm.execute(ALICE, 1, no, [sigOwner, sigAlice]);
      assert.equal(await sm.isNonceUsed(no), false);
    });

    it('setting spent to 0 resets the counter and allows transfers again', async () => {
      await withRetry(() => sm.setManagerSpent(ALICE, 0, 0, 0, 0));
      const no = nextNonce();
      const before = n(await token.balanceOf(ALICE));
      const sigOwner = signTransfer(sm.address, ALICE, 1, no, OWNER_KEY);
      const sigAlice = signTransfer(sm.address, ALICE, 1, no, ALICE_KEY);
      await withRetry(async () => {
        await sm.execute(ALICE, 1, no, [sigOwner, sigAlice]);
        if (!await sm.isNonceUsed(no)) throw new Error('SERVER_BUSY');
      });
      assert.equal(n(await token.balanceOf(ALICE)), before + 1);
    });

    it('reverts for inactive manager', async () => {
      try {
        await sm.setManagerSpent(CAROL, 0, 0, 0, 0);
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
    });

    after(async () => {
      await withRetry(() => sm.setManagerSpent(ALICE, 0, 0, 0, 0));
    });
  });

  // ─── Owner: setGlobalSpent ─────────────────────────────────────────────────

  describe('setGlobalSpent', () => {
    it('owner can set all four global spent counters', async () => {
      await sm.setGlobalSpent(111, 222, 333, 444);
      const spent = await sm.getGlobalSpent();
      assert.equal(n(spent[0]), 111);
      assert.equal(n(spent[1]), 222);
      assert.equal(n(spent[2]), 333);
      assert.equal(n(spent[3]), 444);
    });

    it('setting global daily spent above limit blocks all transfers', async () => {
      await withRetry(() => sm.setGlobalLimits(500, 0, 0, 0));
      await withRetry(() => sm.setGlobalSpent(500, 0, 0, 0)); // already at limit
      const no = nextNonce();
      const sigOwner = signTransfer(sm.address, ALICE, 1, no, OWNER_KEY);
      const sigAlice = signTransfer(sm.address, ALICE, 1, no, ALICE_KEY);
      try {
        await sm.execute(ALICE, 1, no, [sigOwner, sigAlice]);
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
    });

    after(async () => {
      await withRetry(() => sm.setGlobalLimits(0, 0, 0, 0));
      await withRetry(() => sm.setGlobalSpent(0, 0, 0, 0));
    });
  });

  // ─── Execute: success ──────────────────────────────────────────────────────

  describe('execute — success', () => {
    before(async () => {
      // Guard against a prior after-hook failing to reset tiers.
      await withRetry(() => sm.setTiers(DEFAULT_TIERS));
    });

    it('transfers tokens when both managers sign (weight 2 >= threshold 2)', async () => {
      const amount = 100;
      const no     = nextNonce();
      const before = n(await token.balanceOf(ALICE));

      const sigOwner = signTransfer(sm.address, ALICE, amount, no, OWNER_KEY);
      const sigAlice = signTransfer(sm.address, ALICE, amount, no, ALICE_KEY);

      await withRetry(async () => {
        await sm.execute(ALICE, amount, no, [sigOwner, sigAlice]);
        if (!await sm.isNonceUsed(no)) throw new Error('SERVER_BUSY');
      });

      assert.equal(n(await token.balanceOf(ALICE)), before + amount);
      assert.equal(await sm.isNonceUsed(no), true);
    });

    it('updates owner spent counters', async () => {
      const info = await sm.getManager(OWNER);
      assert.ok(n(info.dailySpent) > 0);
    });

    it('updates global spent counter', async () => {
      const spent = await sm.getGlobalSpent();
      assert.ok(n(spent[0]) > 0);
    });

    it('accepts signatures in any order', async () => {
      const no = nextNonce();
      const sigAlice = signTransfer(sm.address, ALICE, 50, no, ALICE_KEY);
      const sigOwner = signTransfer(sm.address, ALICE, 50, no, OWNER_KEY);
      await withRetry(async () => {
        await sm.execute(ALICE, 50, no, [sigAlice, sigOwner]);
        if (!await sm.isNonceUsed(no)) throw new Error('SERVER_BUSY');
      });
      assert.equal(await sm.isNonceUsed(no), true);
    });

    it('counts duplicate signature only once (weight 1 < threshold 2 → no-op)', async () => {
      const no  = nextNonce();
      const sig = signTransfer(sm.address, ALICE, 50, no, OWNER_KEY);
      await sm.execute(ALICE, 50, no, [sig, sig]);
      assert.equal(await sm.isNonceUsed(no), false);
    });
  });

  // ─── Execute: rejections ───────────────────────────────────────────────────

  describe('execute — rejections', () => {
    it('reverts on duplicate nonce', async () => {
      const usedNo   = 1000;
      const sigOwner = signTransfer(sm.address, ALICE, 10, usedNo, OWNER_KEY);
      const sigAlice = signTransfer(sm.address, ALICE, 10, usedNo, ALICE_KEY);
      try {
        await sm.execute(ALICE, 10, usedNo, [sigOwner, sigAlice]);
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
    });

    it('no-op (nonce stays free) when signed weight < threshold', async () => {
      const no  = nextNonce();
      const sig = signTransfer(sm.address, ALICE, 50, no, OWNER_KEY);
      await sm.execute(ALICE, 50, no, [sig]);
      assert.equal(await sm.isNonceUsed(no), false);
    });

    it('reverts on zero amount', async () => {
      try {
        await sm.execute(ALICE, 0, nextNonce(), []);
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
    });

    it('reverts on zero address recipient', async () => {
      try {
        await sm.execute(ZERO_ADDR, 100, nextNonce(), []);
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
    });
  });

  // ─── Execute: global limits ────────────────────────────────────────────────

  describe('execute — global limits', () => {
    afterEach(async () => {
      await withRetry(() => sm.setGlobalLimits(0, 0, 0, 0));
    });

    it('reverts when global daily limit exceeded', async () => {
      await sm.setGlobalLimits(50, 0, 0, 0);
      const no       = nextNonce();
      const sigOwner = signTransfer(sm.address, ALICE, 100, no, OWNER_KEY);
      const sigAlice = signTransfer(sm.address, ALICE, 100, no, ALICE_KEY);
      try {
        await sm.execute(ALICE, 100, no, [sigOwner, sigAlice]);
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
    });

    it('reverts when global total limit exceeded', async () => {
      await sm.setGlobalLimits(0, 0, 0, 1);
      const no       = nextNonce();
      const sigOwner = signTransfer(sm.address, ALICE, 100, no, OWNER_KEY);
      const sigAlice = signTransfer(sm.address, ALICE, 100, no, ALICE_KEY);
      try {
        await sm.execute(ALICE, 100, no, [sigOwner, sigAlice]);
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
    });
  });

  // ─── Execute: manager limit filtering ─────────────────────────────────────

  describe('execute — manager limit filtering', () => {
    it("excludes signer over daily limit; falls below threshold → no-op", async () => {
      await sm.updateManagerLimits(ALICE, 5, 5000, 20000, 100000);
      const no       = nextNonce();
      const sigOwner = signTransfer(sm.address, ALICE, 100, no, OWNER_KEY);
      const sigAlice = signTransfer(sm.address, ALICE, 100, no, ALICE_KEY);
      await withRetry(() => sm.execute(ALICE, 100, no, [sigOwner, sigAlice]));
      assert.equal(await sm.isNonceUsed(no), false);
      await withRetry(() => sm.updateManagerLimits(ALICE, MGR_DAILY, 5000, 20000, 100000));
    });

    it('executes when remaining valid weight still meets threshold', async () => {
      // ALICE weight=3, tiers require weight=3 for all amounts,
      // OWNER daily limit=1 (too low for 50) → only ALICE's sig counts, weight 3 ≥ 3
      await sm.updateManagerWeight(ALICE, 3);
      await sm.setTiers([[999999, 3]]);
      await sm.updateManagerLimits(OWNER, 1, 5, 5, 5);

      const no     = nextNonce();
      const before = n(await token.balanceOf(ALICE));
      const sigOwner = signTransfer(sm.address, ALICE, 50, no, OWNER_KEY);
      const sigAlice = signTransfer(sm.address, ALICE, 50, no, ALICE_KEY);

      await sm.execute(ALICE, 50, no, [sigOwner, sigAlice]);
      assert.equal(n(await token.balanceOf(ALICE)), before + 50);
      assert.equal(await sm.isNonceUsed(no), true);

      // Lower tier threshold first, then reduce weight — otherwise total weight
      // could drop below tier threshold mid-cleanup and cause a revert.
      await withRetry(() => sm.setTiers(DEFAULT_TIERS));
      await withRetry(() => sm.updateManagerWeight(ALICE, 1));
      await withRetry(() => sm.updateManagerLimits(OWNER, CFO_DAILY, 20000, 80000, 500000));
    });
  });

  // ─── executeBatch ──────────────────────────────────────────────────────────
  //
  // TronWeb's ethers v6 ABI encoder uses `localName` (not `name`) for tuple
  // component matching. It strips localName from nested struct fields, so
  // named-object form { recipient, amount, nonce, signatures } fails with
  // "missing names". Use positional arrays [recipient, amount, nonce, sigs[]]
  // which always work regardless of localName.

  describe('executeBatch', () => {
    before(async () => {
      await withRetry(() => sm.setTiers(DEFAULT_TIERS));
      await withRetry(() => sm.setGlobalLimits(0, 0, 0, 0));
    });

    afterEach(async () => {
      // Reset global limits after every batch test so a failed test can't
      // leave limits set and break subsequent tests.
      await withRetry(() => sm.setGlobalLimits(0, 0, 0, 0));
    });

    it('executes two valid transfers in one batch', async () => {
      const n1 = nextNonce(), n2 = nextNonce();
      const beforeAlice = n(await token.balanceOf(ALICE));

      // Positional tuple arrays: [recipient, amount, nonce, signatures[]]
      const batch = [
        [ALICE, 10, n1, [
          signTransfer(sm.address, ALICE, 10, n1, OWNER_KEY),
          signTransfer(sm.address, ALICE, 10, n1, ALICE_KEY),
        ]],
        [ALICE, 20, n2, [
          signTransfer(sm.address, ALICE, 20, n2, OWNER_KEY),
          signTransfer(sm.address, ALICE, 20, n2, ALICE_KEY),
        ]],
      ];

      await withRetry(async () => {
        await sm.executeBatch(batch);
        if (!await sm.isNonceUsed(n2)) throw new Error('SERVER_BUSY');
      });

      assert.equal(n(await token.balanceOf(ALICE)), beforeAlice + 30);
      assert.equal(await sm.isNonceUsed(n1), true);
      assert.equal(await sm.isNonceUsed(n2), true);
    });

    it('skips transfer with used nonce, continues rest', async () => {
      // Pick a nonce we know is already used (first execute success test used nonce 1000)
      const usedNo  = 1000;
      const freshNo = nextNonce();
      const beforeAlice = n(await token.balanceOf(ALICE));

      const batch = [
        [ALICE, 10, usedNo, [
          signTransfer(sm.address, ALICE, 10, usedNo, OWNER_KEY),
          signTransfer(sm.address, ALICE, 10, usedNo, ALICE_KEY),
        ]],
        [ALICE, 5, freshNo, [
          signTransfer(sm.address, ALICE, 5, freshNo, OWNER_KEY),
          signTransfer(sm.address, ALICE, 5, freshNo, ALICE_KEY),
        ]],
      ];

      await withRetry(async () => {
        await sm.executeBatch(batch);
        if (!await sm.isNonceUsed(freshNo)) throw new Error('SERVER_BUSY');
      });

      assert.equal(n(await token.balanceOf(ALICE)), beforeAlice + 5);
      assert.equal(await sm.isNonceUsed(freshNo), true);
    });

    it('skips transfer with insufficient weight, continues rest', async () => {
      const weakNo   = nextNonce();
      const strongNo = nextNonce();
      const beforeAlice = n(await token.balanceOf(ALICE));

      const batch = [
        // Only one sig → weight 1 < threshold 2 → soft-fail
        [ALICE, 5, weakNo, [
          signTransfer(sm.address, ALICE, 5, weakNo, OWNER_KEY),
        ]],
        [ALICE, 7, strongNo, [
          signTransfer(sm.address, ALICE, 7, strongNo, OWNER_KEY),
          signTransfer(sm.address, ALICE, 7, strongNo, ALICE_KEY),
        ]],
      ];

      await withRetry(async () => {
        await sm.executeBatch(batch);
        if (!await sm.isNonceUsed(strongNo)) throw new Error('SERVER_BUSY');
      });

      assert.equal(n(await token.balanceOf(ALICE)), beforeAlice + 7);
      assert.equal(await sm.isNonceUsed(weakNo),   false);
      assert.equal(await sm.isNonceUsed(strongNo),  true);
    });

    it('reverts entire batch when size exceeds MAX_BATCH_SIZE (10)', async () => {
      const transfers = [];
      for (let i = 0; i < 11; i++) {
        const no = nextNonce();
        transfers.push([ALICE, 1, no, [
          signTransfer(sm.address, ALICE, 1, no, OWNER_KEY),
          signTransfer(sm.address, ALICE, 1, no, ALICE_KEY),
        ]]);
      }
      try {
        await sm.executeBatch(transfers);
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
    });

    it('reverts on empty batch', async () => {
      try {
        await sm.executeBatch([]);
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
    });

    it('global daily limit applied across batch items (remaining items soft-fail)', async () => {
      // Read current accumulated spent so we set a limit that:
      //   - allows the first transfer of 10 (spent + 10 <= limit)
      //   - blocks the second transfer of 10 (spent + 20 > limit)
      const currentSpent = n((await sm.getGlobalSpent())[0]);
      const limitToSet   = currentSpent + 15; // gap of 15: fits 10, blocks 10+10

      await withRetry(() => sm.setGlobalLimits(limitToSet, 0, 0, 0));

      const n1 = nextNonce(), n2 = nextNonce();
      const beforeAlice = n(await token.balanceOf(ALICE));

      const batch = [
        [ALICE, 10, n1, [
          signTransfer(sm.address, ALICE, 10, n1, OWNER_KEY),
          signTransfer(sm.address, ALICE, 10, n1, ALICE_KEY),
        ]],
        [ALICE, 10, n2, [
          signTransfer(sm.address, ALICE, 10, n2, OWNER_KEY),
          signTransfer(sm.address, ALICE, 10, n2, ALICE_KEY),
        ]],
      ];

      // n1 should execute (amount 10 fits under limit gap of 15);
      // n2 should soft-fail (10+10 > 15).  Use n1 nonce as confirmation signal.
      await withRetry(async () => {
        await sm.executeBatch(batch);
        if (!await sm.isNonceUsed(n1)) throw new Error('SERVER_BUSY');
      });

      assert.equal(n(await token.balanceOf(ALICE)), beforeAlice + 10);
      assert.equal(await sm.isNonceUsed(n1), true);
      assert.equal(await sm.isNonceUsed(n2), false);
      // afterEach resets limits to 0
    });

    it('updates global spent counters after batch', async () => {
      const beforeSpent = n((await sm.getGlobalSpent())[0]);
      const n1 = nextNonce();

      await withRetry(async () => {
        await sm.executeBatch([[ALICE, 8, n1, [
          signTransfer(sm.address, ALICE, 8, n1, OWNER_KEY),
          signTransfer(sm.address, ALICE, 8, n1, ALICE_KEY),
        ]]]);
        if (!await sm.isNonceUsed(n1)) throw new Error('SERVER_BUSY');
      });

      assert.equal(n((await sm.getGlobalSpent())[0]), beforeSpent + 8);
    });
  });

  // ─── Pause / unpause ──────────────────────────────────────────────────────

  describe('pause / unpause', () => {
    after(async () => {
      // Safety: always leave the contract unpaused after this block
      const isPaused = await sm.paused();
      if (isPaused) await withRetry(() => sm.unpause());
    });

    it('owner can pause the contract', async () => {
      await withRetry(async () => {
        await sm.pause();
        if (!(await sm.paused())) throw new Error('SERVER_BUSY');
      });
      assert.equal(await sm.paused(), true);
    });

    it('execute reverts when paused', async () => {
      const no = nextNonce();
      const sigOwner = signTransfer(sm.address, ALICE, 1, no, OWNER_KEY);
      const sigAlice = signTransfer(sm.address, ALICE, 1, no, ALICE_KEY);
      try {
        await sm.execute(ALICE, 1, no, [sigOwner, sigAlice]);
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
      assert.equal(await sm.isNonceUsed(no), false);
    });

    it('executeBatch reverts when paused', async () => {
      const no = nextNonce();
      try {
        await sm.executeBatch([[ALICE, 1, no, [
          signTransfer(sm.address, ALICE, 1, no, OWNER_KEY),
          signTransfer(sm.address, ALICE, 1, no, ALICE_KEY),
        ]]]);
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
    });

    it('owner can unpause the contract', async () => {
      await withRetry(async () => {
        await sm.unpause();
        if (await sm.paused()) throw new Error('SERVER_BUSY');
      });
      assert.equal(await sm.paused(), false);
    });

    it('execute works again after unpause', async () => {
      const no = nextNonce();
      await withRetry(async () => {
        await sm.execute(ALICE, 1, no, [
          signTransfer(sm.address, ALICE, 1, no, OWNER_KEY),
          signTransfer(sm.address, ALICE, 1, no, ALICE_KEY),
        ]);
        if (!await sm.isNonceUsed(no)) throw new Error('SERVER_BUSY');
      });
      assert.equal(await sm.isNonceUsed(no), true);
    });
  });

  // ─── Tiers validation ──────────────────────────────────────────────────────

  describe('tiers validation', () => {
    // State at entry: OWNER(w=1) + ALICE(w=1), totalActiveWeight=2, DEFAULT_TIERS

    it('setTiers with empty array reverts', async () => {
      try {
        await sm.setTiers([]);
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
    });

    it('setTiers with non-ascending maxAmounts reverts', async () => {
      try {
        await sm.setTiers([[500, 1], [100, 2]]);
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
    });

    it('setTiers with threshold exceeding totalActiveWeight reverts', async () => {
      // totalActiveWeight=2; threshold=5 must revert
      try {
        await sm.setTiers([[999999, 5]]);
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
    });

    it('setTiers with threshold=0 reverts', async () => {
      try {
        await sm.setTiers([[999999, 0]]);
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
    });

    it('removeManager that would make a tier threshold unachievable reverts', async () => {
      // OWNER(w=1) + ALICE(w=1), tier requires threshold=2.
      // Removing OWNER leaves weight=1 < threshold=2 → must revert.
      try {
        await sm.removeManager(OWNER);
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
      assert.equal(await sm.isManager(OWNER), true);
    });

    it('updateManagerWeight to value that would make tier threshold unachievable reverts', async () => {
      // OWNER(w=1) + ALICE(w=1), tier requires threshold=2.
      // Setting ALICE weight=0 → total=1 < 2 → must revert.
      try {
        await sm.updateManagerWeight(ALICE, 0);
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
      assert.equal(n((await sm.getManager(ALICE)).weight), 1);
    });

    it('totalActiveWeight is correct after addManager', async () => {
      const before = n(await sm.totalActiveWeight());
      await withRetry(async () => {
        await sm.addManager(CAROL, 3, 500, 2000, 8000, 50000);
        if (!await sm.isManager(CAROL)) throw new Error('SERVER_BUSY');
      });
      assert.equal(n(await sm.totalActiveWeight()), before + 3);
      // Cleanup
      await withRetry(async () => {
        await sm.removeManager(CAROL);
        if (await sm.isManager(CAROL)) throw new Error('SERVER_BUSY');
      });
      assert.equal(n(await sm.totalActiveWeight()), before);
    });

    it('MAX_BATCH_SIZE returns value set in constructor', async () => {
      assert.equal(n(await sm.MAX_BATCH_SIZE()), 10);
    });

    it('setTiers with invalid tiers leaves existing tiers intact (atomic failure)', async () => {
      // totalActiveWeight=2; threshold=10 exceeds it → must revert without clearing existing tiers
      const tiersBefore = await sm.getTiers();
      try {
        await sm.setTiers([[999999, 10]]);
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
      const tiersAfter = await sm.getTiers();
      assert.equal(tiersAfter.length, tiersBefore.length);
      assert.equal(n(tiersAfter[0][1]), n(tiersBefore[0][1]));
    });
  });

  // ─── Tiered thresholds — fresh deployment ──────────────────────────────────
  //
  // OWNER weight=2, ALICE weight=1, total=3
  // Tiers: [≤100 → threshold 1, ≤500 → threshold 2, ≤1000 → threshold 3, >1000 → forbidden]

  describe('tiered thresholds', () => {
    let smT;
    let tieredToken;

    // [[maxAmount, threshold], ...]
    const TIERED_TIERS = [[100, 1], [500, 2], [1000, 3]];

    before(async () => {
      await new Promise(r => setTimeout(r, 3000));
      tieredToken = await MockTRC20.new();
      smT = await SpendingManager.new(
        OWNER,
        tieredToken.address,
        [OWNER,  ALICE],
        [2,      1],      // OWNER weight=2, ALICE weight=1
        [0, 0], [0, 0], [0, 0], [0, 0],
        TIERED_TIERS,
        10
      );
      await withRetry(() => tieredToken.mint(OWNER, 1_000_000));
      await withRetry(() => tieredToken.approve(smT.address, 1_000_000));
    });

    it('amount ≤ 100 (tier 1, threshold 1): ALICE alone (weight 1) succeeds', async () => {
      const no = nextNonce();
      const before = n(await tieredToken.balanceOf(ALICE));
      await withRetry(async () => {
        await smT.execute(ALICE, 50, no, [
          signTransfer(smT.address, ALICE, 50, no, ALICE_KEY),
        ]);
        if (!await smT.isNonceUsed(no)) throw new Error('SERVER_BUSY');
      });
      assert.equal(n(await tieredToken.balanceOf(ALICE)), before + 50);
      assert.equal(await smT.isNonceUsed(no), true);
    });

    it('amount ≤ 500 (tier 2, threshold 2): ALICE alone (weight 1) is not enough', async () => {
      const no = nextNonce();
      await smT.execute(ALICE, 300, no, [
        signTransfer(smT.address, ALICE, 300, no, ALICE_KEY),
      ]);
      assert.equal(await smT.isNonceUsed(no), false);
    });

    it('amount ≤ 500 (tier 2, threshold 2): OWNER alone (weight 2) succeeds', async () => {
      const no = nextNonce();
      const before = n(await tieredToken.balanceOf(ALICE));
      await withRetry(async () => {
        await smT.execute(ALICE, 300, no, [
          signTransfer(smT.address, ALICE, 300, no, OWNER_KEY),
        ]);
        if (!await smT.isNonceUsed(no)) throw new Error('SERVER_BUSY');
      });
      assert.equal(n(await tieredToken.balanceOf(ALICE)), before + 300);
      assert.equal(await smT.isNonceUsed(no), true);
    });

    it('amount ≤ 1000 (tier 3, threshold 3): OWNER alone (weight 2) is not enough', async () => {
      const no = nextNonce();
      await smT.execute(ALICE, 800, no, [
        signTransfer(smT.address, ALICE, 800, no, OWNER_KEY),
      ]);
      assert.equal(await smT.isNonceUsed(no), false);
    });

    it('amount ≤ 1000 (tier 3, threshold 3): both managers (weight 3) succeed', async () => {
      const no = nextNonce();
      const before = n(await tieredToken.balanceOf(ALICE));
      await withRetry(async () => {
        await smT.execute(ALICE, 800, no, [
          signTransfer(smT.address, ALICE, 800, no, OWNER_KEY),
          signTransfer(smT.address, ALICE, 800, no, ALICE_KEY),
        ]);
        if (!await smT.isNonceUsed(no)) throw new Error('SERVER_BUSY');
      });
      assert.equal(n(await tieredToken.balanceOf(ALICE)), before + 800);
      assert.equal(await smT.isNonceUsed(no), true);
    });

    it('amount > 1000 (above all tiers, forbidden): reverts with both signatures', async () => {
      const no = nextNonce();
      try {
        await smT.execute(ALICE, 2000, no, [
          signTransfer(smT.address, ALICE, 2000, no, OWNER_KEY),
          signTransfer(smT.address, ALICE, 2000, no, ALICE_KEY),
        ]);
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
      assert.equal(await smT.isNonceUsed(no), false);
    });

    it('executeBatch: forbidden item soft-fails, valid item succeeds', async () => {
      const n1 = nextNonce(), n2 = nextNonce();
      const before = n(await tieredToken.balanceOf(ALICE));

      const batch = [
        // forbidden amount (>1000) — soft-fail
        [ALICE, 2000, n1, [
          signTransfer(smT.address, ALICE, 2000, n1, OWNER_KEY),
          signTransfer(smT.address, ALICE, 2000, n1, ALICE_KEY),
        ]],
        // valid amount (≤100, threshold 1) — ALICE alone is enough
        [ALICE, 10, n2, [
          signTransfer(smT.address, ALICE, 10, n2, ALICE_KEY),
        ]],
      ];

      await withRetry(async () => {
        await smT.executeBatch(batch);
        if (!await smT.isNonceUsed(n2)) throw new Error('SERVER_BUSY');
      });

      assert.equal(await smT.isNonceUsed(n1), false);
      assert.equal(await smT.isNonceUsed(n2), true);
      assert.equal(n(await tieredToken.balanceOf(ALICE)), before + 10);
    });

    it('tier boundary: amount exactly equal to tier.maxAmount uses that tier (≤ is inclusive)', async () => {
      // amount=100 matches tier[0].maxAmount=100 exactly → threshold=1 → ALICE (weight 1) succeeds
      const no = nextNonce();
      const before = n(await tieredToken.balanceOf(ALICE));
      await withRetry(async () => {
        await smT.execute(ALICE, 100, no, [
          signTransfer(smT.address, ALICE, 100, no, ALICE_KEY),
        ]);
        if (!await smT.isNonceUsed(no)) throw new Error('SERVER_BUSY');
      });
      assert.equal(n(await tieredToken.balanceOf(ALICE)), before + 100);
      assert.equal(await smT.isNonceUsed(no), true);
    });

    it('tier boundary: amount one above tier.maxAmount escalates to next tier', async () => {
      // amount=101 > tier[0].maxAmount=100 → falls into tier[1] (threshold=2) → ALICE (weight 1) not enough
      const no = nextNonce();
      await smT.execute(ALICE, 101, no, [
        signTransfer(smT.address, ALICE, 101, no, ALICE_KEY),
      ]);
      assert.equal(await smT.isNonceUsed(no), false);
    });

    it('setTiers updates immediately — ALICE alone can no longer execute ≤100 after raising threshold', async () => {
      await withRetry(() => smT.setTiers([[999999, 2]]));
      const no = nextNonce();
      await smT.execute(ALICE, 50, no, [
        signTransfer(smT.address, ALICE, 50, no, ALICE_KEY),
      ]);
      assert.equal(await smT.isNonceUsed(no), false); // weight 1 < threshold 2 now
      // Restore
      await withRetry(() => smT.setTiers(TIERED_TIERS));
    });
  });

  // ─── MAX_BATCH_SIZE immutable — separate deployment ────────────────────────

  describe('MAX_BATCH_SIZE — custom constructor value', () => {
    let smSmall;

    before(async () => {
      await new Promise(r => setTimeout(r, 3000));
      let smallToken;
      await withRetry(async () => {
        smallToken = await MockTRC20.new();
        smSmall = await SpendingManager.new(
          OWNER,
          smallToken.address,
          [OWNER, ALICE],
          [1, 1],
          [0, 0], [0, 0], [0, 0], [0, 0],
          DEFAULT_TIERS,
          3   // MAX_BATCH_SIZE = 3
        );
      });
      await withRetry(() => smallToken.mint(OWNER, 1_000_000));
      await withRetry(() => smallToken.approve(smSmall.address, 1_000_000));
    });

    it('reports correct MAX_BATCH_SIZE', async () => {
      assert.equal(n(await smSmall.MAX_BATCH_SIZE()), 3);
    });

    it('batch of 3 succeeds', async () => {
      const batch = Array.from({ length: 3 }, () => {
        const no = nextNonce();
        return [ALICE, 1, no, [
          signTransfer(smSmall.address, ALICE, 1, no, OWNER_KEY),
          signTransfer(smSmall.address, ALICE, 1, no, ALICE_KEY),
        ]];
      });
      await smSmall.executeBatch(batch);
    });

    it('batch of 4 reverts', async () => {
      const batch = Array.from({ length: 4 }, () => {
        const no = nextNonce();
        return [ALICE, 1, no, [
          signTransfer(smSmall.address, ALICE, 1, no, OWNER_KEY),
          signTransfer(smSmall.address, ALICE, 1, no, ALICE_KEY),
        ]];
      });
      try {
        await smSmall.executeBatch(batch);
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
    });
  });

  // ─── Signature prefix — TRON and Ethereum ─────────────────────────────────
  //
  // The contract accepts both "\x19Ethereum Signed Message:\n32" (EIP-191, used
  // by server-side SigningKey and TronLink signMessageV2) and
  // "\x19TRON Signed Message:\n32" (used by TronLink Extension trx.sign()).
  // Managers may use either prefix freely; both count toward weight.

  describe('signature prefix — TRON and Ethereum', () => {
    let smPrefix;
    let prefixToken;

    before(async () => {
      await new Promise(r => setTimeout(r, 3000));
      let tok;
      await withRetry(async () => {
        tok = await MockTRC20.new();
        smPrefix = await SpendingManager.new(
          OWNER, tok.address,
          [OWNER, ALICE], [1, 1],
          [0, 0], [0, 0], [0, 0], [0, 0],
          DEFAULT_TIERS, 10
        );
      });
      prefixToken = tok;
      await withRetry(() => prefixToken.mint(OWNER, 1_000_000));
      await withRetry(() => prefixToken.approve(smPrefix.address, 1_000_000));
    });

    it('TRON-prefix: both managers sign with TRON prefix → accepted', async () => {
      const no = nextNonce();
      const before = n(await prefixToken.balanceOf(ALICE));
      const sigOwner = signTransferTron(smPrefix.address, ALICE, 10, no, OWNER_KEY);
      const sigAlice = signTransferTron(smPrefix.address, ALICE, 10, no, ALICE_KEY);
      await withRetry(async () => {
        await smPrefix.execute(ALICE, 10, no, [sigOwner, sigAlice]);
        if (!await smPrefix.isNonceUsed(no)) throw new Error('SERVER_BUSY');
      });
      assert.equal(n(await prefixToken.balanceOf(ALICE)), before + 10);
      assert.equal(await smPrefix.isNonceUsed(no), true);
    });

    it('Ethereum-prefix: backward compatible, still accepted', async () => {
      const no = nextNonce();
      const before = n(await prefixToken.balanceOf(ALICE));
      const sigOwner = signTransfer(smPrefix.address, ALICE, 5, no, OWNER_KEY);
      const sigAlice = signTransfer(smPrefix.address, ALICE, 5, no, ALICE_KEY);
      await withRetry(async () => {
        await smPrefix.execute(ALICE, 5, no, [sigOwner, sigAlice]);
        if (!await smPrefix.isNonceUsed(no)) throw new Error('SERVER_BUSY');
      });
      assert.equal(n(await prefixToken.balanceOf(ALICE)), before + 5);
      assert.equal(await smPrefix.isNonceUsed(no), true);
    });

    it('mixed: Ethereum-prefix (OWNER) + TRON-prefix (ALICE) → both count, threshold met', async () => {
      const no = nextNonce();
      const before = n(await prefixToken.balanceOf(ALICE));
      const sigOwner = signTransfer(smPrefix.address, ALICE, 7, no, OWNER_KEY);
      const sigAlice = signTransferTron(smPrefix.address, ALICE, 7, no, ALICE_KEY);
      await withRetry(async () => {
        await smPrefix.execute(ALICE, 7, no, [sigOwner, sigAlice]);
        if (!await smPrefix.isNonceUsed(no)) throw new Error('SERVER_BUSY');
      });
      assert.equal(n(await prefixToken.balanceOf(ALICE)), before + 7);
      assert.equal(await smPrefix.isNonceUsed(no), true);
    });

    it('TRON-prefix sig from unregistered address contributes 0 weight', async () => {
      const no = nextNonce();
      const carolSig = signTransferTron(smPrefix.address, ALICE, 1, no, CAROL_KEY);
      await smPrefix.execute(ALICE, 1, no, [carolSig]);
      assert.equal(await smPrefix.isNonceUsed(no), false);
    });

    it('single TRON-prefix sig below threshold — nonce stays free', async () => {
      const no = nextNonce();
      const sigOwner = signTransferTron(smPrefix.address, ALICE, 3, no, OWNER_KEY);
      await smPrefix.execute(ALICE, 3, no, [sigOwner]);
      assert.equal(await smPrefix.isNonceUsed(no), false);
    });
  });

  // ─── Energy cost capture (execute vs executeBatch) ─────────────────────────

  describe('energy — execute and batch sizes', () => {
    before(async () => {
      await withRetry(() => sm.setTiers(DEFAULT_TIERS));
      await withRetry(() => sm.setGlobalLimits(0, 0, 0, 0));
    });

    it('captures energy for execute() — 1 transfer', async () => {
      const no = nextNonce();
      let result;
      await withRetry(async () => {
        result = await sm.execute(
          ALICE, 1, no,
          [
            signTransfer(sm.address, ALICE, 1, no, OWNER_KEY),
            signTransfer(sm.address, ALICE, 1, no, ALICE_KEY),
          ]
        );
        if (!await sm.isNonceUsed(no)) throw new Error('SERVER_BUSY');
      });
      energyLog.push({ op: 'execute(1)', energy: await getEnergy(result) });
      assert.equal(await sm.isNonceUsed(no), true);
    });

    it('captures energy for executeBatch() — 2 transfers', async () => {
      const batch = Array.from({ length: 2 }, () => {
        const no = nextNonce();
        return [ALICE, 1, no, [
          signTransfer(sm.address, ALICE, 1, no, OWNER_KEY),
          signTransfer(sm.address, ALICE, 1, no, ALICE_KEY),
        ]];
      });
      const result = await sm.executeBatch(batch);
      energyLog.push({ op: 'executeBatch(2)', energy: await getEnergy(result) });
    });

    it('captures energy for executeBatch() — 5 transfers', async () => {
      const batch = Array.from({ length: 5 }, () => {
        const no = nextNonce();
        return [ALICE, 1, no, [
          signTransfer(sm.address, ALICE, 1, no, OWNER_KEY),
          signTransfer(sm.address, ALICE, 1, no, ALICE_KEY),
        ]];
      });
      const result = await sm.executeBatch(batch);
      energyLog.push({ op: 'executeBatch(5)', energy: await getEnergy(result) });
    });

    it('captures energy for executeBatch() — 10 transfers', async () => {
      const batch = Array.from({ length: 10 }, () => {
        const no = nextNonce();
        return [ALICE, 1, no, [
          signTransfer(sm.address, ALICE, 1, no, OWNER_KEY),
          signTransfer(sm.address, ALICE, 1, no, ALICE_KEY),
        ]];
      });
      const result = await sm.executeBatch(batch);
      energyLog.push({ op: 'executeBatch(10)', energy: await getEnergy(result) });
    });
  });

  // ─── Energy summary printed after all tests ───────────────────────────────

  after(() => {
    const TRX_USD       = 0.10;   // update to current TRX price
    const MARKET_SUN    = 420;    // TRON Energy Market spot rate (sun/energy) — TRX burned
    const ENERGY_PER_TRX_PER_DAY = 1500; // ~energy 1 staked TRX generates per day on mainnet
    const SUN_TRX       = 1e-6;

    const out = (s) => process.stdout.write(s + '\n');
    if (energyLog.length === 0) return;

    // Column inner widths (chars, excluding 1-space padding on each side)
    // op=22  en=11  usd_burn=10  usd_stake=10
    // Row = │(22+2)│(11+2)│(10+2)│(10+2)│ = 1+24+1+13+1+12+1+12+1 = 66 chars
    // INNER (between outer │) = 64 chars
    const W = { op: 22, en: 11, ub: 10, us: 10 };
    const INNER = (W.op+2) + (W.en+2) + (W.ub+2) + (W.us+2) + 3; // 3 inner │

    const SEP  = { tl:'┌', tr:'┐', bl:'└', br:'┘', lm:'├', rm:'┤', mc:'┼', tc:'┬', bc:'┴', h:'─', v:'│' };
    const dash = (n) => SEP.h.repeat(n);

    const topSep  = SEP.tl + dash(W.op+2) + SEP.tc + dash(W.en+2) + SEP.tc + dash(W.ub+2) + SEP.tc + dash(W.us+2) + SEP.tr;
    const midSep  = SEP.lm + dash(W.op+2) + SEP.mc + dash(W.en+2) + SEP.mc + dash(W.ub+2) + SEP.mc + dash(W.us+2) + SEP.rm;
    const noteSep = SEP.lm + dash(W.op+2) + SEP.bc + dash(W.en+2) + SEP.bc + dash(W.ub+2) + SEP.bc + dash(W.us+2) + SEP.rm;
    const botSep  = SEP.bl + dash(INNER) + SEP.br;

    function cell(text, w, align) {
      const s = String(text);
      return ' ' + (align === 'r' ? s.padStart(w) : s.padEnd(w)) + ' ';
    }
    function dataRow(op, en, ub, us) {
      return SEP.v + cell(op, W.op, 'l') + SEP.v + cell(en, W.en, 'r') +
             SEP.v + cell(ub, W.ub, 'r') + SEP.v + cell(us, W.us, 'r') + SEP.v;
    }
    function noteRow(text) {
      return SEP.v + text.padEnd(INNER) + SEP.v;
    }

    function fmt(energy) {
      const burnTrx  = energy * MARKET_SUN * SUN_TRX;
      const stakeTrx = Math.ceil(energy / ENERGY_PER_TRX_PER_DAY);
      return {
        usdBurn:  '$' + (burnTrx  * TRX_USD).toFixed(2),
        usdStake: '$' + (stakeTrx * TRX_USD).toFixed(2),
      };
    }

    out('');
    out(topSep);
    out(dataRow('Operation', 'Energy', '$ per call', '$ to lock'));
    out(dataRow('', 'units', '(no stake)', '(stake/day)'));
    out(midSep);

    for (const { op, energy } of energyLog) {
      const { usdBurn, usdStake } = fmt(energy);
      out(dataRow(op, energy.toLocaleString('en-US'), usdBurn, usdStake));
      const m = op.match(/\((\d+)\)/);
      if (m && parseInt(m[1]) > 1) {
        const perE = Math.round(energy / parseInt(m[1]));
        const f = fmt(perE);
        out(dataRow('  └─ per transfer', perE.toLocaleString('en-US'), f.usdBurn, f.usdStake));
      }
    }

    out(noteSep);
    out(noteRow('  $ per call = TRX burned every call (real money, gone forever)'));
    out(noteRow('  $ to lock  = capital staked per op/day (~1,500 energy/TRX)'));
    out(noteRow('               NOT consumed — recovered in full on unstake'));
    out(noteRow('               e.g. 10 calls/day needs $85 locked total'));
    out(noteRow('  Manager (caller) always pays $0, contract covers all energy'));
    out(botSep);
    out('');
  });

  // ─── View helpers ──────────────────────────────────────────────────────────

  describe('getManager', () => {
    it('returns correct config', async () => {
      const info = await sm.getManager(ALICE);
      assert.equal(info.active,          true);
      assert.equal(n(info.weight),       1);
      assert.equal(n(info.dailyLimit),   MGR_DAILY);
    });
  });

  describe('getManagerList', () => {
    it('returns at least OWNER and ALICE', async () => {
      const list = await sm.getManagerList();
      assert.ok(list.length >= 2);
    });
  });

  // ─── Security ──────────────────────────────────────────────────────────────

  describe('security', () => {
    let smSec;
    let secToken;

    before(async () => {
      await new Promise(r => setTimeout(r, 3000));
      secToken = await MockTRC20.new();
      smSec = await SpendingManager.new(
        OWNER, secToken.address,
        [OWNER], [1],
        [0], [0], [0], [0],
        [[999999, 1]], 10
      );
      await withRetry(() => secToken.mint(OWNER, 1_000_000));
      await withRetry(() => secToken.approve(smSec.address, 1_000_000));
    });

    it('non-manager cannot call execute()', async () => {
      const no = nextNonce();
      const sig = signTransfer(smSec.address, ALICE, 1, no, OWNER_KEY);
      try {
        await smSec.execute(ALICE, 1, no, [sig], { from: accounts[1] });
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
    });

    it('non-manager cannot call executeBatch()', async () => {
      const no = nextNonce();
      const sig = signTransfer(smSec.address, ALICE, 1, no, OWNER_KEY);
      try {
        await smSec.executeBatch([[ALICE, 1, no, [sig]]], { from: accounts[1] });
        assert.fail('should have reverted');
      } catch (e) {
        if (e.message === 'should have reverted') throw e;
      }
    });

    it('signature from unregistered address contributes 0 weight — threshold not met', async () => {
      // Only OWNER is a manager in smSec (weight=1, threshold=1).
      // A sig from CAROL (never registered) must not count toward threshold.
      const no = nextNonce();
      const carolSig = signTransfer(smSec.address, ALICE, 1, no, CAROL_KEY);
      await smSec.execute(ALICE, 1, no, [carolSig]); // OWNER submits; sig is from CAROL
      assert.equal(await smSec.isNonceUsed(no), false); // 0 valid weight < threshold 1
    });

    it('all active signers over personal limits → no valid weight → soft-fail', async () => {
      // Exhaust both managers' daily limits in main sm so neither sig counts.
      // OWNER daily=5000 (CFO_DAILY), ALICE daily=1000 (MGR_DAILY), threshold=2.
      await withRetry(() => sm.setManagerSpent(OWNER, CFO_DAILY, 0, 0, 0));
      await withRetry(() => sm.setManagerSpent(ALICE, MGR_DAILY, 0, 0, 0));
      const no = nextNonce();
      await withRetry(() => sm.execute(ALICE, 1, no, [
        signTransfer(sm.address, ALICE, 1, no, OWNER_KEY),
        signTransfer(sm.address, ALICE, 1, no, ALICE_KEY),
      ]));
      assert.equal(await sm.isNonceUsed(no), false);
      // cleanup
      await withRetry(() => sm.setManagerSpent(OWNER, 0, 0, 0, 0));
      await withRetry(() => sm.setManagerSpent(ALICE, 0, 0, 0, 0));
    });

    it('re-adding a removed manager starts with zeroed spent counters', async () => {
      await withRetry(async () => {
        await smSec.addManager(CAROL, 1, 0, 0, 0, 0);
        if (!await smSec.isManager(CAROL)) throw new Error('SERVER_BUSY');
      });
      await withRetry(async () => {
        await smSec.removeManager(CAROL);
        if (await smSec.isManager(CAROL)) throw new Error('SERVER_BUSY');
      });
      await withRetry(async () => {
        await smSec.addManager(CAROL, 1, 0, 0, 0, 0);
        if (!await smSec.isManager(CAROL)) throw new Error('SERVER_BUSY');
      });
      const info = await smSec.getManager(CAROL);
      assert.equal(n(info.dailySpent),   0, 'dailySpent reset on re-add');
      assert.equal(n(info.weeklySpent),  0, 'weeklySpent reset on re-add');
      assert.equal(n(info.monthlySpent), 0, 'monthlySpent reset on re-add');
      assert.equal(n(info.totalSpent),   0, 'totalSpent reset on re-add');
      await withRetry(() => smSec.removeManager(CAROL));
    });

    it('re-adding a removed manager does not duplicate getManagerList', async () => {
      // CAROL is currently inactive (removed at the end of the previous test).
      // The list already contains CAROL from that test's first add.
      // Re-adding must NOT push a second entry.
      const listBefore = (await smSec.getManagerList()).length;
      await withRetry(async () => {
        await smSec.addManager(CAROL, 1, 0, 0, 0, 0);
        if (!await smSec.isManager(CAROL)) throw new Error('SERVER_BUSY');
      });
      const listAfter = (await smSec.getManagerList()).length;
      assert.equal(listAfter, listBefore, 'list must not grow when re-adding a previously listed manager');
      await withRetry(() => smSec.removeManager(CAROL));
    });

    it('constructor with duplicate manager address reverts (M-02)', async () => {
      // Before the fix, _addManager had no active-guard and the constructor
      // would silently inflate totalActiveWeight. Now it must revert.
      try {
        await SpendingManager.new(
          OWNER, secToken.address,
          [OWNER, OWNER], [1, 2],
          [0, 0], [0, 0], [0, 0], [0, 0],
          [[999999, 1]], 10
        );
        assert.fail('should have reverted on duplicate manager');
      } catch (e) {
        if (e.message === 'should have reverted on duplicate manager') throw e;
      }
    });
  });
});
