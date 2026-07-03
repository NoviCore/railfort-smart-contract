# Backend Integration Guide — Delegated Spending Manager

## Overview

The system consists of two contracts deployed on TRON mainnet:

- **SpendingManagerFactory** — deployed once. The factory owner calls it to onboard a new corporate client, which deploys a fresh `SpendingManager` per client.
- **SpendingManager** — one instance per corporate client. Never holds funds. Acts as a gatekeeper: the corporate wallet approves it to spend its USDT, and managers execute transfers within their assigned limits using weighted off-chain multisig.

---

## Key Concepts

### The contract never holds funds

The corporate wallet (`owner`) holds all USDT. It calls `TOKEN.approve(spendingManagerAddress, type(uint256).max)` once. After that, the contract moves USDT from the corporate wallet to recipients using `transferFrom` — it never receives or stores tokens.

### Two roles

| Role | What they do |
|---|---|
| **Owner** (corporate wallet) | Deploys via factory, manages managers and limits, does NOT execute transfers |
| **Manager** | Signs payloads offline, submits signed transactions on-chain |

### Weighted multisig with tiered thresholds

Each manager has a `weight` (integer). The required weight sum depends on the **transfer amount** — different amount ranges require different thresholds. A transfer only executes if the sum of weights from valid signers meets or exceeds the threshold for that amount tier.

A signer's weight **does not count** if:
- Their manager account is inactive
- They are over any of their personal spending limits

### Amount tiers

The owner configures tiers at deploy time and can update them later. Example from the client diagram:

| Amount range | Required weight |
|---|---|
| ≤ 1,000 USDT | 1 signature |
| 1,001 – 10,000 USDT | 2 signatures |
| 10,001 – 20,000 USDT | 4 signatures |
| > 20,000 USDT | **Forbidden** |

Amounts above the highest tier's `maxAmount` are forbidden — the contract hard-reverts regardless of how many signatures are provided.

---

## Setup Flow

```
1. Factory owner calls createWallet(corporateOwner, token, managers, weights, limits, initialTiers, maxBatchSize)
   └─ Deploys a SpendingManager, registers it in the factory registry

2. Corporate wallet calls USDT.approve(spendingManagerAddress, 2^256-1)
   └─ Approve max once — never needs to be topped up

3. Backend stores:
   - SpendingManager contract address
   - List of manager addresses + their private keys (for signing)
   - Current nonce counter (starts at any value, must be unique per tx)
```

---

## Transaction Flow (single transfer)

```
Backend                          Manager devices               Contract
  │                                    │                          │
  ├─ build payload ───────────────────>│                          │
  │  { contractAddr, recipient,        │                          │
  │    amount, nonce }                 │                          │
  │                                    │                          │
  │<── sig1 (signed offline) ──────────┤                          │
  │<── sig2 (signed offline) ──────────┤                          │
  │                                    │                          │
  ├─ submit from any manager wallet ──────────────────────────>   │
  │  execute(recipient, amount,                                   │
  │          nonce, [sig1, sig2])                                 │
  │                                                               │
  │<── TransferExecuted event ────────────────────────────────────┤
  │    OR TransferRejected event                                  │
```

### Rules

- **One `execute()` call per nonce.** The backend must collect all required signatures BEFORE broadcasting. Do not have multiple managers submit independently — the second one will fail with "Nonce already used".
- **The submitter must be an active manager.** The proxy broadcasts from the manager's wallet, so `msg.sender` is the manager. This is checked by `onlyActiveManager`.
- **Backend pre-validates amount against tiers** before collecting signatures — no point collecting 4 signatures if the amount is forbidden.

---

## Batch Flow

```
execute(recipient, amount, nonce, sigs)     — single transfer, hard-fail on any error
executeBatch([transfer1, transfer2, ...])   — up to MAX_BATCH_SIZE transfers, soft-fail per item
```

In `executeBatch`, each transfer in the array is evaluated independently:
- If transfer #2 fails (bad nonce, over limit, insufficient weight, forbidden amount), it emits `TransferRejected` and skips to #3.
- It does **not** revert the whole batch.
- The backend must read all `TransferExecuted` and `TransferRejected` events from the tx receipt to know which items succeeded.

---

## Signature Scheme

### What to sign

```
hash = keccak256(abi.encodePacked(contractAddress, recipient, amount, nonce))
```

