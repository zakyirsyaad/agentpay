// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// RED suite for I-002.1. The imported contract is intentionally not present
// until I-002.2. This file is the executable security specification for the
// fresh non-upgradeable, owner-signed AgentPayAccountV2 surface.
// Activate it after I-002.2 with:
//   FOUNDRY_TEST=spec forge test --match-path AgentPayAccountV2.t.sol
import {AgentPayAccountV2} from "../src/AgentPayAccountV2.sol";

interface VmV2 {
    function addr(uint256 privateKey) external returns (address);
    function chainId(uint256 newChainId) external;
    function deal(address account, uint256 balance) external;
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData) external;
    function expectRevert() external;
    function expectRevert(bytes calldata revertData) external;
    function prank(address sender) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function startPrank(address sender) external;
    function stopPrank() external;
    function warp(uint256 newTimestamp) external;
}

interface IAuthorizedV2Account {
    function executeAuthorizedDirectPayment(
        AgentPayAccountV2.DirectPaymentAuthorization calldata authorization,
        bytes calldata signature
    ) external;
}

contract MockV2ERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient balance");
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract FalseReturnV2ERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }
}

contract MockV2RouteTarget {
    function route(address token, address recipient, uint256 amount) external payable {
        MockV2ERC20(token).transferFrom(msg.sender, recipient, amount);
    }
}

contract RevertingV2RouteTarget {
    function route(address, address, uint256) external pure {
        revert("route target failed");
    }
}

contract ReentrantV2RouteTarget {
    address private immutable account;
    bytes private callback;
    bytes private outerCall;

    constructor(address accountAddress, bytes memory callbackData) {
        account = accountAddress;
        callback = callbackData;
    }

    function setOuterCall(bytes memory outerCallData) external {
        outerCall = outerCallData;
    }

    function start() external {
        (bool success, bytes memory reason) = account.call(outerCall);
        if (!success) {
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }
    }

    function route(address token, address recipient, uint256 amount) external {
        MockV2ERC20(token).transferFrom(msg.sender, recipient, amount);

        (bool success, bytes memory reason) = account.call(callback);
        if (!success) {
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }
    }
}

contract LegacySelectorCaller {
    function callLegacyDirect(address account, address token, address recipient, uint256 amount)
        external
        returns (bool success, bytes memory result)
    {
        bytes memory callData = abi.encodeWithSignature(
            "executeDirectPayment((address,address,uint256,uint256,uint256))",
            token,
            recipient,
            amount,
            1,
            block.timestamp + 60
        );
        (success, result) = account.call(callData);
    }

    function callLegacyRoute(address account, address token, address recipient, address routeTarget)
        external
        returns (bool success, bytes memory result)
    {
        bytes memory routeCalldata = abi.encodeCall(MockV2RouteTarget.route, (token, recipient, 100));
        bytes memory callData = abi.encodeWithSignature(
            "executeRoutePayment((address,uint256,uint256,address,uint256,address,bytes32,uint256,uint256,uint256),bytes)",
            token,
            100,
            block.chainid + 1,
            recipient,
            100,
            routeTarget,
            keccak256(routeCalldata),
            0,
            1,
            block.timestamp + 60,
            routeCalldata
        );
        (success, result) = account.call(callData);
    }

    function callLegacyContract(address account, address token, address recipient, address routeTarget)
        external
        returns (bool success, bytes memory result)
    {
        bytes memory callData = abi.encodeCall(MockV2RouteTarget.route, (token, recipient, 100));
        bytes memory accountCall = abi.encodeWithSignature(
            "executeContractCall((address,address,uint256,bytes32,uint256,uint256,uint256),bytes)",
            routeTarget,
            token,
            100,
            keccak256(callData),
            0,
            1,
            block.timestamp + 60,
            callData
        );
        (success, result) = account.call(accountCall);
    }
}

contract ContractOwnerStub {}

