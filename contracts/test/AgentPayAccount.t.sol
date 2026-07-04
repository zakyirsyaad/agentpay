// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentPayAccount} from "../src/AgentPayAccount.sol";

interface Vm {
    function assume(bool condition) external;
    function deal(address account, uint256 balance) external;
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData) external;
    function expectRevert(bytes calldata revertData) external;
    function prank(address sender) external;
    function warp(uint256 newTimestamp) external;
}

contract MiniTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertEq(address actual, address expected) internal pure {
        require(actual == expected, "address mismatch");
    }

    function assertEq(uint256 actual, uint256 expected) internal pure {
        require(actual == expected, "uint256 mismatch");
    }

    function assertTrue(bool value) internal pure {
        require(value, "expected true");
    }

    function assertFalse(bool value) internal pure {
        require(!value, "expected false");
    }
}

contract MockERC20 {
    string public name = "Mock USDC";
    string public symbol = "mUSDC";
    uint8 public decimals = 6;
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

contract MockRouteTarget {
    event RouteCalled(address indexed token, address indexed recipient, uint256 amount, uint256 nativeFee);

    function route(address token, address recipient, uint256 amount) external payable {
        MockERC20(token).transferFrom(msg.sender, recipient, amount);
        emit RouteCalled(token, recipient, amount, msg.value);
    }
}

contract MockContractTarget {
    event ContractCalled(address indexed token, address indexed recipient, uint256 amount, uint256 nativeFee);

    function pay(address token, address recipient, uint256 amount) external payable {
        MockERC20(token).transferFrom(msg.sender, recipient, amount);
        emit ContractCalled(token, recipient, amount, msg.value);
    }
}

contract RevertingTarget {
    function route(address, address, uint256) external pure {
        revert("target failed");
    }

    function pay(address, address, uint256) external pure {
        revert("target failed");
    }
}

contract AgentPayAccountTest is MiniTest {
    event DirectPaymentExecuted(
        uint256 indexed nonce, address indexed token, address indexed recipient, uint256 amount
    );

    event RoutePaymentExecuted(
        uint256 indexed nonce,
        address indexed sourceToken,
        address indexed routeTarget,
        uint256 maxAmountIn,
        uint256 destinationChainId,
        address recipient,
        uint256 amountOut
    );

    event NonceCancelled(uint256 indexed nonce);
    event ContractCallExecuted(
        uint256 indexed nonce,
        address indexed target,
        address indexed token,
        uint256 maxTokenSpend,
        uint256 maxNativeFee
    );

    address private owner = address(0xA11CE);
    address private executor = address(0xEEC);
    address private user = address(0xB0B);
    address private recipient = address(0xCAFE);

    AgentPayAccount private account;
    MockERC20 private token;
    MockRouteTarget private routeTarget;
    MockContractTarget private contractTarget;

    function setUp() public {
        token = new MockERC20();
        routeTarget = new MockRouteTarget();
        contractTarget = new MockContractTarget();

        address[] memory initialTokens = new address[](1);
        initialTokens[0] = address(token);
        address[] memory initialRouteTargets = new address[](2);
        initialRouteTargets[0] = address(routeTarget);
        initialRouteTargets[1] = address(contractTarget);
        account = new AgentPayAccount(owner, executor, initialTokens, initialRouteTargets);

        token.mint(address(account), 1_000_000);
    }

    function testConstructorRejectsZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(AgentPayAccount.ZeroAddress.selector));
        new AgentPayAccount(address(0), executor, new address[](0), new address[](0));
    }

    function testConstructorRejectsZeroExecutor() public {
        vm.expectRevert(abi.encodeWithSelector(AgentPayAccount.ZeroAddress.selector));
        new AgentPayAccount(owner, address(0), new address[](0), new address[](0));
    }

    function testConstructorInitializesAllowlists() public view {
        assertTrue(account.allowedTokens(address(token)));
        assertTrue(account.allowedRouteTargets(address(routeTarget)));
    }

    function testConstructorRejectsZeroInitialAllowedToken() public {
        address[] memory initialTokens = new address[](1);
        initialTokens[0] = address(0);

        vm.expectRevert(abi.encodeWithSelector(AgentPayAccount.ZeroAddress.selector));
        new AgentPayAccount(owner, executor, initialTokens, new address[](0));
    }

    function testConstructorRejectsZeroInitialRouteTarget() public {
        address[] memory initialRouteTargets = new address[](1);
        initialRouteTargets[0] = address(0);

        vm.expectRevert(abi.encodeWithSelector(AgentPayAccount.ZeroAddress.selector));
        new AgentPayAccount(owner, executor, new address[](0), initialRouteTargets);
    }

    function testOwnerCanSetExecutor() public {
        address newExecutor = address(0xF00D);

        vm.prank(owner);
        account.setExecutor(newExecutor);

        assertEq(account.executor(), newExecutor);
    }

    function testOnlyOwnerCanSetExecutor() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(AgentPayAccount.NotOwner.selector));
        account.setExecutor(address(0xF00D));
    }

    function testOnlyOwnerCanAllowToken() public {
        MockERC20 otherToken = new MockERC20();

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(AgentPayAccount.NotOwner.selector));
        account.setAllowedToken(address(otherToken), true);
    }

    function testOnlyOwnerCanAllowRouteTarget() public {
        MockRouteTarget otherTarget = new MockRouteTarget();

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(AgentPayAccount.NotOwner.selector));
        account.setAllowedRouteTarget(address(otherTarget), true);
    }

    function testOnlyExecutorCanExecute() public {
        AgentPayAccount.DirectPaymentIntent memory intent = directIntent(1, 100);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(AgentPayAccount.NotExecutor.selector));
        account.executeDirectPayment(intent);
    }

    function testExecutionRejectsWhenPaused() public {
        vm.prank(owner);
        account.pause();

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(AgentPayAccount.Paused.selector));
        account.executeDirectPayment(directIntent(1, 100));
    }

    function testExecutionRejectsCancelledNonce() public {
        vm.prank(owner);
        account.cancelNonce(1);

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(AgentPayAccount.NonceAlreadyUsed.selector, 1));
        account.executeDirectPayment(directIntent(1, 100));
    }

    function testExecutionRejectsExpiredDeadline() public {
        AgentPayAccount.DirectPaymentIntent memory intent = AgentPayAccount.DirectPaymentIntent({
            token: address(token), recipient: recipient, amount: 100, nonce: 1, deadline: block.timestamp - 1
        });

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(AgentPayAccount.DeadlineExpired.selector, block.timestamp - 1));
        account.executeDirectPayment(intent);
    }

    function testExecutionRejectsUnallowedToken() public {
        MockERC20 otherToken = new MockERC20();
        otherToken.mint(address(account), 100);

        AgentPayAccount.DirectPaymentIntent memory intent = AgentPayAccount.DirectPaymentIntent({
            token: address(otherToken), recipient: recipient, amount: 100, nonce: 1, deadline: block.timestamp + 1
        });

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(AgentPayAccount.TokenNotAllowed.selector, address(otherToken)));
        account.executeDirectPayment(intent);
    }

    function testRouteExecutionRejectsUnallowedRouteTarget() public {
        MockRouteTarget otherTarget = new MockRouteTarget();
        bytes memory routeCalldata = abi.encodeCall(MockRouteTarget.route, (address(token), recipient, 100));
        AgentPayAccount.RoutePaymentIntent memory intent = routeIntent(1, address(otherTarget), routeCalldata, 100, 0);

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(AgentPayAccount.RouteTargetNotAllowed.selector, address(otherTarget)));
        account.executeRoutePayment(intent, routeCalldata);
    }

    function testRouteExecutionRejectsCalldataHashMismatch() public {
        bytes memory routeCalldata = abi.encodeCall(MockRouteTarget.route, (address(token), recipient, 100));
        AgentPayAccount.RoutePaymentIntent memory intent = routeIntent(1, address(routeTarget), routeCalldata, 100, 0);

        bytes memory tamperedCalldata = abi.encodeCall(MockRouteTarget.route, (address(token), recipient, 101));

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(AgentPayAccount.CalldataHashMismatch.selector));
        account.executeRoutePayment(intent, tamperedCalldata);
    }

    function testRouteExecutionRejectsNativeFeeAboveMax() public {
        bytes memory routeCalldata = abi.encodeCall(MockRouteTarget.route, (address(token), recipient, 100));
        AgentPayAccount.RoutePaymentIntent memory intent =
            routeIntent(1, address(routeTarget), routeCalldata, 100, 1 wei);

        vm.deal(executor, 1 ether);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(AgentPayAccount.NativeFeeTooHigh.selector, 2 wei, 1 wei));
        account.executeRoutePayment{value: 2 wei}(intent, routeCalldata);
    }

    function testDirectPaymentRejectsZeroAmount() public {
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(AgentPayAccount.InvalidAmount.selector));
        account.executeDirectPayment(directIntent(1, 0));
    }

    function testDirectPaymentRejectsZeroRecipient() public {
        AgentPayAccount.DirectPaymentIntent memory intent = AgentPayAccount.DirectPaymentIntent({
            token: address(token), recipient: address(0), amount: 100, nonce: 1, deadline: block.timestamp + 1
        });

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(AgentPayAccount.InvalidRecipient.selector));
        account.executeDirectPayment(intent);
    }

    function testRouteExecutionRejectsZeroAmountOut() public {
        bytes memory routeCalldata = abi.encodeCall(MockRouteTarget.route, (address(token), recipient, 100));
        AgentPayAccount.RoutePaymentIntent memory intent = AgentPayAccount.RoutePaymentIntent({
            sourceToken: address(token),
            maxAmountIn: 100,
            destinationChainId: 8453,
            recipient: recipient,
            amountOut: 0,
            routeTarget: address(routeTarget),
            routeCalldataHash: keccak256(routeCalldata),
            maxNativeFee: 0,
            nonce: 1,
            deadline: block.timestamp + 1
        });

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(AgentPayAccount.InvalidAmount.selector));
        account.executeRoutePayment(intent, routeCalldata);
    }

    function testContractCallRejectsNativeFeeAboveMax() public {
        bytes memory callData = abi.encodeCall(MockContractTarget.pay, (address(token), recipient, 100));
        AgentPayAccount.ContractCallIntent memory intent =
            contractCallIntent(1, address(contractTarget), callData, 100, 1 wei);

        vm.deal(executor, 1 ether);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(AgentPayAccount.NativeFeeTooHigh.selector, 2 wei, 1 wei));
        account.executeContractCall{value: 2 wei}(intent, callData);
    }

    function testDirectPaymentTransfersCorrectAmount() public {
        vm.prank(executor);
        account.executeDirectPayment(directIntent(1, 100));

        assertEq(token.balanceOf(recipient), 100);
        assertEq(token.balanceOf(address(account)), 999_900);
    }

    function testDirectPaymentEmitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit DirectPaymentExecuted(1, address(token), recipient, 100);

        vm.prank(executor);
        account.executeDirectPayment(directIntent(1, 100));
    }

    function testRoutePaymentCallsTargetAndResetsAllowance() public {
        bytes memory routeCalldata = abi.encodeCall(MockRouteTarget.route, (address(token), recipient, 100));
        AgentPayAccount.RoutePaymentIntent memory intent = routeIntent(1, address(routeTarget), routeCalldata, 120, 0);

        vm.prank(executor);
        account.executeRoutePayment(intent, routeCalldata);

        assertEq(token.balanceOf(recipient), 100);
        assertEq(token.allowance(address(account), address(routeTarget)), 0);
    }

    function testRoutePaymentFailureRollsBackNonceAllowanceAndBalance() public {
        RevertingTarget failingTarget = new RevertingTarget();
        vm.prank(owner);
        account.setAllowedRouteTarget(address(failingTarget), true);

        bytes memory routeCalldata = abi.encodeCall(RevertingTarget.route, (address(token), recipient, 100));
        AgentPayAccount.RoutePaymentIntent memory intent = routeIntent(1, address(failingTarget), routeCalldata, 100, 0);

        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentPayAccount.ExternalCallFailed.selector, abi.encodeWithSignature("Error(string)", "target failed")
            )
        );
        account.executeRoutePayment(intent, routeCalldata);

        assertFalse(account.usedNonces(1));
        assertEq(token.allowance(address(account), address(failingTarget)), 0);
        assertEq(token.balanceOf(address(account)), 1_000_000);
        assertEq(token.balanceOf(recipient), 0);
    }

    function testRoutePaymentEmitsEvent() public {
        bytes memory routeCalldata = abi.encodeCall(MockRouteTarget.route, (address(token), recipient, 100));
        AgentPayAccount.RoutePaymentIntent memory intent = routeIntent(1, address(routeTarget), routeCalldata, 120, 0);

        vm.expectEmit(true, true, true, true);
        emit RoutePaymentExecuted(1, address(token), address(routeTarget), 120, 8453, recipient, 100);

        vm.prank(executor);
        account.executeRoutePayment(intent, routeCalldata);
    }

    function testContractCallApprovesTargetCallsAndResetsAllowance() public {
        bytes memory callData = abi.encodeCall(MockContractTarget.pay, (address(token), recipient, 100));
        AgentPayAccount.ContractCallIntent memory intent =
            contractCallIntent(1, address(contractTarget), callData, 120, 0);

        vm.prank(executor);
        account.executeContractCall(intent, callData);

        assertEq(token.balanceOf(recipient), 100);
        assertEq(token.allowance(address(account), address(contractTarget)), 0);
    }

    function testContractCallFailureRollsBackNonceAllowanceAndBalance() public {
        RevertingTarget failingTarget = new RevertingTarget();
        vm.prank(owner);
        account.setAllowedRouteTarget(address(failingTarget), true);

        bytes memory callData = abi.encodeCall(RevertingTarget.pay, (address(token), recipient, 100));
        AgentPayAccount.ContractCallIntent memory intent =
            contractCallIntent(1, address(failingTarget), callData, 100, 0);

        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentPayAccount.ExternalCallFailed.selector, abi.encodeWithSignature("Error(string)", "target failed")
            )
        );
        account.executeContractCall(intent, callData);

        assertFalse(account.usedNonces(1));
        assertEq(token.allowance(address(account), address(failingTarget)), 0);
        assertEq(token.balanceOf(address(account)), 1_000_000);
        assertEq(token.balanceOf(recipient), 0);
    }

    function testContractCallRejectsUnallowedTarget() public {
        MockContractTarget otherTarget = new MockContractTarget();
        bytes memory callData = abi.encodeCall(MockContractTarget.pay, (address(token), recipient, 100));
        AgentPayAccount.ContractCallIntent memory intent = contractCallIntent(1, address(otherTarget), callData, 120, 0);

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(AgentPayAccount.RouteTargetNotAllowed.selector, address(otherTarget)));
        account.executeContractCall(intent, callData);
    }

    function testContractCallRejectsCalldataHashMismatch() public {
        bytes memory callData = abi.encodeCall(MockContractTarget.pay, (address(token), recipient, 100));
        AgentPayAccount.ContractCallIntent memory intent =
            contractCallIntent(1, address(contractTarget), callData, 120, 0);
        bytes memory tamperedCallData = abi.encodeCall(MockContractTarget.pay, (address(token), recipient, 101));

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(AgentPayAccount.CalldataHashMismatch.selector));
        account.executeContractCall(intent, tamperedCallData);
    }

    function testContractCallEmitsEvent() public {
        bytes memory callData = abi.encodeCall(MockContractTarget.pay, (address(token), recipient, 100));
        AgentPayAccount.ContractCallIntent memory intent =
            contractCallIntent(1, address(contractTarget), callData, 120, 1 wei);

        vm.deal(executor, 1 ether);
        vm.expectEmit(true, true, true, true);
        emit ContractCallExecuted(1, address(contractTarget), address(token), 120, 1 wei);

        vm.prank(executor);
        account.executeContractCall{value: 1 wei}(intent, callData);
    }

    function testOwnerCanWithdrawToken() public {
        vm.prank(owner);
        account.withdrawToken(address(token), owner, 100);

        assertEq(token.balanceOf(owner), 100);
    }

    function testOwnerCanWithdrawNative() public {
        vm.deal(address(account), 1 ether);

        vm.prank(owner);
        account.withdrawNative(payable(owner), 0.25 ether);

        assertEq(owner.balance, 0.25 ether);
    }

    function testOwnerCanCancelNonce() public {
        vm.expectEmit(true, false, false, true);
        emit NonceCancelled(1);

        vm.prank(owner);
        account.cancelNonce(1);

        assertTrue(account.usedNonces(1));
    }

    function testPaymentCannotReplayAfterSuccess() public {
        AgentPayAccount.DirectPaymentIntent memory intent = directIntent(1, 100);

        vm.prank(executor);
        account.executeDirectPayment(intent);

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(AgentPayAccount.NonceAlreadyUsed.selector, 1));
        account.executeDirectPayment(intent);
    }

    function testFuzzDirectPaymentTransfersExactAmountAndConsumesNonce(
        uint256 nonce,
        uint256 rawAmount,
        address fuzzRecipient
    ) public {
        vm.assume(fuzzRecipient != address(0));
        vm.assume(fuzzRecipient != address(account));

        uint256 amount = bound(rawAmount, 1, 1_000_000);
        uint256 accountBalanceBefore = token.balanceOf(address(account));
        uint256 recipientBalanceBefore = token.balanceOf(fuzzRecipient);
        AgentPayAccount.DirectPaymentIntent memory intent = AgentPayAccount.DirectPaymentIntent({
            token: address(token), recipient: fuzzRecipient, amount: amount, nonce: nonce, deadline: block.timestamp + 1
        });

        vm.prank(executor);
        account.executeDirectPayment(intent);

        assertTrue(account.usedNonces(nonce));
        assertEq(token.balanceOf(fuzzRecipient), recipientBalanceBefore + amount);
        assertEq(token.balanceOf(address(account)), accountBalanceBefore - amount);
    }

    function testFuzzDirectPaymentRejectsAmountAboveBalance(uint256 nonce, uint256 rawExtra) public {
        uint256 extra = bound(rawExtra, 1, 1_000_000);
        uint256 amount = 1_000_000 + extra;

        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPayAccount.InsufficientTokenBalance.selector, address(token), amount, 1_000_000)
        );
        account.executeDirectPayment(directIntent(nonce, amount));
    }

    function testFuzzDirectPaymentRejectsPastDeadlines(uint256 nonce, uint256 rawAge) public {
        uint256 currentTimestamp = 1_000_000_000;
        uint256 age = bound(rawAge, 1, 365 days);
        vm.warp(currentTimestamp);

        AgentPayAccount.DirectPaymentIntent memory intent = AgentPayAccount.DirectPaymentIntent({
            token: address(token), recipient: recipient, amount: 100, nonce: nonce, deadline: currentTimestamp - age
        });

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(AgentPayAccount.DeadlineExpired.selector, currentTimestamp - age));
        account.executeDirectPayment(intent);
    }

    function testFuzzRoutePaymentSpendsOnlyCalledAmountAndResetsAllowance(
        uint256 nonce,
        uint256 rawSpendAmount,
        uint256 rawMaxAmountIn
    ) public {
        uint256 spendAmount = bound(rawSpendAmount, 1, 1_000_000);
        uint256 maxAmountIn = bound(rawMaxAmountIn, spendAmount, 1_000_000);
        bytes memory routeCalldata = abi.encodeCall(MockRouteTarget.route, (address(token), recipient, spendAmount));
        AgentPayAccount.RoutePaymentIntent memory intent = AgentPayAccount.RoutePaymentIntent({
            sourceToken: address(token),
            maxAmountIn: maxAmountIn,
            destinationChainId: 8453,
            recipient: recipient,
            amountOut: spendAmount,
            routeTarget: address(routeTarget),
            routeCalldataHash: keccak256(routeCalldata),
            maxNativeFee: 0,
            nonce: nonce,
            deadline: block.timestamp + 1
        });

        vm.prank(executor);
        account.executeRoutePayment(intent, routeCalldata);

        assertTrue(account.usedNonces(nonce));
        assertEq(token.balanceOf(recipient), spendAmount);
        assertEq(token.balanceOf(address(account)), 1_000_000 - spendAmount);
        assertEq(token.allowance(address(account), address(routeTarget)), 0);
    }

    function testStressExecutesManySequentialDirectPaymentsWithUniqueNonces() public {
        uint256 paymentCount = 128;

        for (uint256 index = 0; index < paymentCount; index++) {
            uint256 nonce = index + 1;

            vm.prank(executor);
            account.executeDirectPayment(directIntent(nonce, 1));

            assertTrue(account.usedNonces(nonce));
        }

        assertEq(token.balanceOf(recipient), paymentCount);
        assertEq(token.balanceOf(address(account)), 1_000_000 - paymentCount);
    }

    function directIntent(uint256 nonce, uint256 amount)
        private
        view
        returns (AgentPayAccount.DirectPaymentIntent memory)
    {
        return AgentPayAccount.DirectPaymentIntent({
            token: address(token), recipient: recipient, amount: amount, nonce: nonce, deadline: block.timestamp + 1
        });
    }

    function routeIntent(
        uint256 nonce,
        address target,
        bytes memory routeCalldata,
        uint256 maxAmountIn,
        uint256 maxNativeFee
    ) private view returns (AgentPayAccount.RoutePaymentIntent memory) {
        return AgentPayAccount.RoutePaymentIntent({
            sourceToken: address(token),
            maxAmountIn: maxAmountIn,
            destinationChainId: 8453,
            recipient: recipient,
            amountOut: 100,
            routeTarget: target,
            routeCalldataHash: keccak256(routeCalldata),
            maxNativeFee: maxNativeFee,
            nonce: nonce,
            deadline: block.timestamp + 1
        });
    }

    function contractCallIntent(
        uint256 nonce,
        address target,
        bytes memory callData,
        uint256 maxTokenSpend,
        uint256 maxNativeFee
    ) private view returns (AgentPayAccount.ContractCallIntent memory) {
        return AgentPayAccount.ContractCallIntent({
            target: target,
            token: address(token),
            maxTokenSpend: maxTokenSpend,
            callDataHash: keccak256(callData),
            maxNativeFee: maxNativeFee,
            nonce: nonce,
            deadline: block.timestamp + 1
        });
    }

    function bound(uint256 value, uint256 min, uint256 max) private pure returns (uint256) {
        require(min <= max, "invalid bound");
        return min + (value % (max - min + 1));
    }
}