Packed encoding (104 bytes total):
```
bytes  0–19  : contractAddress  (20 bytes, EVM format — no 0x41 TRON prefix)
bytes 20–39  : recipient        (20 bytes, EVM format)
bytes 40–71  : amount           (32 bytes, big-endian uint256)
bytes 72–103 : nonce            (32 bytes, big-endian uint256)
```

### No personal-sign prefix

**Do NOT add the Ethereum personal-sign prefix (`\x19Ethereum Signed Message:\n32`).** Sign the raw `keccak256` hash directly.

TronWeb example:
```javascript
const { SigningKey, keccak256 } = tronWeb.utils.ethersUtils;

function buildHash(contractAddr, recipient, amount, nonce) {
  // pack manually: 20 + 20 + 32 + 32 bytes
  const buf = Buffer.alloc(104);
  Buffer.from(toEvmHex(contractAddr), 'hex').copy(buf, 0);
  Buffer.from(toEvmHex(recipient),    'hex').copy(buf, 20);
  writeBigEndianUint256(buf, 40, amount);
  writeBigEndianUint256(buf, 72, nonce);
  return keccak256('0x' + buf.toString('hex'));
}

function sign(contractAddr, recipient, amount, nonce, privateKeyHex) {
  const hash = buildHash(contractAddr, recipient, amount, nonce);
  const sig = new SigningKey('0x' + privateKeyHex).sign(hash);
  return sig.serialized; // 65-byte hex
}
```

`toEvmHex` converts a TRON base58 address to its 20-byte EVM hex form (strip the leading `41`, result is 40 hex chars with no prefix).

### Signature format

65 bytes:
- bytes 0–31: `r`
- bytes 32–63: `s`
- byte 64: `v` (27 or 28)

---

## Nonce Management

- Nonces are `uint256`. Any positive integer is valid.
- The contract tracks used nonces in `mapping(uint256 => bool) usedNonces`.
- The backend is responsible for generating unique nonces and persisting the current counter.
- If the backend loses its nonce state, query `usedNonces(n)` to check if a given nonce is already taken.
- Nonce `0` technically works but using `1` as the starting value avoids confusion.

---

## Limit System

### Per-manager limits (all four apply simultaneously)

| Limit | Reset cadence |
|---|---|
| `dailyLimit` | Rolling 24 hours from last reset |
| `weeklyLimit` | Rolling 7 days from last reset |
| `monthlyLimit` | Calendar month (resets on the 1st of each month, UTC) |
| `totalLimit` | Does not auto-reset — owner can reset manually via `setManagerSpent` |

### Global limits (across ALL managers combined)

Same four dimensions: `globalDailyLimit`, `globalWeeklyLimit`, `globalMonthlyLimit`, `globalTotalLimit`. Same reset cadence.

### Execution check order

```
1. Amount tier looked up — if forbidden, hard-fail (execute) or soft-fail (executeBatch)
2. Global limits checked
3. Per-manager limits checked per signer (determines if their weight counts)
4. If total valid weight >= tier threshold → execute transferFrom
5. Update all spent counters
```

### Pre-validation recommendation

The backend should validate before broadcasting:
1. Look up the amount tier — if forbidden, reject immediately without broadcasting
2. Call `getManager(address)` for per-manager spent state
3. Call `getGlobalSpent()` for global spent state
4. Confirm collected weight meets the required tier threshold

---

## All Contract Functions

### Owner-only functions

#### `createWallet` (factory)
```
factory.createWallet(
  corporateOwner,    // address: the wallet that will own the SpendingManager
  token,             // address: USDT-TRC20 contract address
  managers[],        // address[]: initial manager addresses
  weights[],         // uint256[]: signature weight per manager
  dailyLimits[],     // uint256[]: per-manager daily limit (0 = unlimited)
  weeklyLimits[],    // uint256[]: per-manager weekly limit
  monthlyLimits[],   // uint256[]: per-manager monthly limit
  totalLimits[],     // uint256[]: per-manager lifetime limit
  initialTiers[],    // AmountTier[]: [{maxAmount, threshold}, ...] sorted ascending
                     //   threshold=0 means that range is forbidden
                     //   amounts above last tier's maxAmount are also forbidden
  maxBatchSize       // uint256: maximum transfers per executeBatch call (immutable after deploy)
)
```

#### `getWallets(address corporateOwner)` → `address[]` (factory)
Returns all SpendingManager addresses deployed for a given corporate owner. This is how the backend discovers the contract address after `createWallet` is called.

#### `totalWallets()` → `uint256` (factory)
Total number of SpendingManager contracts ever deployed by this factory.