contract AgentPayAccountV2Test {
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant DIRECT_TYPEHASH = keccak256(
        "DirectPaymentAuthorization(bytes32 intentIdHash,bytes32 tenantIdHash,bytes32 paymentType,address owner,address account,address token,address recipient,uint256 amount,uint256 nonce,uint256 deadline,bytes32 purposeHash)"
    );
    bytes32 private constant ROUTE_TYPEHASH = keccak256(
        "RoutePaymentAuthorization(bytes32 intentIdHash,bytes32 tenantIdHash,bytes32 paymentType,address owner,address account,address sourceToken,uint256 maxAmountIn,uint256 destinationChainId,address destinationToken,address recipient,uint256 minAmountOut,address routeTarget,bytes32 routeCalldataHash,uint256 maxNativeFee,uint256 nonce,uint256 deadline,bytes32 purposeHash)"
    );

    uint256 private constant OWNER_PRIVATE_KEY = 0xA11CE;
    uint256 private constant OTHER_PRIVATE_KEY = 0xB0B;
    uint256 private constant INITIAL_BALANCE = 1_000_000;
    uint256 private constant SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;

    VmV2 private constant vm = VmV2(address(uint160(uint256(keccak256("hevm cheat code")))));

    event AuthorizedDirectPaymentExecuted(
        bytes32 indexed intentIdHash,
        bytes32 indexed authorizationHash,
        uint256 indexed nonce,
        address token,
        address recipient,
        uint256 amount
    );

    event AuthorizedRoutePaymentExecuted(
        bytes32 indexed intentIdHash,
        bytes32 indexed authorizationHash,
        uint256 indexed nonce,
        address sourceToken,
        address routeTarget,
        uint256 maxAmountIn,
        uint256 minAmountOut
    );

    address private owner;
    address private otherOwner;
    address private executor = address(0xEEC);
    address private recipient = address(0xCAFE);
    address private otherRecipient = address(0xD00D);

    AgentPayAccountV2 private account;
    MockV2ERC20 private token;
    MockV2RouteTarget private routeTarget;

    function setUp() public {
        owner = vm.addr(OWNER_PRIVATE_KEY);
        otherOwner = vm.addr(OTHER_PRIVATE_KEY);
        token = new MockV2ERC20();
        routeTarget = new MockV2RouteTarget();

        address[] memory initialTokens = new address[](1);
        initialTokens[0] = address(token);
        address[] memory initialRouteTargets = new address[](1);
        initialRouteTargets[0] = address(routeTarget);

        account = new AgentPayAccountV2(owner, executor, initialTokens, initialRouteTargets);
        token.mint(address(account), INITIAL_BALANCE);
    }

    function testConstructorRejectsZeroOwner() public {
        vm.expectRevert();
        new AgentPayAccountV2(address(0), executor, new address[](0), new address[](0));
    }

    function testConstructorRejectsZeroExecutor() public {
        vm.expectRevert();
        new AgentPayAccountV2(owner, address(0), new address[](0), new address[](0));
    }

    function testConstructorRejectsOwnerExecutorEquality() public {
        vm.expectRevert();
        new AgentPayAccountV2(owner, owner, new address[](0), new address[](0));
    }

    function testConstructorRejectsContractOwnerUntilEIP1271IsSupported() public {
        ContractOwnerStub contractOwner = new ContractOwnerStub();

        vm.expectRevert();
        new AgentPayAccountV2(address(contractOwner), executor, new address[](0), new address[](0));
    }

    function testConstructorBindsOwnerExecutorAndAllowlists() public view {
        assertEq(account.owner(), owner);
        assertEq(account.executor(), executor);
        assertTrue(account.allowedTokens(address(token)));
        assertTrue(account.allowedRouteTargets(address(routeTarget)));
    }

    function testOwnerIdentityCannotBeChanged() public {
        (bool success,) = address(account).call(abi.encodeWithSignature("setOwner(address)", otherOwner));
        assertFalse(success);
        assertEq(account.owner(), owner);
    }

    function testDomainSeparatorBindsNameVersionChainAndVerifyingContract() public {
        bytes32 expected = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("AgentPay")),
                keccak256(bytes("1")),
                block.chainid,
                address(account)
            )
        );

        assertEq(account.domainSeparator(), expected);
        assertEq(account.DIRECT_PAYMENT_TYPEHASH(), DIRECT_TYPEHASH);
        assertEq(account.ROUTE_PAYMENT_TYPEHASH(), ROUTE_TYPEHASH);

        AgentPayAccountV2 otherAccount = new AgentPayAccountV2(owner, executor, new address[](0), new address[](0));
        assertTrue(account.domainSeparator() != otherAccount.domainSeparator());
    }

    function testValidOwnerSignedDirectPaymentExecutesOnce() public {
        AgentPayAccountV2.DirectPaymentAuthorization memory authorization = directAuthorization(1, 100);
        bytes memory signature = signDirect(authorization, OWNER_PRIVATE_KEY);
        bytes32 authorizationHash = digestDirect(authorization);
        assertEq(account.hashDirectAuthorization(authorization), authorizationHash);

        vm.expectEmit(true, true, true, true);
        emit AuthorizedDirectPaymentExecuted(
            authorization.intentIdHash, authorizationHash, authorization.nonce, address(token), recipient, 100
        );

        vm.prank(executor);
        account.executeAuthorizedDirectPayment(authorization, signature);

        assertEq(token.balanceOf(recipient), 100);
        assertEq(token.balanceOf(address(account)), INITIAL_BALANCE - 100);
        assertTrue(account.usedNonces(1));

        vm.prank(executor);
        vm.expectRevert();
        account.executeAuthorizedDirectPayment(authorization, signature);
    }

    function testDirectRejectsWrongOwnerSignature() public {
        AgentPayAccountV2.DirectPaymentAuthorization memory authorization = directAuthorization(1, 100);
        _expectDirectRevert(authorization, signDirect(authorization, OTHER_PRIVATE_KEY));
    }

    function testDirectRejectsNonSignatureProofs() public {
        AgentPayAccountV2.DirectPaymentAuthorization memory authorization = directAuthorization(1, 100);

        _expectDirectRevert(authorization, bytes(""));
        _expectDirectRevert(authorization, bytes("owner-session-credential"));
        _expectDirectRevert(authorization, bytes("x402-payment-proof"));
    }

    function testDirectRejectsMalformedAndMalleableSignatures() public {
        AgentPayAccountV2.DirectPaymentAuthorization memory authorization = directAuthorization(1, 100);

        _expectDirectRevert(authorization, hex"01");

        bytes memory validSignature = signDirect(authorization, OWNER_PRIVATE_KEY);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(validSignature, 32))
            s := mload(add(validSignature, 64))
            v := byte(0, mload(add(validSignature, 96)))
        }
        bytes32 malleableS = bytes32(SECP256K1_N - uint256(s));
        uint8 malleableV = v == 27 ? 28 : 27;
        _expectDirectRevert(authorization, abi.encodePacked(r, malleableS, malleableV));
    }

    function testDirectRejectsEveryMutatedSignedField() public {
        AgentPayAccountV2.DirectPaymentAuthorization memory original = directAuthorization(1, 100);
        bytes memory signature = signDirect(original, OWNER_PRIVATE_KEY);
        AgentPayAccountV2.DirectPaymentAuthorization memory mutated;

        mutated = original;
        mutated.intentIdHash = bytes32(uint256(2));
        _expectDirectRevert(mutated, signature);

        mutated = original;
        mutated.tenantIdHash = bytes32(uint256(2));
        _expectDirectRevert(mutated, signature);

        mutated = original;
        mutated.paymentType = keccak256("ROUTE_PAYMENT");
        _expectDirectRevert(mutated, signature);

        mutated = original;
        mutated.owner = otherOwner;
        _expectDirectRevert(mutated, signature);

        mutated = original;
        mutated.account = address(0x1234);
        _expectDirectRevert(mutated, signature);

        MockV2ERC20 otherToken = new MockV2ERC20();

        mutated = original;
        mutated.token = address(otherToken);
        _expectDirectRevert(mutated, signature);

        mutated = original;
        mutated.recipient = otherRecipient;
        _expectDirectRevert(mutated, signature);

        mutated = original;
        mutated.amount = 101;
        _expectDirectRevert(mutated, signature);

        mutated = original;
        mutated.nonce = 2;
        _expectDirectRevert(mutated, signature);

        mutated = original;
        mutated.deadline += 1;
        _expectDirectRevert(mutated, signature);

        mutated = original;
        mutated.purposeHash = bytes32(uint256(2));
        _expectDirectRevert(mutated, signature);
    }

    function testDirectRejectsUnauthorizedCallerEvenWithValidSignature() public {
        AgentPayAccountV2.DirectPaymentAuthorization memory authorization = directAuthorization(1, 100);
        bytes memory signature = signDirect(authorization, OWNER_PRIVATE_KEY);

        vm.prank(owner);
        vm.expectRevert();
        account.executeAuthorizedDirectPayment(authorization, signature);

        vm.prank(otherOwner);
        vm.expectRevert();
        account.executeAuthorizedDirectPayment(authorization, signature);
    }

    function testDirectRejectsSignatureFromAnotherAccount() public {
        AgentPayAccountV2.DirectPaymentAuthorization memory authorization = directAuthorization(1, 100);
        bytes memory signature = signDirect(authorization, OWNER_PRIVATE_KEY);

        AgentPayAccountV2 otherAccount = new AgentPayAccountV2(owner, executor, new address[](0), new address[](0));
        _expectDirectRevertOn(otherAccount, authorization, signature);
    }

    function testDirectRejectsSignatureAcrossChainIds() public {
        AgentPayAccountV2.DirectPaymentAuthorization memory authorization = directAuthorization(1, 100);
        bytes memory signature = signDirect(authorization, OWNER_PRIVATE_KEY);
        uint256 originalChainId = block.chainid;

        vm.chainId(originalChainId + 1);
        vm.prank(executor);
        vm.expectRevert();
        account.executeAuthorizedDirectPayment(authorization, signature);

        vm.chainId(originalChainId);
    }

    function testDirectRejectsDeadlineAtBoundary() public {
        AgentPayAccountV2.DirectPaymentAuthorization memory authorization = directAuthorization(1, 100);
        authorization.deadline = block.timestamp;

        _expectDirectRevert(authorization, signDirect(authorization, OWNER_PRIVATE_KEY));
    }

    function testDirectRejectsCancelledNonce() public {
        AgentPayAccountV2.DirectPaymentAuthorization memory authorization = directAuthorization(1, 100);

        vm.prank(owner);
        account.cancelNonce(authorization.nonce);

        _expectDirectRevert(authorization, signDirect(authorization, OWNER_PRIVATE_KEY));

        vm.prank(owner);
        vm.expectRevert();
        account.cancelNonce(authorization.nonce);
    }

    function testDirectRejectsFalseReturningTokenWithoutConsumingNonce() public {
        FalseReturnV2ERC20 falseToken = new FalseReturnV2ERC20();
        falseToken.mint(address(account), 100);

        vm.prank(owner);
        account.setAllowedToken(address(falseToken), true);

        AgentPayAccountV2.DirectPaymentAuthorization memory authorization = directAuthorization(1, 100);
        authorization.token = address(falseToken);
        bytes memory signature = signDirect(authorization, OWNER_PRIVATE_KEY);

        vm.prank(executor);
        vm.expectRevert();
        account.executeAuthorizedDirectPayment(authorization, signature);

        assertFalse(account.usedNonces(authorization.nonce));
    }

    function testDirectRejectsUnallowedTokenWithMatchingOwnerSignature() public {
        MockV2ERC20 otherToken = new MockV2ERC20();
        otherToken.mint(address(account), 100);

        AgentPayAccountV2.DirectPaymentAuthorization memory authorization = directAuthorization(1, 100);
        authorization.token = address(otherToken);

        _expectDirectRevert(authorization, signDirect(authorization, OWNER_PRIVATE_KEY));
        assertFalse(account.usedNonces(authorization.nonce));
    }

    function testDirectRejectsInsufficientBalanceWithoutConsumingNonce() public {
        AgentPayAccountV2.DirectPaymentAuthorization memory authorization = directAuthorization(1, INITIAL_BALANCE + 1);
        bytes memory signature = signDirect(authorization, OWNER_PRIVATE_KEY);

        vm.prank(executor);
        vm.expectRevert();
        account.executeAuthorizedDirectPayment(authorization, signature);

        assertFalse(account.usedNonces(authorization.nonce));
    }

    function testDirectRejectsDeadlineBeyondPolicyCap() public {
        AgentPayAccountV2.DirectPaymentAuthorization memory authorization = directAuthorization(1, 100);
        authorization.deadline = block.timestamp + 15 minutes + 1;

        _expectDirectRevert(authorization, signDirect(authorization, OWNER_PRIVATE_KEY));
    }

    function testFuzzDirectMutationNeverAuthorizes(uint256 rawAmount, uint256 rawNonce, uint256 rawDeadline) public {
        AgentPayAccountV2.DirectPaymentAuthorization memory original = directAuthorization(1, 100);
        bytes memory signature = signDirect(original, OWNER_PRIVATE_KEY);

        uint256 mutatedAmount = 1 + (rawAmount % INITIAL_BALANCE);
        if (mutatedAmount == original.amount) {
            mutatedAmount = original.amount + 1;
        }
        original.amount = mutatedAmount;
        original.nonce = rawNonce == 1 ? 2 : rawNonce;
        original.deadline = rawDeadline == block.timestamp + 15 minutes ? rawDeadline + 1 : rawDeadline;

        _expectDirectRevert(original, signature);
    }

    function testNonOwnerCannotMutateExecutorPauseOrAllowlists() public {
        MockV2ERC20 otherToken = new MockV2ERC20();
        MockV2RouteTarget otherTarget = new MockV2RouteTarget();

        vm.prank(otherOwner);
        vm.expectRevert();
        account.setExecutor(otherOwner);

        vm.prank(owner);
        vm.expectRevert();
        account.setExecutor(owner);

        vm.prank(otherOwner);
        vm.expectRevert();
        account.pause();

        vm.prank(otherOwner);
        vm.expectRevert();
        account.setAllowedToken(address(otherToken), true);

        vm.prank(otherOwner);
        vm.expectRevert();
        account.setAllowedRouteTarget(address(otherTarget), true);

        vm.prank(otherOwner);
        vm.expectRevert();
        account.cancelNonce(1);
    }

    function testOwnerCanRotateExecutorButOldExecutorCannotSubmit() public {
        address newExecutor = address(0xF00D);
        AgentPayAccountV2.DirectPaymentAuthorization memory authorization = directAuthorization(1, 100);
        bytes memory signature = signDirect(authorization, OWNER_PRIVATE_KEY);

        vm.prank(owner);
        account.setExecutor(newExecutor);

        vm.prank(executor);
        vm.expectRevert();
        account.executeAuthorizedDirectPayment(authorization, signature);

        vm.prank(newExecutor);
        account.executeAuthorizedDirectPayment(authorization, signature);
        assertTrue(account.usedNonces(authorization.nonce));
    }

    function testOwnerOnlyPauseBlocksAuthorizedDirectAndRouteExecution() public {
        vm.prank(owner);
        account.pause();

        AgentPayAccountV2.DirectPaymentAuthorization memory direct = directAuthorization(1, 100);
        _expectDirectRevert(direct, signDirect(direct, OWNER_PRIVATE_KEY));

        bytes memory routeCalldata = abi.encodeCall(MockV2RouteTarget.route, (address(token), recipient, 100));
        AgentPayAccountV2.RoutePaymentAuthorization memory route =
            routeAuthorization(2, address(routeTarget), routeCalldata, 120, 100, 0);
        _expectRouteRevert(route, routeCalldata, signRoute(route, OWNER_PRIVATE_KEY));

        vm.prank(owner);
        account.unpause();
    }

    function testDirectAndRouteTypeHashesCannotReplay() public {
        AgentPayAccountV2.DirectPaymentAuthorization memory direct = directAuthorization(1, 100);
        bytes memory directSignature = signDirect(direct, OWNER_PRIVATE_KEY);
        bytes memory routeCalldata = abi.encodeCall(MockV2RouteTarget.route, (address(token), recipient, 100));
        AgentPayAccountV2.RoutePaymentAuthorization memory route =
            routeAuthorization(1, address(routeTarget), routeCalldata, 120, 100, 0);

        _expectRouteRevert(route, routeCalldata, directSignature);
        _expectDirectRevert(direct, signRoute(route, OWNER_PRIVATE_KEY));
    }

    function testSharedNonceBlocksDirectThenRoute() public {
        AgentPayAccountV2.DirectPaymentAuthorization memory direct = directAuthorization(1, 100);
        bytes memory directSignature = signDirect(direct, OWNER_PRIVATE_KEY);
        vm.prank(executor);
        account.executeAuthorizedDirectPayment(direct, directSignature);

        bytes memory routeCalldata = abi.encodeCall(MockV2RouteTarget.route, (address(token), recipient, 100));
        AgentPayAccountV2.RoutePaymentAuthorization memory route =
            routeAuthorization(1, address(routeTarget), routeCalldata, 120, 100, 0);
        bytes memory routeSignature = signRoute(route, OWNER_PRIVATE_KEY);
        _expectRouteRevert(route, routeCalldata, routeSignature);
    }

    function testSharedNonceBlocksRouteThenDirect() public {
        bytes memory routeCalldata = abi.encodeCall(MockV2RouteTarget.route, (address(token), recipient, 100));
        AgentPayAccountV2.RoutePaymentAuthorization memory route =
            routeAuthorization(1, address(routeTarget), routeCalldata, 120, 100, 0);
        bytes memory routeSignature = signRoute(route, OWNER_PRIVATE_KEY);

        vm.prank(executor);
        account.executeAuthorizedRoutePayment(route, routeCalldata, routeSignature);

        AgentPayAccountV2.DirectPaymentAuthorization memory direct = directAuthorization(1, 100);
        _expectDirectRevert(direct, signDirect(direct, OWNER_PRIVATE_KEY));
    }

    function testValidOwnerSignedRouteCapsAllowanceAndResetsIt() public {
        bytes memory routeCalldata = abi.encodeCall(MockV2RouteTarget.route, (address(token), recipient, 100));
        AgentPayAccountV2.RoutePaymentAuthorization memory authorization =
            routeAuthorization(1, address(routeTarget), routeCalldata, 120, 100, 0);
        bytes memory signature = signRoute(authorization, OWNER_PRIVATE_KEY);
        bytes32 authorizationHash = digestRoute(authorization);

        vm.expectEmit(true, true, true, true);
        emit AuthorizedRoutePaymentExecuted(
            authorization.intentIdHash,
            authorizationHash,
            authorization.nonce,
            address(token),
            address(routeTarget),
            authorization.maxAmountIn,
            authorization.minAmountOut
        );

        vm.prank(executor);
        account.executeAuthorizedRoutePayment(authorization, routeCalldata, signature);

        assertEq(token.balanceOf(recipient), 100);
        assertEq(token.balanceOf(address(account)), INITIAL_BALANCE - 100);
        assertEq(token.allowance(address(account), address(routeTarget)), 0);
        assertTrue(account.usedNonces(authorization.nonce));
    }

    function testRouteRejectsEveryMutatedSignedField() public {
        bytes memory routeCalldata = abi.encodeCall(MockV2RouteTarget.route, (address(token), recipient, 100));
        AgentPayAccountV2.RoutePaymentAuthorization memory original =
            routeAuthorization(1, address(routeTarget), routeCalldata, 120, 100, 0);
        bytes memory signature = signRoute(original, OWNER_PRIVATE_KEY);
        AgentPayAccountV2.RoutePaymentAuthorization memory mutated;

        mutated = original;
        mutated.intentIdHash = bytes32(uint256(2));
        _expectRouteRevert(mutated, routeCalldata, signature);

        mutated = original;
        mutated.tenantIdHash = bytes32(uint256(2));
        _expectRouteRevert(mutated, routeCalldata, signature);

        mutated = original;
        mutated.paymentType = keccak256("DIRECT_PAYMENT");
        _expectRouteRevert(mutated, routeCalldata, signature);

        mutated = original;
        mutated.owner = otherOwner;
        _expectRouteRevert(mutated, routeCalldata, signature);

        mutated = original;
        mutated.account = address(0x1234);
        _expectRouteRevert(mutated, routeCalldata, signature);

        MockV2ERC20 otherToken = new MockV2ERC20();
        mutated = original;
        mutated.sourceToken = address(otherToken);
        _expectRouteRevert(mutated, routeCalldata, signature);

        mutated = original;
        mutated.maxAmountIn = 121;
        _expectRouteRevert(mutated, routeCalldata, signature);

        mutated = original;
        mutated.destinationChainId += 1;
        _expectRouteRevert(mutated, routeCalldata, signature);

        mutated = original;
        mutated.destinationToken = address(otherToken);
        _expectRouteRevert(mutated, routeCalldata, signature);

        mutated = original;
        mutated.recipient = otherRecipient;
        _expectRouteRevert(mutated, routeCalldata, signature);

        mutated = original;
        mutated.minAmountOut = 101;
        _expectRouteRevert(mutated, routeCalldata, signature);

        MockV2RouteTarget otherTarget = new MockV2RouteTarget();
        mutated = original;
        mutated.routeTarget = address(otherTarget);
        _expectRouteRevert(mutated, routeCalldata, signature);

        mutated = original;
        mutated.routeCalldataHash = bytes32(uint256(2));
        _expectRouteRevert(mutated, routeCalldata, signature);

        mutated = original;
        mutated.maxNativeFee = 1;
        _expectRouteRevert(mutated, routeCalldata, signature);

        mutated = original;
        mutated.nonce = 2;
        _expectRouteRevert(mutated, routeCalldata, signature);

        mutated = original;
        mutated.deadline += 1;
        _expectRouteRevert(mutated, routeCalldata, signature);

        mutated = original;
        mutated.purposeHash = bytes32(uint256(2));
        _expectRouteRevert(mutated, routeCalldata, signature);
    }

    function testRouteRejectsUnallowedTarget() public {
        MockV2RouteTarget otherTarget = new MockV2RouteTarget();
        bytes memory routeCalldata = abi.encodeCall(MockV2RouteTarget.route, (address(token), recipient, 100));
        AgentPayAccountV2.RoutePaymentAuthorization memory authorization =
            routeAuthorization(1, address(otherTarget), routeCalldata, 100, 100, 0);

        _expectRouteRevert(authorization, routeCalldata, signRoute(authorization, OWNER_PRIVATE_KEY));
    }

    function testRouteRejectsCalldataHashMutation() public {
        bytes memory routeCalldata = abi.encodeCall(MockV2RouteTarget.route, (address(token), recipient, 100));
        bytes memory tamperedCalldata = abi.encodeCall(MockV2RouteTarget.route, (address(token), recipient, 101));
        AgentPayAccountV2.RoutePaymentAuthorization memory authorization =
            routeAuthorization(1, address(routeTarget), routeCalldata, 120, 100, 0);

        _expectRouteRevert(authorization, tamperedCalldata, signRoute(authorization, OWNER_PRIVATE_KEY));
    }

    function testRouteRejectsNativeFeeAboveCap() public {
        bytes memory routeCalldata = abi.encodeCall(MockV2RouteTarget.route, (address(token), recipient, 100));
        AgentPayAccountV2.RoutePaymentAuthorization memory authorization =
            routeAuthorization(1, address(routeTarget), routeCalldata, 120, 100, 1 wei);
        bytes memory signature = signRoute(authorization, OWNER_PRIVATE_KEY);

        vm.deal(executor, 1 ether);
        vm.prank(executor);
        vm.expectRevert();
        account.executeAuthorizedRoutePayment{value: 2 wei}(authorization, routeCalldata, signature);
    }

    function testRouteCannotSpendMoreThanSignedMaximumInput() public {
        bytes memory routeCalldata = abi.encodeCall(MockV2RouteTarget.route, (address(token), recipient, 101));
        AgentPayAccountV2.RoutePaymentAuthorization memory authorization =
            routeAuthorization(1, address(routeTarget), routeCalldata, 100, 100, 0);

        _expectRouteRevert(authorization, routeCalldata, signRoute(authorization, OWNER_PRIVATE_KEY));

        assertFalse(account.usedNonces(authorization.nonce));
        assertEq(token.balanceOf(address(account)), INITIAL_BALANCE);
        assertEq(token.balanceOf(recipient), 0);
    }

    function testFuzzRouteCannotExceedSignedMaximumInput(uint256 rawSpend) public {
        uint256 spend = 2 + (rawSpend % (INITIAL_BALANCE - 1));
        bytes memory routeCalldata = abi.encodeCall(MockV2RouteTarget.route, (address(token), recipient, spend));
        AgentPayAccountV2.RoutePaymentAuthorization memory authorization =
            routeAuthorization(1, address(routeTarget), routeCalldata, spend - 1, spend, 0);

        _expectRouteRevert(authorization, routeCalldata, signRoute(authorization, OWNER_PRIVATE_KEY));

        assertFalse(account.usedNonces(authorization.nonce));
        assertEq(token.balanceOf(address(account)), INITIAL_BALANCE);
        assertEq(token.balanceOf(recipient), 0);
    }

    function testRouteRejectsMissingMinimumOutput() public {
        // The account binds a non-zero minAmountOut. The LI.FI adapter must
        // reject quotes without a guaranteed toAmountMin before signing/402;
        // destination delivery proof is outside this account call boundary.
        bytes memory routeCalldata = abi.encodeCall(MockV2RouteTarget.route, (address(token), recipient, 100));
        AgentPayAccountV2.RoutePaymentAuthorization memory authorization =
            routeAuthorization(1, address(routeTarget), routeCalldata, 120, 0, 0);

        _expectRouteRevert(authorization, routeCalldata, signRoute(authorization, OWNER_PRIVATE_KEY));
    }

    function testRouteRejectsZeroDestinationChain() public {
        bytes memory routeCalldata = abi.encodeCall(MockV2RouteTarget.route, (address(token), recipient, 100));
        AgentPayAccountV2.RoutePaymentAuthorization memory authorization =
            routeAuthorization(1, address(routeTarget), routeCalldata, 120, 100, 0);
        authorization.destinationChainId = 0;

        _expectRouteRevert(authorization, routeCalldata, signRoute(authorization, OWNER_PRIVATE_KEY));
    }

    function testRouteRejectsDeadlineBeyondPolicyCap() public {
        bytes memory routeCalldata = abi.encodeCall(MockV2RouteTarget.route, (address(token), recipient, 100));
        AgentPayAccountV2.RoutePaymentAuthorization memory authorization =
            routeAuthorization(1, address(routeTarget), routeCalldata, 120, 100, 0);
        authorization.deadline = block.timestamp + 5 minutes + 1;

        _expectRouteRevert(authorization, routeCalldata, signRoute(authorization, OWNER_PRIVATE_KEY));
    }

    function testRouteFailureRollsBackNonceAllowanceAndBalances() public {
        RevertingV2RouteTarget failingTarget = new RevertingV2RouteTarget();
        vm.prank(owner);
        account.setAllowedRouteTarget(address(failingTarget), true);

        bytes memory routeCalldata = abi.encodeCall(RevertingV2RouteTarget.route, (address(token), recipient, 100));
        AgentPayAccountV2.RoutePaymentAuthorization memory authorization =
            routeAuthorization(1, address(failingTarget), routeCalldata, 100, 100, 0);

        _expectRouteRevert(authorization, routeCalldata, signRoute(authorization, OWNER_PRIVATE_KEY));

        assertFalse(account.usedNonces(authorization.nonce));
        assertEq(token.allowance(address(account), address(failingTarget)), 0);
        assertEq(token.balanceOf(address(account)), INITIAL_BALANCE);
        assertEq(token.balanceOf(recipient), 0);
    }

    function testRouteReentrancyCannotExecuteNestedPayment() public {
        AgentPayAccountV2.DirectPaymentAuthorization memory nested = directAuthorization(99, 10);
        bytes memory nestedCall = abi.encodeCall(
            IAuthorizedV2Account.executeAuthorizedDirectPayment, (nested, signDirect(nested, OWNER_PRIVATE_KEY))
        );
        ReentrantV2RouteTarget reentrantTarget = new ReentrantV2RouteTarget(address(account), nestedCall);

        vm.prank(owner);
        account.setAllowedRouteTarget(address(reentrantTarget), true);
        vm.prank(owner);
        account.setExecutor(address(reentrantTarget));

        bytes memory routeCalldata = abi.encodeCall(ReentrantV2RouteTarget.route, (address(token), recipient, 100));
        AgentPayAccountV2.RoutePaymentAuthorization memory authorization =
            routeAuthorization(1, address(reentrantTarget), routeCalldata, 100, 100, 0);
        bytes memory outerCall = abi.encodeCall(
            AgentPayAccountV2.executeAuthorizedRoutePayment,
            (authorization, routeCalldata, signRoute(authorization, OWNER_PRIVATE_KEY))
        );
        reentrantTarget.setOuterCall(outerCall);

        vm.expectRevert();
        reentrantTarget.start();

        assertFalse(account.usedNonces(authorization.nonce));
        assertFalse(account.usedNonces(nested.nonce));
        assertEq(token.balanceOf(address(account)), INITIAL_BALANCE);
        assertEq(token.balanceOf(recipient), 0);
    }

    function testNoUnsignedExecutionSelectors() public {
        LegacySelectorCaller selectorCaller = new LegacySelectorCaller();
        address[] memory initialTokens = new address[](1);
        initialTokens[0] = address(token);
        address[] memory initialRouteTargets = new address[](1);
        initialRouteTargets[0] = address(routeTarget);
        AgentPayAccountV2 candidate =
            new AgentPayAccountV2(owner, address(selectorCaller), initialTokens, initialRouteTargets);
        token.mint(address(candidate), INITIAL_BALANCE);

        (bool directSuccess,) = selectorCaller.callLegacyDirect(address(candidate), address(token), recipient, 100);
        (bool routeSuccess,) =
            selectorCaller.callLegacyRoute(address(candidate), address(token), recipient, address(routeTarget));
        (bool contractSuccess,) =
            selectorCaller.callLegacyContract(address(candidate), address(token), recipient, address(routeTarget));

        assertFalse(directSuccess);
        assertFalse(routeSuccess);
        assertFalse(contractSuccess);
    }

    function directAuthorization(uint256 nonce, uint256 amount)
        private
        view
        returns (AgentPayAccountV2.DirectPaymentAuthorization memory authorization)
    {
        authorization = AgentPayAccountV2.DirectPaymentAuthorization({
            intentIdHash: keccak256(abi.encode("intent", nonce)),
            tenantIdHash: keccak256("tenant-a"),
            paymentType: keccak256("DIRECT_PAYMENT"),
            owner: owner,
            account: address(account),
            token: address(token),
            recipient: recipient,
            amount: amount,
            nonce: nonce,
            deadline: block.timestamp + 15 minutes,
            purposeHash: keccak256("invoice payment")
        });
    }

    function routeAuthorization(
        uint256 nonce,
        address target,
        bytes memory routeCalldata,
        uint256 maxAmountIn,
        uint256 minAmountOut,
        uint256 maxNativeFee
    ) private view returns (AgentPayAccountV2.RoutePaymentAuthorization memory authorization) {
        authorization = AgentPayAccountV2.RoutePaymentAuthorization({
                intentIdHash: keccak256(abi.encode("route-intent", nonce)),
                tenantIdHash: keccak256("tenant-a"),
                paymentType: keccak256("ROUTE_PAYMENT"),
                owner: owner,
                account: address(account),
                sourceToken: address(token),
                maxAmountIn: maxAmountIn,
                destinationChainId: block.chainid + 1,
                destinationToken: address(token),
                recipient: recipient,
                minAmountOut: minAmountOut,
                routeTarget: target,
                routeCalldataHash: keccak256(routeCalldata),
                maxNativeFee: maxNativeFee,
                nonce: nonce,
                deadline: block.timestamp + 5 minutes,
                purposeHash: keccak256("cross-chain payment")
            });
    }

    function digestDirect(AgentPayAccountV2.DirectPaymentAuthorization memory authorization)
        private
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                DIRECT_TYPEHASH,
                authorization.intentIdHash,
                authorization.tenantIdHash,
                authorization.paymentType,
                authorization.owner,
                authorization.account,
                authorization.token,
                authorization.recipient,
                authorization.amount,
                authorization.nonce,
                authorization.deadline,
                authorization.purposeHash
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", account.domainSeparator(), structHash));
    }

    function digestRoute(AgentPayAccountV2.RoutePaymentAuthorization memory authorization)
        private
        view
        returns (bytes32)
    {
        uint256[18] memory words;
        words[0] = uint256(ROUTE_TYPEHASH);
        words[1] = uint256(authorization.intentIdHash);
        words[2] = uint256(authorization.tenantIdHash);
        words[3] = uint256(authorization.paymentType);
        words[4] = uint256(uint160(authorization.owner));
        words[5] = uint256(uint160(authorization.account));
        words[6] = uint256(uint160(authorization.sourceToken));
        words[7] = authorization.maxAmountIn;
        words[8] = authorization.destinationChainId;
        words[9] = uint256(uint160(authorization.destinationToken));
        words[10] = uint256(uint160(authorization.recipient));
        words[11] = authorization.minAmountOut;
        words[12] = uint256(uint160(authorization.routeTarget));
        words[13] = uint256(authorization.routeCalldataHash);
        words[14] = authorization.maxNativeFee;
        words[15] = authorization.nonce;
        words[16] = authorization.deadline;
        words[17] = uint256(authorization.purposeHash);
        bytes32 structHash = keccak256(abi.encode(words));
        return keccak256(abi.encodePacked("\x19\x01", account.domainSeparator(), structHash));
    }

    function signDirect(AgentPayAccountV2.DirectPaymentAuthorization memory authorization, uint256 privateKey)
        private
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digestDirect(authorization));
        return abi.encodePacked(r, s, v);
    }

    function signRoute(AgentPayAccountV2.RoutePaymentAuthorization memory authorization, uint256 privateKey)
        private
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digestRoute(authorization));
        return abi.encodePacked(r, s, v);
    }

    function _expectDirectRevert(
        AgentPayAccountV2.DirectPaymentAuthorization memory authorization,
        bytes memory signature
    ) private {
        vm.prank(executor);
        vm.expectRevert();
        account.executeAuthorizedDirectPayment(authorization, signature);
    }

    function _expectDirectRevertOn(
        AgentPayAccountV2 target,
        AgentPayAccountV2.DirectPaymentAuthorization memory authorization,
        bytes memory signature
    ) private {
        vm.prank(executor);
        vm.expectRevert();
        target.executeAuthorizedDirectPayment(authorization, signature);
    }

    function _expectRouteRevert(
        AgentPayAccountV2.RoutePaymentAuthorization memory authorization,
        bytes memory routeCalldata,
        bytes memory signature
    ) private {
        vm.prank(executor);
        vm.expectRevert();
        account.executeAuthorizedRoutePayment(authorization, routeCalldata, signature);
    }

    function assertEq(address actual, address expected) private pure {
        require(actual == expected, "address mismatch");
    }

    function assertEq(uint256 actual, uint256 expected) private pure {
        require(actual == expected, "uint256 mismatch");
    }

    function assertEq(bytes32 actual, bytes32 expected) private pure {
        require(actual == expected, "bytes32 mismatch");
    }

    function assertTrue(bool value) private pure {
        require(value, "expected true");
    }

    function assertFalse(bool value) private pure {
        require(!value, "expected false");
    }
}
