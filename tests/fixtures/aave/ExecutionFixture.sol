// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Local execution fixture, NOT the Aave protocol. It exercises signing, ERC20 approvals,
// Pool ABI/events, receipts and crash recovery. It provides no evidence of external acceptance.
contract FixtureToken {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "ALLOWANCE");
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "BALANCE");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

contract FixtureAToken {
    uint8 public constant decimals = 6;
    address public immutable UNDERLYING_ASSET_ADDRESS;
    address public immutable POOL;
    mapping(address => uint256) public balanceOf;

    constructor(address asset) {
        UNDERLYING_ASSET_ADDRESS = asset;
        POOL = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == POOL, "POOL_ONLY");
        balanceOf[to] += amount;
    }

    function redeem(address from, address to, uint256 amount) external {
        require(msg.sender == POOL, "POOL_ONLY");
        require(balanceOf[from] >= amount, "BALANCE");
        balanceOf[from] -= amount;
        require(FixtureToken(UNDERLYING_ASSET_ADDRESS).transfer(to, amount), "TRANSFER");
    }
}

contract FixturePool {
    address public immutable asset;
    FixtureAToken public immutable aToken;
    bool public paused;
    uint256 public debt;
    event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode);
    event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount);

    constructor(address token) {
        asset = token;
        aToken = new FixtureAToken(token);
    }

    function setPaused(bool value) external { paused = value; }
    function setDebt(uint256 value) external { debt = value; }

    function getConfiguration(address token) external view returns (uint256) {
        require(token == asset, "ASSET");
        return (uint256(6) << 48) | (uint256(1) << 56) | (paused ? uint256(1) << 60 : 0);
    }

    function getUserAccountData(address) external view returns (uint256, uint256, uint256, uint256, uint256, uint256) {
        return (0, debt, 0, 0, 0, type(uint256).max);
    }

    struct ReserveData {
        uint256 configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }

    function getReserveData(address token) external view returns (ReserveData memory result) {
        require(token == asset, "ASSET");
        result.liquidityIndex = 1e27;
        result.currentLiquidityRate = 5e25; // Fixture APR; token balances do not accrue real yield.
        result.aTokenAddress = address(aToken);
    }

    function supply(address token, uint256 amount, address onBehalfOf, uint16 referralCode) external {
        require(!paused && token == asset && amount > 0, "UNAVAILABLE");
        require(FixtureToken(asset).transferFrom(msg.sender, address(aToken), amount), "TRANSFER");
        aToken.mint(onBehalfOf, amount);
        emit Supply(token, msg.sender, onBehalfOf, amount, referralCode);
    }

    function withdraw(address token, uint256 amount, address to) external returns (uint256) {
        require(!paused && token == asset && amount > 0, "UNAVAILABLE");
        aToken.redeem(msg.sender, to, amount);
        emit Withdraw(token, msg.sender, to, amount);
        return amount;
    }
}
