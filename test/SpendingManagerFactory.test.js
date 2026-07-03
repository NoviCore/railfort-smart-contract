require('dotenv').config();
const SpendingManagerFactory = artifacts.require('SpendingManagerFactory');
const SpendingManager        = artifacts.require('SpendingManager');
const MockTRC20              = artifacts.require('MockTRC20');
const { toEthHex, privateKeyToTronAddr, n, withRetry, ZERO_ADDR } = require('./helpers');

const ALICE_KEY = '75065f100e38d3f3b4c5c4235834ba8216de62272a4f03532c44b31a5734360a';
const ALICE     = privateKeyToTronAddr(ALICE_KEY);

contract('SpendingManagerFactory', (accounts) => {
  const FACTORY_OWNER = accounts[0];

  let factory;
  let token;

  before(async () => {
    // Wait for a new block before deploying — avoids DUP_TRANSACTION_ERROR
    // if SpendingManager tests deployed the same MockTRC20 bytecode recently.
    await new Promise(r => setTimeout(r, 4000));
    factory = await SpendingManagerFactory.new();
    token   = await MockTRC20.new();
  });

  // ─── Deployment ────────────────────────────────────────────────────────────

  describe('deployment', () => {
    it('sets factory owner', async () => {
      assert.equal(toEthHex(await factory.owner()), toEthHex(FACTORY_OWNER));
    });

    it('starts with zero wallets', async () => {
      assert.equal(n(await factory.totalWallets()), 0);
    });

    it('VERSION is 1.0.0', async () => {
      assert.equal(await factory.VERSION(), '1.0.0');
    });

  });

  // ─── createWallet ──────────────────────────────────────────────────────────

  describe('createWallet', () => {
    it('deploys a SpendingManager and registers it', async () => {
      await withRetry(async () => {
        const before = n(await factory.totalWallets());
        await factory.createWallet(
          FACTORY_OWNER,
          token.address,
          [FACTORY_OWNER, ALICE],
          [1, 1],
          [5000, 1000],
          [20000, 5000],
          [80000, 20000],
          [500000, 100000],
          [[999999, 2]],
          10   // maxBatchSize
        );
        const after = n(await factory.totalWallets());
        if (after === before) throw new Error('SERVER_BUSY');
      });

      assert.equal(n(await factory.totalWallets()), 1);

      const list = await factory.getWallets(FACTORY_OWNER);
      assert.equal(list.length, 1);
    });

    it('deployed SpendingManager is correctly configured', async () => {
      const list  = await factory.getWallets(FACTORY_OWNER);
      const sm    = await SpendingManager.at(list[0]);

      assert.equal(toEthHex(await sm.owner()),       toEthHex(FACTORY_OWNER));
      assert.equal(toEthHex(await sm.token()),       toEthHex(token.address));
      const tiers = await sm.getTiers();
      assert.equal(tiers.length, 1);
      assert.equal(n(tiers[0][1]), 2); // threshold
      assert.equal(await sm.isManager(FACTORY_OWNER), true);
      assert.equal(await sm.isManager(ALICE),          true);
    });

    it('address is stored in allWallets', async () => {
      const list = await factory.getWallets(FACTORY_OWNER);
      const all  = await factory.allWallets(0);
      assert.equal(toEthHex(all), toEthHex(list[0]));
    });

    it('can create a second wallet for a different owner', async () => {
      await withRetry(async () => {
        const before = n(await factory.totalWallets());
        await factory.createWallet(
          ALICE,
          token.address,
          [ALICE],
          [1],
          [2000],
          [8000],
          [30000],
          [200000],
          [[999999, 1]],
          10   // maxBatchSize
        );
        if (n(await factory.totalWallets()) === before) throw new Error('SERVER_BUSY');
      });

      assert.equal(n(await factory.totalWallets()), 2);
      assert.equal((await factory.getWallets(ALICE)).length, 1);
    });
  });

});
