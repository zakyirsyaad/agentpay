// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/AgentPayAccountV2.sol";

interface VmV2Deploy {
    function envAddress(string calldata name) external returns (address);
    function envOr(string calldata name, address defaultValue) external returns (address);
    function envUint(string calldata name) external returns (uint256);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @notice Deploys only the non-upgradeable owner-signed AgentPayAccountV2.
/// @dev The legacy DeployAgentPayAccount script remains available for migration tests only.
contract DeployAgentPayAccountV2 {
    address internal constant VM_ADDRESS = address(uint160(uint256(keccak256("hevm cheat code"))));
    uint256 public constant XLAYER_CHAIN_ID = 196;
    uint256 public constant XLAYER_TESTNET_CHAIN_ID = 1952;
    address public constant XLAYER_USDT0 = 0x779Ded0c9e1022225f8E0630b35a9b54bE713736;
    address public constant XLAYER_TESTNET_USDT0 = 0x9e29b3AaDa05Bf2D2c827Af80Bd28Dc0b9b4FB0c;
    address public constant XLAYER_TESTNET_USDC = 0xcB8BF24c6cE16Ad21D707c9505421a17f2bec79D;

    VmV2Deploy internal constant vm = VmV2Deploy(VM_ADDRESS);

    event AgentPayAccountV2Deployed(address indexed account, address indexed owner, address indexed executor);
    error UnsupportedDeployChain(uint256 chainId);
    error MainnetRouteTargetsForbidden(uint256 count);

    function run() external returns (AgentPayAccountV2 account) {
        uint256 deployerPrivateKey = vm.envUint("SETUP_DEPLOYER_PRIVATE_KEY");
        address owner = vm.envAddress("AGENTPAY_OWNER_ADDRESS");
        address executor = vm.envAddress("AGENTPAY_EXECUTOR_ADDRESS");
        address[] memory initialRouteTargets = new address[](0);

        vm.startBroadcast(deployerPrivateKey);
        account = deployForChain(owner, executor, initialRouteTargets, block.chainid);
        vm.stopBroadcast();
    }

    function deploy(address owner, address executor, address[] memory initialRouteTargets)
        public
        returns (AgentPayAccountV2 account)
    {
        account = deployForChain(owner, executor, initialRouteTargets, XLAYER_CHAIN_ID);
    }

    function deployForChain(address owner, address executor, address[] memory initialRouteTargets, uint256 chainId)
        public
        returns (AgentPayAccountV2 account)
    {
        if (chainId == XLAYER_CHAIN_ID && initialRouteTargets.length != 0) {
            revert MainnetRouteTargetsForbidden(initialRouteTargets.length);
        }
        account = new AgentPayAccountV2(owner, executor, defaultAllowedTokensForChain(chainId), initialRouteTargets);
        emit AgentPayAccountV2Deployed(address(account), owner, executor);
    }

    function defaultAllowedTokens() public returns (address[] memory tokens) {
        return defaultAllowedTokensForChain(XLAYER_CHAIN_ID);
    }

    function defaultAllowedTokensForChain(uint256 chainId) public returns (address[] memory tokens) {
        if (chainId == XLAYER_CHAIN_ID) {
            // Mainnet golden path: USDT0 only. USDC must never be enabled by
            // the production deployment surface.
            tokens = new address[](1);
            tokens[0] = XLAYER_USDT0;
            return tokens;
        }
        if (chainId == XLAYER_TESTNET_CHAIN_ID) {
            tokens = new address[](2);
            tokens[0] = vm.envOr("AGENTPAY_XLAYER_TESTNET_USDT0_ADDRESS", XLAYER_TESTNET_USDT0);
            tokens[1] = vm.envOr("AGENTPAY_XLAYER_TESTNET_USDC_ADDRESS", XLAYER_TESTNET_USDC);
            return tokens;
        }
        revert UnsupportedDeployChain(chainId);
    }
}