#### `allWallets(uint256 index)` → `address` (factory)
Returns a deployed SpendingManager address by index (across all owners).

---

#### `addManager(address, weight, daily, weekly, monthly, total)`
Adds a new active manager. Cannot add an already-active manager.

#### `removeManager(address)`
Deactivates a manager. Reverts if removing them would make any tier threshold unachievable.

#### `updateManagerLimits(address, daily, weekly, monthly, total)`
Updates all four spending limits for a manager. Takes effect immediately.

#### `updateManagerWeight(address, newWeight)`
Updates a manager's signature weight. Reverts if the new total weight would make any tier threshold unachievable.

#### `setTiers(tiers[])`
Replaces all amount tiers. Each tier: `{ maxAmount: uint256, threshold: uint256 }`. Must be sorted ascending by `maxAmount`. `threshold=0` means that range is forbidden. Reverts if any non-zero threshold exceeds current `totalActiveWeight`.

```javascript
// Example: client's diagram configuration (amounts in USDT base units, 6 decimals)
await sm.setTiers([
  { maxAmount: 1_000_000000,  threshold: 1 },  // ≤1k USDT: 1 sig
  { maxAmount: 10_000_000000, threshold: 2 },  // ≤10k USDT: 2 sigs
  { maxAmount: 20_000_000000, threshold: 4 },  // ≤20k USDT: 4 sigs
  // above 20k: forbidden (no tier matches)
]);
```

#### `setGlobalLimits(daily, weekly, monthly, total)`
Sets the four global limits. Setting a value to 0 means unlimited.

#### `setManagerSpent(address, daily, weekly, monthly, total)`
Sets a manager's spent counters directly to any value. Use cases:
- **Reset**: set all to 0 at the start of a new budget period
- **Migration**: set to match amounts already spent in a prior system mid-period
- **Emergency block**: set daily to the manager's full daily limit to block them immediately without removing them

Setting a counter above the corresponding limit blocks that manager for the rest of that period.

#### `setGlobalSpent(daily, weekly, monthly, total)`
Same as above but for the global (contract-wide) spent counters.

#### `transferOwnership(address newOwner)`
Initiates a two-step ownership transfer. Sets `pendingOwner` to `newOwner` but does **not** change `owner` yet. Emits `OwnershipTransferInitiated`.

#### `acceptOwnership()`
Completes the ownership transfer. Must be called by the `pendingOwner` address. Clears `pendingOwner` and sets `owner` to the caller. Emits `OwnershipTransferred`.

#### `pause()` / `unpause()`
Pauses or unpauses all `execute()` and `executeBatch()` calls. Emergency stop.

---

### Manager functions

#### `execute(recipient, amount, nonce, signatures[])`
Submits a single transfer. Called by an active manager. Hard-fails (reverts) on:
- Contract is paused
- Amount exceeds maximum allowed (no matching tier or tier has threshold=0)
- Nonce already used
- Recipient is zero address
- Amount is zero
- Global limit exceeded

Soft-fails (emits `TransferRejected`, does **NOT** revert, energy still consumed) on:
- Insufficient valid signature weight

> ⚠️ A soft-fail means the transaction **lands on-chain and succeeds** — no exception is thrown, gas is consumed, but no tokens move and the nonce stays free. Always check the receipt for a `TransferRejected` event even on single `execute()` calls, not just on batches.

#### `executeBatch(transfers[])`
Submits up to `MAX_BATCH_SIZE` transfers in one transaction. All items share a single global-period reset at the start. Each item is evaluated independently with soft-fail semantics.

```solidity
struct BatchTransfer {
    address  recipient;
    uint256  amount;
    uint256  nonce;
    bytes[]  signatures;
}
```

---

### View functions

#### `getTiers()` → `AmountTier[]`
Returns all configured amount tiers. Each tier has `maxAmount` and `threshold`. Use this to pre-validate amounts before collecting signatures.

#### `getManager(address)` → `(active, weight, dailyLimit, weeklyLimit, monthlyLimit, totalLimit, dailySpent, weeklySpent, monthlySpent, totalSpent)`
Full state of a manager including current spent counters.

#### `getGlobalSpent()` → `(daily, weekly, monthly, total)`
Current global spent counters.

#### `isManager(address)` → `bool`
Returns `true` if the address is currently an active manager.

#### `usedNonces(uint256)` → `bool`
Returns `true` if a nonce has been consumed.

