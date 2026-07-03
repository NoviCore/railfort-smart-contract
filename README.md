# Railfort Smart Contracts

Solidity contracts that power the Railfort treasury platform on TRON.

Owned by NoviCore. Off-chain integration lives in the separate
[`railfort-crypto-platform`](https://github.com/NoviCore/railfort-crypto-platform)
repo.

## Contracts

- **`SpendingManagerFactory`** — deployed once. Corporate clients call
  it to spin up a fresh `SpendingManager` per organization.
- **`SpendingManager`** — per-client contract. Never holds funds.
  Corporate wallet approves it to spend USDT; managers execute
  transfers within their assigned per-signer + global limits using
  weighted off-chain multisig.

See `docs/BACKEND.md` for the full integration contract (function
signatures, event shapes, signature scheme, nonce strategy, energy
model, upgrade path).

## Layout

```
contracts/          Solidity sources
test/               Foundry / Hardhat tests
scripts/            Deploy + verify helpers
docs/               BACKEND.md + any spec/design notes
artifacts/          (git-ignored) compiled JSON output
```

Pick whichever toolchain fits (tronbox, hardhat, foundry). Ship the
compiled JSON artifacts as GitHub Release assets — the off-chain
repo pulls them in at a pinned tag.

## Release contract

Each meaningful contract change ships as a versioned release:

1. Tag the commit — `v0.1.0`, `v0.2.0`, … (semver).
2. Create a GitHub Release for that tag.
3. Attach the compiled `SpendingManagerFactory.json` and
   `SpendingManager.json` (ABI + bytecode + `networks: {}`) as
   release assets.
4. If the contract was deployed on a network, update `networks:` in
   the JSON with the deployed address before attaching.

The off-chain repo commits those JSONs under `apps/api/contracts/`
pinned to a specific release tag. Version bumps in the contract →
one PR in the off-chain repo that re-syncs the artifacts, no CI
coupling, no submodules.

## Non-obvious constraints

- Contracts stay **private** in this repo until the audit lands +
  contracts hit mainnet. Then we open the repo publicly.
- No dependency on the off-chain repo. Contracts must build + test
  standalone.
- No off-chain secrets (RPC URLs, private keys, API tokens) land
  here — those live in the off-chain repo's SSM path.

## Contact

Katya + Arthur review PRs; ping in Slack for integration
questions.
