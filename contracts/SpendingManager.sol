// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./interfaces/ITRC20.sol";
import "./interfaces/ISpendingManager.sol";

contract SpendingManager is ISpendingManager {
    string public constant VERSION = "1.0.0";

    // ─── Immutables ───────────────────────────────────────────────────────────

    uint256 public immutable MAX_BATCH_SIZE;

    // ─── State ────────────────────────────────────────────────────────────────

    address public override owner;
    address public override token;
    bool    public override paused;

    // Maintained on every add / remove / weight-change so tier checks are O(1).
    uint256 public override totalActiveWeight;

    AmountTier[] private _tiers;

    struct ManagerConfig {
        bool active;
        uint256 weight;
        // limits (0 = unlimited)
        uint256 dailyLimit;
        uint256 weeklyLimit;
        uint256 monthlyLimit;
        uint256 totalLimit;
        uint256 dailySpent;
        uint256 weeklySpent;
        uint256 monthlySpent;
        uint256 totalSpent;
        uint256 dailyPeriodStart;
        uint256 weeklyPeriodStart;
        uint256 monthlyPeriodStart;
    }

    mapping(address => ManagerConfig) private _managers;
    address[] private _managerList;
    mapping(address => bool) private _everListed;

    // global limits (0 = unlimited)
    uint256 public globalDailyLimit;
    uint256 public globalWeeklyLimit;
    uint256 public globalMonthlyLimit;
    uint256 public globalTotalLimit;

    uint256 public globalDailySpent;
    uint256 public globalWeeklySpent;
    uint256 public globalMonthlySpent;
    uint256 public globalTotalSpent;

    uint256 public globalDailyPeriodStart;
    uint256 public globalWeeklyPeriodStart;
    uint256 public globalMonthlyPeriodStart;

    // Packed nonce bitmap: slot = nonce >> 8, bit = 1 << (nonce & 0xff).
    // 256 nonces share one 32-byte storage slot — 256x cheaper than bool mapping
    // for sequential nonces; no worse for random ones.
    mapping(uint256 => uint256) private _nonceBitmap;

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier onlyActiveManager() {
        require(_managers[msg.sender].active, "Not an active manager");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Contract is paused");
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(
        address _owner,
        address _token,
        address[] memory managers,
        uint256[] memory weights,
        uint256[] memory dailyLimits,
        uint256[] memory weeklyLimits,
        uint256[] memory monthlyLimits,
        uint256[] memory totalLimits,
        AmountTier[] memory initialTiers,
        uint256 _maxBatchSize
    ) {
        require(_owner != address(0), "Invalid owner");
        require(_token != address(0), "Invalid token");
        require(_maxBatchSize > 0, "Invalid batch size");
        require(
            managers.length == weights.length &&
            managers.length == dailyLimits.length &&
            managers.length == weeklyLimits.length &&
            managers.length == monthlyLimits.length &&
            managers.length == totalLimits.length,
            "Array length mismatch"
        );

        owner    = _owner;
        token    = _token;
        MAX_BATCH_SIZE = _maxBatchSize;

        globalDailyPeriodStart   = block.timestamp;
        globalWeeklyPeriodStart  = block.timestamp;
        globalMonthlyPeriodStart = block.timestamp;

        for (uint256 i = 0; i < managers.length; i++) {
            _addManager(
                managers[i],
                weights[i],
                dailyLimits[i],
                weeklyLimits[i],
                monthlyLimits[i],
                totalLimits[i]
            );
        }

        // Tier validation happens after all managers are registered so
        // totalActiveWeight is fully populated.
        _validateAndStoreTiers(initialTiers);
    }

    // ─── Owner functions ──────────────────────────────────────────────────────

    function pause() external override onlyOwner {
        require(!paused, "Already paused");
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external override onlyOwner {
        require(paused, "Not paused");
        paused = false;
        emit Unpaused(msg.sender);
    }

    function addManager(
        address manager,
        uint256 weight,
        uint256 daily,
        uint256 weekly,
        uint256 monthly,
        uint256 total
    ) external override onlyOwner {
        _addManager(manager, weight, daily, weekly, monthly, total);
    }

    function removeManager(address manager) external override onlyOwner {
        require(_managers[manager].active, "Manager not active");
        uint256 newTotal = totalActiveWeight - _managers[manager].weight;
        _validateTiersAchievable(newTotal);
        totalActiveWeight = newTotal;
        _managers[manager].active = false;
        emit ManagerRemoved(manager);
    }

    function updateManagerLimits(
        address manager,
        uint256 daily,
        uint256 weekly,
        uint256 monthly,
        uint256 total
    ) external override onlyOwner {
        require(_managers[manager].active, "Manager not active");
        ManagerConfig storage m = _managers[manager];
        m.dailyLimit   = daily;
        m.weeklyLimit  = weekly;
        m.monthlyLimit = monthly;
        m.totalLimit   = total;
        emit ManagerLimitsUpdated(manager, daily, weekly, monthly, total);
    }

    function updateManagerWeight(address manager, uint256 newWeight) external override onlyOwner {
        require(_managers[manager].active, "Manager not active");
        require(newWeight > 0, "Weight must be > 0");
        uint256 oldWeight = _managers[manager].weight;
        uint256 newTotal  = totalActiveWeight - oldWeight + newWeight;
        _validateTiersAchievable(newTotal);
        totalActiveWeight          = newTotal;
        _managers[manager].weight  = newWeight;
        emit ManagerWeightUpdated(manager, newWeight);
    }

    function setTiers(AmountTier[] calldata newTiers) external override onlyOwner {
        AmountTier[] memory mem = new AmountTier[](newTiers.length);
        for (uint256 i = 0; i < newTiers.length; i++) {
            mem[i] = newTiers[i];
        }
        // Validate BEFORE touching state — a revert here leaves current tiers intact
        _validateTiers(mem);
        delete _tiers;
        for (uint256 i = 0; i < mem.length; i++) {
            _tiers.push(mem[i]);
        }
        emit TiersUpdated();
    }

    function setGlobalLimits(
        uint256 daily,
        uint256 weekly,
        uint256 monthly,
        uint256 total
    ) external override onlyOwner {
        globalDailyLimit   = daily;
        globalWeeklyLimit  = weekly;
        globalMonthlyLimit = monthly;
        globalTotalLimit   = total;
        emit GlobalLimitsUpdated(daily, weekly, monthly, total);
    }

    function setManagerSpent(
        address manager,
        uint256 daily,
        uint256 weekly,
        uint256 monthly,
        uint256 total
    ) external override onlyOwner {
        require(_managers[manager].active, "Manager not active");
        ManagerConfig storage m = _managers[manager];
        m.dailySpent   = daily;
        m.weeklySpent  = weekly;
        m.monthlySpent = monthly;
        m.totalSpent   = total;
        emit ManagerSpentUpdated(manager, daily, weekly, monthly, total);
    }

    function setGlobalSpent(
        uint256 daily,
        uint256 weekly,
        uint256 monthly,
        uint256 total
    ) external override onlyOwner {
        globalDailySpent   = daily;
        globalWeeklySpent  = weekly;
        globalMonthlySpent = monthly;
        globalTotalSpent   = total;
        emit GlobalSpentUpdated(daily, weekly, monthly, total);
    }

    // ─── Manager functions ────────────────────────────────────────────────────

    function execute(
        address recipient,
        uint256 amount,
        uint256 nonce,
        bytes[] calldata signatures
    ) external override onlyActiveManager whenNotPaused {
        require(!_isNonceUsed(nonce), "Nonce already used");
        require(recipient != address(0), "Invalid recipient");
        require(amount > 0, "Amount must be > 0");

        uint256 requiredThreshold = _getThreshold(amount);
        require(requiredThreshold > 0, "Amount exceeds maximum allowed");

        _resetGlobalPeriods();

        if (globalDailyLimit > 0)
            require(globalDailySpent + amount <= globalDailyLimit, "Global daily limit exceeded");
        if (globalWeeklyLimit > 0)
            require(globalWeeklySpent + amount <= globalWeeklyLimit, "Global weekly limit exceeded");
        if (globalMonthlyLimit > 0)
            require(globalMonthlySpent + amount <= globalMonthlyLimit, "Global monthly limit exceeded");
        if (globalTotalLimit > 0)
            require(globalTotalSpent + amount <= globalTotalLimit, "Global total limit exceeded");

        (uint256 validWeight, address[] memory validSigners, uint256 validCount) =
            _collectValidWeight(recipient, amount, nonce, signatures);

        if (validWeight < requiredThreshold) {
            emit TransferRejected(msg.sender, recipient, amount, nonce, "Insufficient signature weight");
            return;
        }

        _settle(recipient, amount, nonce, validSigners, validCount);
    }

    /// @notice Submit up to MAX_BATCH_SIZE transfers in one transaction.
    ///         Each transfer is processed independently — a rejected transfer
    ///         emits TransferRejected and is skipped; it does not revert the batch.
    function executeBatch(BatchTransfer[] calldata transfers) external override onlyActiveManager whenNotPaused {
        require(transfers.length > 0, "Empty batch");
        require(transfers.length <= MAX_BATCH_SIZE, "Batch too large");

        _resetGlobalPeriods();

        for (uint256 i = 0; i < transfers.length; i++) {
            _executeSingle(
                transfers[i].recipient,
                transfers[i].amount,
                transfers[i].nonce,
                transfers[i].signatures
            );
        }
    }

    // ─── Nonce bitmap ─────────────────────────────────────────────────────────

    function isNonceUsed(uint256 nonce) public view override returns (bool) {
        return _isNonceUsed(nonce);
    }

    function _isNonceUsed(uint256 nonce) internal view returns (bool) {
        return (_nonceBitmap[nonce >> 8] & (1 << (nonce & 0xff))) != 0;
    }

    function _markNonce(uint256 nonce) internal {
        _nonceBitmap[nonce >> 8] |= (1 << (nonce & 0xff));
    }

    // ─── View functions ───────────────────────────────────────────────────────

    function getTiers() external view override returns (AmountTier[] memory) {
        return _tiers;
    }

    function isManager(address manager) external view override returns (bool) {
        return _managers[manager].active;
    }

    function getManager(address manager) external view returns (
        bool active,
        uint256 weight,
        uint256 dailyLimit,
        uint256 weeklyLimit,
        uint256 monthlyLimit,
        uint256 totalLimit,
        uint256 dailySpent,
        uint256 weeklySpent,
        uint256 monthlySpent,
        uint256 totalSpent
    ) {
        ManagerConfig storage m = _managers[manager];
        return (
            m.active, m.weight,
            m.dailyLimit, m.weeklyLimit, m.monthlyLimit, m.totalLimit,
            m.dailySpent, m.weeklySpent, m.monthlySpent, m.totalSpent
        );
    }

    function getManagerList() external view returns (address[] memory) {
        return _managerList;
    }

    function getGlobalSpent() external view returns (
        uint256 daily,
        uint256 weekly,
        uint256 monthly,
        uint256 total
    ) {
        return (globalDailySpent, globalWeeklySpent, globalMonthlySpent, globalTotalSpent);
    }

    // ─── Internal: single transfer (soft-fail, used by executeBatch) ──────────

    function _executeSingle(
        address recipient,
        uint256 amount,
        uint256 nonce,
        bytes[] calldata signatures
    ) internal returns (bool) {
        if (_isNonceUsed(nonce)) {
            emit TransferRejected(msg.sender, recipient, amount, nonce, "Nonce already used");
            return false;
        }
        if (recipient == address(0)) {
            emit TransferRejected(msg.sender, recipient, amount, nonce, "Invalid recipient");
            return false;
        }
        if (amount == 0) {
            emit TransferRejected(msg.sender, recipient, amount, nonce, "Amount must be > 0");
            return false;
        }

        uint256 requiredThreshold = _getThreshold(amount);
        if (requiredThreshold == 0) {
            emit TransferRejected(msg.sender, recipient, amount, nonce, "Amount exceeds maximum allowed");
            return false;
        }

        if (globalDailyLimit > 0 && globalDailySpent + amount > globalDailyLimit) {
            emit TransferRejected(msg.sender, recipient, amount, nonce, "Global daily limit exceeded");
            return false;
        }
        if (globalWeeklyLimit > 0 && globalWeeklySpent + amount > globalWeeklyLimit) {
            emit TransferRejected(msg.sender, recipient, amount, nonce, "Global weekly limit exceeded");
            return false;
        }
        if (globalMonthlyLimit > 0 && globalMonthlySpent + amount > globalMonthlyLimit) {
            emit TransferRejected(msg.sender, recipient, amount, nonce, "Global monthly limit exceeded");
            return false;
        }
        if (globalTotalLimit > 0 && globalTotalSpent + amount > globalTotalLimit) {
            emit TransferRejected(msg.sender, recipient, amount, nonce, "Global total limit exceeded");
            return false;
        }

        (uint256 validWeight, address[] memory validSigners, uint256 validCount) =
            _collectValidWeight(recipient, amount, nonce, signatures);

        if (validWeight < requiredThreshold) {
            emit TransferRejected(msg.sender, recipient, amount, nonce, "Insufficient signature weight");
            return false;
        }

        _settle(recipient, amount, nonce, validSigners, validCount);
        return true;
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    function _addManager(
        address manager,
        uint256 weight,
        uint256 daily,
        uint256 weekly,
        uint256 monthly,
        uint256 total
    ) internal {
        require(manager != address(0), "Invalid manager address");
        require(weight > 0, "Weight must be > 0");
        require(!_managers[manager].active, "Manager already active");
        _managers[manager] = ManagerConfig({
            active: true,
            weight: weight,
            dailyLimit:   daily,
            weeklyLimit:  weekly,
            monthlyLimit: monthly,
            totalLimit:   total,
            dailySpent:   0,
            weeklySpent:  0,
            monthlySpent: 0,
            totalSpent:   0,
            dailyPeriodStart:   block.timestamp,
            weeklyPeriodStart:  block.timestamp,
            monthlyPeriodStart: block.timestamp
        });
        if (!_everListed[manager]) {
            _managerList.push(manager);
            _everListed[manager] = true;
        }
        totalActiveWeight += weight;
        emit ManagerAdded(manager, weight);
        emit ManagerLimitsUpdated(manager, daily, weekly, monthly, total);
    }

    /// Validates tier array structure (no storage writes). Safe to call before deleting existing tiers.
    function _validateTiers(AmountTier[] memory newTiers) internal view {
        require(newTiers.length > 0, "Must have at least one tier");
        for (uint256 i = 1; i < newTiers.length; i++) {
            require(
                newTiers[i].maxAmount > newTiers[i - 1].maxAmount,
                "Tiers must be in ascending order"
            );
        }
        for (uint256 i = 0; i < newTiers.length; i++) {
            require(newTiers[i].threshold > 0, "Tier threshold must be > 0");
            require(newTiers[i].threshold <= totalActiveWeight, "Tier threshold exceeds total manager weight");
        }
    }

    function _validateAndStoreTiers(AmountTier[] memory newTiers) internal {
        _validateTiers(newTiers);
        for (uint256 i = 0; i < newTiers.length; i++) {
            _tiers.push(newTiers[i]);
        }
    }

    /// Returns 0 if the amount exceeds all tiers (forbidden).
    function _getThreshold(uint256 amount) internal view returns (uint256) {
        for (uint256 i = 0; i < _tiers.length; i++) {
            if (amount <= _tiers[i].maxAmount) {
                return _tiers[i].threshold;
            }
        }
        return 0; // above all tiers = forbidden
    }

    function _validateTiersAchievable(uint256 newTotalWeight) internal view {
        for (uint256 i = 0; i < _tiers.length; i++) {
            require(
                _tiers[i].threshold <= newTotalWeight,
                "Would make a tier threshold unachievable"
            );
        }
    }

    /// Returns the valid signer set (only [0..validCount) populated) and their total weight.
    /// Resets each signer's period counters if their window has elapsed.
    /// Accepts both the Ethereum EIP-191 prefix and the TRON prefix so that managers
    /// using TronLink Extension (which applies "\x19TRON Signed Message:\n32") are
    /// treated the same as those signing server-side with the Ethereum prefix.
    function _collectValidWeight(
        address recipient,
        uint256 amount,
        uint256 nonce,
        bytes[] calldata signatures
    ) internal returns (uint256 validWeight, address[] memory validSigners, uint256 validCount) {
        bytes32 ethHash  = _buildMessageHash(recipient, amount, nonce);
        bytes32 tronHash = _buildTronMessageHash(recipient, amount, nonce);
        validSigners = new address[](signatures.length);
        validCount = 0;

        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = _tryRecover(ethHash, signatures[i]);
            if (signer == address(0) || !_managers[signer].active) {
                signer = _tryRecover(tronHash, signatures[i]);
            }

            if (!_managers[signer].active) continue;
            if (_contains(validSigners, validCount, signer)) continue;

            _resetManagerPeriods(signer);
            ManagerConfig storage m = _managers[signer];

            if (m.dailyLimit   > 0 && m.dailySpent   + amount > m.dailyLimit)   continue;
            if (m.weeklyLimit  > 0 && m.weeklySpent  + amount > m.weeklyLimit)  continue;
            if (m.monthlyLimit > 0 && m.monthlySpent + amount > m.monthlyLimit) continue;
            if (m.totalLimit   > 0 && m.totalSpent   + amount > m.totalLimit)   continue;

            validSigners[validCount++] = signer;
            validWeight += m.weight;
        }
    }

    /// Caller must have already validated weight >= requiredThreshold.
    function _settle(
        address recipient,
        uint256 amount,
        uint256 nonce,
        address[] memory validSigners,
        uint256 validCount
    ) internal {
        // CEI: all state changes before the external call so a reentrant token
        // cannot replay the nonce or double-count spent amounts.
        _markNonce(nonce);

        globalDailySpent   += amount;
        globalWeeklySpent  += amount;
        globalMonthlySpent += amount;
        globalTotalSpent   += amount;

        for (uint256 i = 0; i < validCount; i++) {
            ManagerConfig storage m = _managers[validSigners[i]];
            m.dailySpent   += amount;
            m.weeklySpent  += amount;
            m.monthlySpent += amount;
            m.totalSpent   += amount;
        }

        (bool success, bytes memory ret) = token.call(
            abi.encodeWithSelector(ITRC20.transferFrom.selector, owner, recipient, amount)
        );
        require(
            success && (ret.length == 0 || abi.decode(ret, (bool))),
            "transferFrom failed"
        );

        emit TransferExecuted(msg.sender, recipient, amount, nonce);
    }

    function _resetManagerPeriods(address managerAddr) internal {
        ManagerConfig storage m = _managers[managerAddr];
        if (block.timestamp >= m.dailyPeriodStart + 1 days) {
            m.dailySpent = 0;
            m.dailyPeriodStart = block.timestamp;
        }
        if (block.timestamp >= m.weeklyPeriodStart + 7 days) {
            m.weeklySpent = 0;
            m.weeklyPeriodStart = block.timestamp;
        }
        // Calendar-month reset: fires whenever block.timestamp is in a different
        // calendar month than the last reset, regardless of how many days have passed.
        if (_startOfMonth(block.timestamp) > _startOfMonth(m.monthlyPeriodStart)) {
            m.monthlySpent = 0;
            m.monthlyPeriodStart = block.timestamp;
        }
    }

    function _resetGlobalPeriods() internal {
        if (block.timestamp >= globalDailyPeriodStart + 1 days) {
            globalDailySpent = 0;
            globalDailyPeriodStart = block.timestamp;
        }
        if (block.timestamp >= globalWeeklyPeriodStart + 7 days) {
            globalWeeklySpent = 0;
            globalWeeklyPeriodStart = block.timestamp;
        }
        if (_startOfMonth(block.timestamp) > _startOfMonth(globalMonthlyPeriodStart)) {
            globalMonthlySpent = 0;
            globalMonthlyPeriodStart = block.timestamp;
        }
    }

    // Ethereum EIP-191 personal-sign prefix.
    function _buildMessageHash(
        address recipient,
        uint256 amount,
        uint256 nonce
    ) internal view returns (bytes32) {
        bytes32 rawHash = keccak256(abi.encodePacked(address(this), recipient, amount, nonce));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", rawHash));
    }

    // TRON personal-sign prefix (used by TronLink Extension trx.sign()).
    function _buildTronMessageHash(
        address recipient,
        uint256 amount,
        uint256 nonce
    ) internal view returns (bytes32) {
        bytes32 rawHash = keccak256(abi.encodePacked(address(this), recipient, amount, nonce));
        return keccak256(abi.encodePacked("\x19TRON Signed Message:\n32", rawHash));
    }

    /// Civil (Gregorian) calendar — Howard Hinnant's algorithm.
    /// Returns the Unix timestamp of midnight UTC on the 1st of the calendar
    /// month that contains `ts`.
    /// Test vectors (midnight UTC inputs):
    ///   2024-01-15 (1705276800) → 2024-01-01 (1704067200)
    ///   2024-03-15 (1710460800) → 2024-03-01 (1709251200)
    ///   2024-02-29 (1709164800) → 2024-02-01 (1706745600)
    function _startOfMonth(uint256 ts) internal pure returns (uint256) {
        uint256 d   = ts / 86400;
        uint256 z   = d + 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp  = (5 * doy + 2) / 153;
        uint256 dom = doy - (153 * mp + 2) / 5 + 1;   // day of month, 1-based
        return ts - (dom - 1) * 86400 - (ts % 86400);
    }

    // Returns address(0) on malformed or invalid sig — caller decides whether to fallback or skip.
    function _tryRecover(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        return ecrecover(hash, v, r, s);
    }

    function _contains(
        address[] memory arr,
        uint256 len,
        address addr
    ) internal pure returns (bool) {
        for (uint256 i = 0; i < len; i++) {
            if (arr[i] == addr) return true;
        }
        return false;
    }
}