#### `owner()`, `pendingOwner()`, `token()`, `paused()`, `totalActiveWeight()`, `MAX_BATCH_SIZE()`
Public state variables. `pendingOwner()` returns the address waiting to accept ownership (zero address if no transfer in progress).

#### `globalDailyLimit()`, `globalWeeklyLimit()`, `globalMonthlyLimit()`, `globalTotalLimit()`
Current global spending caps (0 = unlimited). Read these before broadcasting to pre-validate against global limits.

#### `getManagerList()` → `address[]`
> ⚠️ Returns **all managers ever registered**, including inactive (removed) ones. Deduplicate and filter by `isManager(address)` when iterating.

---

## Events

### `TransferExecuted(submitter, recipient, amount, nonce)`
Emitted when a transfer succeeds. Index by `nonce` to correlate with the original payload.

### `TransferRejected(submitter, recipient, amount, nonce, reason)`
Emitted when a transfer fails without reverting. Fired by both `execute()` (on insufficient weight) and `executeBatch()` (on any per-item failure). Reasons:

| Reason | Nonce still usable? | Action |
|---|---|---|
| `"Nonce already used"` | No | Do not retry |
| `"Invalid recipient"` | No | Fix payload |
| `"Amount must be > 0"` | No | Fix payload |
| `"Amount exceeds maximum allowed"` | No | Amount is forbidden by tier config |
| `"Global daily/weekly/monthly/total limit exceeded"` | No | Wait for reset or adjust limit |
| `"Insufficient signature weight"` | **Yes** | Collect more signatures and retry |

### `OwnershipTransferInitiated(previousOwner, newOwner)`
### `OwnershipTransferred(previousOwner, newOwner)`
### `ManagerAdded(manager, weight)`
### `ManagerRemoved(manager)`
### `ManagerLimitsUpdated(manager, daily, weekly, monthly, total)`
### `ManagerWeightUpdated(manager, newWeight)`
### `TiersUpdated()`
Emitted when `setTiers()` is called. Backend should re-read `getTiers()` after receiving this event.
### `ManagerSpentUpdated(manager, daily, weekly, monthly, total)`
### `GlobalSpentUpdated(daily, weekly, monthly, total)`
### `GlobalLimitsUpdated(daily, weekly, monthly, total)`
### `Paused(account)` / `Unpaused(account)`

---

## Energy & feeLimit

Every transaction on TRON costs energy. The contract owner is responsible for having enough energy staked (or TRX available to burn).

### Estimated costs per operation

| Operation | Energy | Cost (no stake) | Capital to stake |
|---|---|---|---|
| `execute()` — 1 transfer | ~134,500 | ~$5.65 | ~$9.00/day |
| `executeBatch()` — 2 transfers | ~267,000 | ~$11.23 | ~$17.90/day |
| `executeBatch()` — 5 transfers | ~662,700 | ~$27.83 | ~$44.20/day |

*Costs at 420 sun/energy, TRX = $0.10. Staked capital is recovered on unstake.*

### feeLimit

Set `feeLimit` on every broadcast. Recommended: `1000 * 1e6` (1000 TRX) — well above actual cost, prevents accidental failures. TronBox default is already set to this.

### New recipient surcharge

Sending USDT to an address that has **never held USDT before** costs approximately **2× the normal energy**. The energy estimation endpoint (`wallet/estimateenergy`) accounts for this dynamically — always estimate per-transaction rather than using a fixed value.

### Energy delegation flow

1. Call QuickNode `wallet/estimateenergy` to get the energy requirement for the specific transaction
2. Request energy delegation from the client's energy provider API
3. Broadcast the transaction via QuickNode once delegation is confirmed

---

## Allowance

The corporate wallet calls `USDT.approve(spendingManagerAddress, 2**256 - 1)` once at setup — effectively unlimited, never needs topping up. Backend monitors allowance as a safety check but should never need to act on it.

---

## Resolved Design Decisions

| Decision | Outcome |
|---|---|
| `totalLimit` semantics | Not a hard lifetime cap — owner can reset/adjust via `setManagerSpent`. |
| Daily/weekly reset cadence | Rolling windows (24h / 7d). Monthly is calendar-aligned (resets on the 1st UTC). |
| Custom configurable time windows | Dropped — current daily/weekly/monthly structure is sufficient. |
| Upgradeability | No proxy pattern. New features = deploy new contract via factory. |
| Lowering limits below current spent | Intentional — immediately blocks that manager for the rest of the period. Emergency use. |
