// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./interfaces/ISpendingManager.sol";
import "./SpendingManager.sol";

contract SpendingManagerFactory {
    string public constant VERSION = "1.0.0";

    address public owner;

    mapping(address => address[]) private _wallets;
    address[] public allWallets;

    event WalletCreated(address indexed corporateOwner, address contractAddress);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not factory owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // ─── Factory functions ────────────────────────────────────────────────────

    /// @notice Deploy a new SpendingManager for a corporate client.
    /// @param corporateOwner         The wallet that will own the SpendingManager
    /// @param token                  TRC-20 token address managed by this contract
    /// @param managers               Initial manager addresses
    /// @param weights                Signature weight per manager
    /// @param dailyLimits            Per-manager daily spending limit (0 = unlimited)
    /// @param weeklyLimits           Per-manager weekly spending limit (0 = unlimited)
    /// @param monthlyLimits          Per-manager monthly spending limit (0 = unlimited)
    /// @param totalLimits            Per-manager lifetime spending limit (0 = unlimited)
    /// @param initialTiers           Amount tiers sorted by maxAmount ascending
    /// @param maxBatchSize           Maximum transfers per executeBatch call (immutable)
    function createWallet(
        address corporateOwner,
        address token,
        address[] calldata managers,
        uint256[] calldata weights,
        uint256[] calldata dailyLimits,
        uint256[] calldata weeklyLimits,
        uint256[] calldata monthlyLimits,
        uint256[] calldata totalLimits,
        ISpendingManager.AmountTier[] calldata initialTiers,
        uint256 maxBatchSize
    ) external onlyOwner returns (address) {
        SpendingManager wallet = new SpendingManager(
            corporateOwner,
            token,
            managers,
            weights,
            dailyLimits,
            weeklyLimits,
            monthlyLimits,
            totalLimits,
            initialTiers,
            maxBatchSize
        );

        address walletAddr = address(wallet);
        _wallets[corporateOwner].push(walletAddr);
        allWallets.push(walletAddr);

        emit WalletCreated(corporateOwner, walletAddr);
        return walletAddr;
    }

    // ─── View functions ───────────────────────────────────────────────────────

    function getWallets(address corporateOwner) external view returns (address[] memory) {
        return _wallets[corporateOwner];
    }

    function totalWallets() external view returns (uint256) {
        return allWallets.length;
    }
}
