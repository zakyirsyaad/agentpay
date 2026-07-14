// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../script/DeployAgentPayAccountV2.s.sol";
import "../src/AgentPayAccountV2.sol";

contract DeployAgentPayAccountV2Test {
    address private constant OWNER = address(0x1234);
    address private constant EXECUTOR = address(0x5678);
    address private constant ROUTE_TARGET = address(0x7777);
    address private constant XLAYER_USDT0 = 0x779Ded0c9e1022225f8E0630b35a9b54bE713736;
    address private constant XLAYER_TESTNET_USDC = 0xcB8BF24c6cE16Ad21D707c9505421a17f2bec79D;

    function testDeploysOwnerSignedV2WithDefaultStableTokenAllowlist() public {
        DeployAgentPayAccountV2 deployer = new DeployAgentPayAccountV2();
        address[] memory routeTargets = new address[](0);

        AgentPayAccountV2 account = deployer.deploy(OWNER, EXECUTOR, routeTargets);

        assert(account.owner() == OWNER);
        assert(account.executor() == EXECUTOR);
        assert(account.allowedTokens(XLAYER_USDT0));
        assert(!account.allowedTokens(XLAYER_TESTNET_USDC));
        assert(!account.allowedRouteTargets(ROUTE_TARGET));
        assert(account.domainSeparator() != bytes32(0));
    }

    function testDefaultAllowedTokensAreXLayerStablecoins() public {
        DeployAgentPayAccountV2 deployer = new DeployAgentPayAccountV2();
        address[] memory tokens = deployer.defaultAllowedTokens();

        assert(tokens.length == 1);
        assert(tokens[0] == XLAYER_USDT0);
    }

    function testMainnetDeploymentSurfaceRejectsUSDC() public {
        DeployAgentPayAccountV2 deployer = new DeployAgentPayAccountV2();
        AgentPayAccountV2 account = deployer.deploy(OWNER, EXECUTOR, new address[](0));

        assert(account.allowedTokens(XLAYER_USDT0));
        assert(!account.allowedTokens(XLAYER_TESTNET_USDC));
    }

    function testMainnetDeploymentSurfaceRejectsRouteTargets() public {
        DeployAgentPayAccountV2 deployer = new DeployAgentPayAccountV2();
        address[] memory routeTargets = new address[](1);
        routeTargets[0] = ROUTE_TARGET;

        bool reverted;
        try deployer.deploy(OWNER, EXECUTOR, routeTargets) returns (AgentPayAccountV2) {
            reverted = false;
        } catch (bytes memory reason) {
            reverted = reason.length >= 4;
        }

        assert(reverted);
    }

    function testTestnetDeploymentSurfaceKeepsUSDT0AndUSDC() public {
        DeployAgentPayAccountV2 deployer = new DeployAgentPayAccountV2();
        address[] memory tokens = deployer.defaultAllowedTokensForChain(1952);

        assert(tokens.length == 2);
        assert(tokens[0] == 0x9e29b3AaDa05Bf2D2c827Af80Bd28Dc0b9b4FB0c);
        assert(tokens[1] == XLAYER_TESTNET_USDC);
    }

    function testUnsupportedChainReverts() public {
        DeployAgentPayAccountV2 deployer = new DeployAgentPayAccountV2();
        bool reverted;

        try deployer.defaultAllowedTokensForChain(1) returns (address[] memory) {
            reverted = false;
        } catch (bytes memory reason) {
            reverted = reason.length >= 4;
        }

        assert(reverted);
    }
}
