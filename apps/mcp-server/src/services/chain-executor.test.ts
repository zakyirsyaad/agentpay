import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AbiCoder, keccak256 } from "ethers";

import {
  agentPayAccountInterface,
  agentPayAccountV2Interface,
  assertExecutorRpcChain,
  createEthersNativeBalanceReader,
  createEthersAuthorizedPaymentExecutor,
  createEthersRouteTargetAllowanceChecker,
  createEthersRoutePaymentExecutor,
  createEthersSourceTransactionStatusProvider,
  createEthersTokenBalanceChecker,
  createEthersTokenBalanceReader,
  erc20Interface,
  resolveRpcUrlForChain,
} from "./chain-executor.ts";
import { createInMemoryInvoiceExecutionOutboxStore } from "./paid-execution-outbox.ts";
import type { PaidExecutionLifecycleStore } from "./paid-execution-lifecycle.ts";

const directAuthorization = {
  intentIdHash: `0x${"11".repeat(32)}`,
  tenantIdHash: `0x${"22".repeat(32)}`,
  paymentType: `0x${"33".repeat(32)}`,
  owner: "0x2222222222222222222222222222222222222222",
  account: "0x3333333333333333333333333333333333333333",
  ["token"]: "0x5555555555555555555555555555555555555555",
  recipient: "0x1111111111111111111111111111111111111111",
  amount: "10000000",
  nonce: "42",
  deadline: "1783003500",
  purposeHash: `0x${"44".repeat(32)}`,
};

describe("createEthersRoutePaymentExecutor", () => {
  it("encodes executeRoutePayment and submits it to the stored account address", async () => {
    const transactions: Array<{ to: string; data: string; value: bigint; chainId?: number }> = [];
    const executor = createEthersRoutePaymentExecutor({
      async sendTransaction(transaction, chainId) {
        transactions.push({ ...transaction, chainId });
        return { hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
      },
    });

    const result = await executor.executeRoutePayment({
      accountAddress: "0x3333333333333333333333333333333333333333",
      sourceChainId: 196,
      sourceTokenAddress: "0x5555555555555555555555555555555555555555",
      sourceTokenSymbol: "USDT0",
      maxAmountIn: "10.18",
      destinationChainId: 8453,
      recipientAddress: "0x1111111111111111111111111111111111111111",
      destinationTokenSymbol: "USDC",
      amountOut: "10",
      routeTarget: "0x7777777777777777777777777777777777777777",
      routeCalldata: "0x1234",
      routeCalldataHash: "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432",
      maxNativeFee: "250000000000000",
      nonce: "42",
      deadline: "2026-07-02T14:45:00.000Z",
    });

    assert.equal(result.sourceTxHash, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0].to, "0x3333333333333333333333333333333333333333");
    assert.equal(transactions[0].value, 250000000000000n);
    assert.equal(transactions[0].chainId, 196);

    const parsed = agentPayAccountInterface.parseTransaction({
      data: transactions[0].data,
      value: transactions[0].value,
    });

    assert.equal(parsed?.name, "executeRoutePayment");
    const intent = parsed?.args[0];
    assert.equal(intent.sourceToken, "0x5555555555555555555555555555555555555555");
    assert.equal(intent.maxAmountIn, 10_180_000n);
    assert.equal(intent.destinationChainId, 8453n);
    assert.equal(intent.recipient, "0x1111111111111111111111111111111111111111");
    assert.equal(intent.amountOut, 10_000_000n);
    assert.equal(intent.routeTarget, "0x7777777777777777777777777777777777777777");
    assert.equal(intent.routeCalldataHash, "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432");
    assert.equal(intent.maxNativeFee, 250000000000000n);
    assert.equal(intent.nonce, 42n);
    assert.equal(intent.deadline, 1783003500n);
    assert.equal(parsed?.args[1], "0x1234");
  });

  it("encodes executeDirectPayment and submits it with no native value", async () => {
    const transactions: Array<{ to: string; data: string; value: bigint; chainId?: number }> = [];
    const executor = createEthersRoutePaymentExecutor({
      async sendTransaction(transaction, chainId) {
        transactions.push({ ...transaction, chainId });
        return { hash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" };
      },
    });

    const result = await executor.executeDirectPayment({
      accountAddress: "0x3333333333333333333333333333333333333333",
      chainId: 196,
      tokenAddress: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
      tokenSymbol: "USDT0",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      amount: "10",
      nonce: "43",
      deadline: "2026-07-02T14:45:00.000Z",
    });

    assert.equal(result.sourceTxHash, "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd");
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0].to, "0x3333333333333333333333333333333333333333");
    assert.equal(transactions[0].value, 0n);
    assert.equal(transactions[0].chainId, 196);

    const parsed = agentPayAccountInterface.parseTransaction({
      data: transactions[0].data,
      value: transactions[0].value,
    });

    assert.equal(parsed?.name, "executeDirectPayment");
    const intent = parsed?.args[0];
    assert.equal(intent.token, "0x779Ded0c9e1022225f8E0630b35a9b54bE713736");
    assert.equal(intent.recipient, "0x1111111111111111111111111111111111111111");
    assert.equal(intent.amount, 10_000_000n);
    assert.equal(intent.nonce, 43n);
    assert.equal(intent.deadline, 1783003500n);
  });

  it("encodes executeContractCall and submits it with bounded native value", async () => {
    const transactions: Array<{ to: string; data: string; value: bigint; chainId?: number }> = [];
    const executor = createEthersRoutePaymentExecutor({
      async sendTransaction(transaction, chainId) {
        transactions.push({ ...transaction, chainId });
        return { hash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" };
      },
    });

    const result = await executor.executeContractCall({
      accountAddress: "0x3333333333333333333333333333333333333333",
      chainId: 196,
      target: "0x8888888888888888888888888888888888888888",
      tokenAddress: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
      tokenSymbol: "USDT0",
      maxTokenSpend: "7.5",
      callData: "0xaabbccdd",
      callDataHash: "0x40eed0325a12c6c6af8db2ea05450bfe21d6343b6fe955bff65045b67d9d5fe6",
      maxNativeFee: "250000000000000",
      nonce: "44",
      deadline: "2026-07-02T14:45:00.000Z",
    });

    assert.equal(result.sourceTxHash, "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0].to, "0x3333333333333333333333333333333333333333");
    assert.equal(transactions[0].value, 250000000000000n);
    assert.equal(transactions[0].chainId, 196);

    const parsed = agentPayAccountInterface.parseTransaction({
      data: transactions[0].data,
      value: transactions[0].value,
    });

    assert.equal(parsed?.name, "executeContractCall");
    const intent = parsed?.args[0];
    assert.equal(intent.target, "0x8888888888888888888888888888888888888888");
    assert.equal(intent.token, "0x779Ded0c9e1022225f8E0630b35a9b54bE713736");
    assert.equal(intent.maxTokenSpend, 7_500_000n);
    assert.equal(intent.callDataHash, "0x40eed0325a12c6c6af8db2ea05450bfe21d6343b6fe955bff65045b67d9d5fe6");
    assert.equal(intent.maxNativeFee, 250000000000000n);
    assert.equal(intent.nonce, 44n);
    assert.equal(intent.deadline, 1783003500n);
    assert.equal(parsed?.args[1], "0xaabbccdd");
  });
});

describe("createEthersAuthorizedPaymentExecutor", () => {
  it("encodes a V2 direct authorization and owner signature without changing fields", async () => {
    const transactions: Array<{ to: string; data: string; value: bigint; chainId?: number }> = [];
    const executor = createEthersAuthorizedPaymentExecutor({
      async sendTransaction(transaction, chainId) {
        transactions.push({ ...transaction, chainId });
        return { hash: `0x${"aa".repeat(32)}` };
      },
    });
    const signature = `0x${"55".repeat(65)}`;

    const result = await executor.executeAuthorizedDirectPayment({
      accountAddress: directAuthorization.account,
      chainId: 196,
      authorization: directAuthorization,
      signature,
    });

    assert.equal(result.sourceTxHash, `0x${"aa".repeat(32)}`);
    assert.equal(transactions[0]?.value, 0n);
    assert.equal(transactions[0]?.chainId, 196);
    const parsed = agentPayAccountV2Interface.parseTransaction({ data: transactions[0].data });
    assert.equal(parsed?.name, "executeAuthorizedDirectPayment");
    assert.equal(parsed?.args[0].intentIdHash, directAuthorization.intentIdHash);
    assert.equal(parsed?.args[0].amount, 10000000n);
    assert.equal(parsed?.args[0].nonce, 42n);
    assert.equal(parsed?.args[1], signature);
  });

  it("encodes a V2 route authorization and uses only its signed native fee cap", async () => {
    const transactions: Array<{ to: string; data: string; value: bigint; chainId?: number }> = [];
    const executor = createEthersAuthorizedPaymentExecutor({
      async sendTransaction(transaction, chainId) {
        transactions.push({ ...transaction, chainId });
        return { hash: `0x${"bb".repeat(32)}` };
      },
    });
    const routeAuthorization = {
      ...directAuthorization,
      sourceToken: directAuthorization["token"],
      maxAmountIn: "10180000",
      destinationChainId: "8453",
      destinationToken: "0x6666666666666666666666666666666666666666",
      minAmountOut: "10000000",
      routeTarget: "0x7777777777777777777777777777777777777777",
      routeCalldataHash: `0x${"66".repeat(32)}`,
      maxNativeFee: "250000000000000",
      nativeValue: "100000000000000",
    };

    await executor.executeAuthorizedRoutePayment({
      accountAddress: routeAuthorization.account,
      sourceChainId: 196,
      authorization: routeAuthorization,
      routeCalldata: "0x1234",
      nativeValue: "100000000000000",
      signature: `0x${"77".repeat(65)}`,
    });

    assert.equal(transactions[0]?.value, 100000000000000n);
    assert.equal(transactions[0]?.chainId, 196);
    const parsed = agentPayAccountV2Interface.parseTransaction({ data: transactions[0].data });
    assert.equal(parsed?.name, "executeAuthorizedRoutePayment");
    assert.equal(parsed?.args[0].destinationChainId, 8453n);
    assert.equal(parsed?.args[0].minAmountOut, 10000000n);
    assert.equal(parsed?.args[1], "0x1234");
  });

  it("persists the signed transaction before broadcasting a durable paid execution", async () => {
    const events: string[] = [];
    const outbox = createInMemoryInvoiceExecutionOutboxStore(() => "fence_1");
    const lifecycle = { markExecutionBroadcasted: async () => undefined } as unknown as PaidExecutionLifecycleStore;
    const executorAddress = "0x9999999999999999999999999999999999999999";
    const executor = createEthersAuthorizedPaymentExecutor({
      async sendTransaction() {
        throw new Error("durable path must not call Wallet.sendTransaction");
      },
      async prepareAndSignTransaction(transaction) {
        const record = await outbox.get("outbox_lifecycle_1");
        assert.equal(record?.status, "QUEUED");
        events.push("prepared");
        const rawTransaction = "0xdeadbeef";
        return {
          rawTransaction,
          transactionHash: keccak256(rawTransaction),
          executorNonce: "9",
          chainId: 196,
          from: executorAddress,
          to: transaction.to,
          data: transaction.data,
          value: String(transaction.value),
        };
      },
      async broadcastSignedTransaction() {
        const record = await outbox.get("outbox_lifecycle_1");
        assert.equal(record?.status, "BROADCAST_UNKNOWN");
        events.push("broadcast");
        return { hash: keccak256("0xdeadbeef") };
      },
    });

    const result = await executor.executeAuthorizedDirectPayment({
      accountAddress: directAuthorization.account,
      chainId: 196,
      authorization: directAuthorization,
      signature: `0x${"55".repeat(65)}`,
      durableExecution: {
        lifecycleId: "lifecycle_1",
        outboxId: "outbox_lifecycle_1",
        tenantId: "tenant_1",
        paymentIntentId: "pay_1",
        executorAddress,
        ownerAuthorizationNonce: directAuthorization.nonce,
        rawTxEncryptionKey: "a".repeat(64),
        outbox,
        lifecycle,
        now: (() => "2026-07-13T00:00:00.000Z"),
      },
    });

    assert.equal(result.sourceTxHash, keccak256("0xdeadbeef"));
    assert.deepEqual(events, ["prepared", "broadcast"]);
    const record = await outbox.get("outbox_lifecycle_1");
    assert.equal(record?.status, "BROADCASTED");
    assert.equal(record?.transactionHash, keccak256("0xdeadbeef"));
    assert.ok(record?.rawTransaction);
  });

  it("marks a durable outbox broadcast as unknown when the RPC response fails", async () => {
    const outbox = createInMemoryInvoiceExecutionOutboxStore(() => "fence_2");
    const lifecycle = { markExecutionBroadcasted: async () => undefined } as unknown as PaidExecutionLifecycleStore;
    const executorAddress = "0x9999999999999999999999999999999999999999";
    const executor = createEthersAuthorizedPaymentExecutor({
      async sendTransaction() {
        throw new Error("durable path must not call Wallet.sendTransaction");
      },
      async prepareAndSignTransaction(transaction) {
        const rawTransaction = "0xbeefdead";
        return {
          rawTransaction,
          transactionHash: keccak256(rawTransaction),
          executorNonce: "10",
          chainId: 196,
          from: executorAddress,
          to: transaction.to,
          data: transaction.data,
          value: String(transaction.value),
        };
      },
      async broadcastSignedTransaction() {
        throw new Error("RPC connection lost after submission");
      },
    });

    await assert.rejects(
      () => executor.executeAuthorizedDirectPayment({
        accountAddress: directAuthorization.account,
        chainId: 196,
        authorization: directAuthorization,
        signature: `0x${"55".repeat(65)}`,
        durableExecution: {
          lifecycleId: "lifecycle_2",
          outboxId: "outbox_lifecycle_2",
          tenantId: "tenant_1",
          paymentIntentId: "pay_2",
          executorAddress,
          ownerAuthorizationNonce: directAuthorization.nonce,
          rawTxEncryptionKey: "b".repeat(64),
          outbox,
          lifecycle,
          now: (() => "2026-07-13T00:00:00.000Z"),
        },
      }),
      /RPC connection lost/i,
    );
    assert.equal((await outbox.get("outbox_lifecycle_2"))?.status, "BROADCAST_UNKNOWN");
  });
});

describe("createEthersTokenBalanceChecker", () => {
  it("checks ERC20 balanceOf against a decimal stablecoin requirement", async () => {
    const calls: Array<{ to: string; data: string; chainId?: number }> = [];
    const checker = createEthersTokenBalanceChecker({
      async call(transaction, chainId) {
        calls.push({ ...transaction, chainId });
        return AbiCoder.defaultAbiCoder().encode(["uint256"], [10_180_000n]);
      },
    });

    const hasBalance = await checker.hasSufficientTokenBalance({
      accountAddress: "0x3333333333333333333333333333333333333333",
      chainId: 196,
      tokenAddress: "0x5555555555555555555555555555555555555555",
      tokenSymbol: "USDT0",
      requiredAmount: "10.18",
    });

    assert.equal(hasBalance, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].to, "0x5555555555555555555555555555555555555555");
    assert.equal(calls[0].chainId, 196);
    const parsed = erc20Interface.parseTransaction({ data: calls[0].data });
    assert.equal(parsed?.name, "balanceOf");
    assert.equal(parsed?.args[0], "0x3333333333333333333333333333333333333333");
  });

  it("returns false when ERC20 balance is below the required amount", async () => {
    const checker = createEthersTokenBalanceChecker({
      async call() {
        return AbiCoder.defaultAbiCoder().encode(["uint256"], [10_179_999n]);
      },
    });

    const hasBalance = await checker.hasSufficientTokenBalance({
      accountAddress: "0x3333333333333333333333333333333333333333",
      chainId: 196,
      tokenAddress: "0x5555555555555555555555555555555555555555",
      tokenSymbol: "USDT0",
      requiredAmount: "10.18",
    });

    assert.equal(hasBalance, false);
  });
});

describe("createEthersRouteTargetAllowanceChecker", () => {
  it("checks the AgentPay account route target allowlist mapping", async () => {
    const calls: Array<{ to: string; data: string; chainId?: number }> = [];
    const checker = createEthersRouteTargetAllowanceChecker({
      async call(transaction, chainId) {
        calls.push({ ...transaction, chainId });
        return AbiCoder.defaultAbiCoder().encode(["bool"], [true]);
      },
    });

    const allowed = await checker.isRouteTargetAllowed({
      accountAddress: "0x3333333333333333333333333333333333333333",
      chainId: 196,
      routeTarget: "0x7777777777777777777777777777777777777777",
    });

    assert.equal(allowed, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].to, "0x3333333333333333333333333333333333333333");
    assert.equal(calls[0].chainId, 196);
    const parsed = agentPayAccountInterface.parseTransaction({ data: calls[0].data });
    assert.equal(parsed?.name, "allowedRouteTargets");
    assert.equal(parsed?.args[0], "0x7777777777777777777777777777777777777777");
  });
});

describe("createEthersSourceTransactionStatusProvider", () => {
  it("normalizes source transaction receipts", async () => {
    const requested: Array<{ txHash: string; chainId?: number }> = [];
    const provider = createEthersSourceTransactionStatusProvider({
      async getTransactionReceipt(txHash, chainId) {
        requested.push({ txHash, chainId });

        if (txHash.endsWith("01")) {
          return { status: 1 };
        }

        if (txHash.endsWith("00")) {
          return { status: 0 };
        }

        return null;
      },
    });

    assert.deepEqual(
      await provider.getSourceTransactionStatus({
        txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01",
        chainId: 196,
      }),
      { status: "SUCCESS" },
    );
    assert.deepEqual(
      await provider.getSourceTransactionStatus({
        txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa00",
        chainId: 196,
      }),
      { status: "FAILED" },
    );
    assert.deepEqual(
      await provider.getSourceTransactionStatus({
        txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaff",
        chainId: 196,
      }),
      { status: "PENDING" },
    );
    assert.deepEqual(requested, [
      { txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01", chainId: 196 },
      { txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa00", chainId: 196 },
      { txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaff", chainId: 196 },
    ]);
  });
});

describe("createEthersTokenBalanceReader", () => {
  it("formats ERC20 balanceOf results using chain-specific token decimals", async () => {
    const calls: Array<{ to: string; data: string; chainId?: number }> = [];
    const reader = createEthersTokenBalanceReader({
      async call(transaction, chainId) {
        calls.push({ ...transaction, chainId });
        return AbiCoder.defaultAbiCoder().encode(["uint256"], [12_500_000_000_000_000_000n]);
      },
    });

    const balance = await reader.getTokenBalance({
      accountAddress: "0x3333333333333333333333333333333333333333",
      chainId: 196,
      tokenAddress: "0x5555555555555555555555555555555555555555",
      tokenSymbol: "USDT0",
      decimals: 18,
    });

    assert.deepEqual(balance, { amount: "12.5" });
    assert.equal(calls[0].chainId, 196);
  });
});

describe("createEthersNativeBalanceReader", () => {
  it("formats native balances using native currency decimals", async () => {
    const calls: Array<{ accountAddress: string; chainId?: number }> = [];
    const reader = createEthersNativeBalanceReader({
      async getBalance(accountAddress, chainId) {
        calls.push({ accountAddress, chainId });
        return 30_000_000_000_000_000n;
      },
    });

    const balance = await reader.getNativeBalance({
      accountAddress: "0x3333333333333333333333333333333333333333",
      chainId: 196,
      tokenSymbol: "OKB",
      decimals: 18,
    });

    assert.deepEqual(calls, [{ accountAddress: "0x3333333333333333333333333333333333333333", chainId: 196 }]);
    assert.deepEqual(balance, { amount: "0.03" });
  });
});

describe("resolveRpcUrlForChain", () => {
  it("uses network-specific X Layer RPC URLs with the legacy RPC as fallback", () => {
    const config = {
      rpcUrl: "https://fallback.xlayer.example",
      rpcUrls: {
        196: "https://mainnet.xlayer.example",
        1952: "https://testnet.xlayer.example",
      },
    };

    assert.equal(resolveRpcUrlForChain(config, 196), "https://mainnet.xlayer.example");
    assert.equal(resolveRpcUrlForChain(config, 1952), "https://testnet.xlayer.example");
    assert.equal(resolveRpcUrlForChain(config, 8453), "https://fallback.xlayer.example");
    assert.equal(resolveRpcUrlForChain({ rpcUrl: "https://fallback.xlayer.example" }, 1952), "https://fallback.xlayer.example");
  });
});

describe("assertExecutorRpcChain", () => {
  it("fails closed when an executor RPC resolves to another chain", () => {
    assert.doesNotThrow(() => assertExecutorRpcChain(196, 196));
    assert.throws(() => assertExecutorRpcChain(196, 1952), /chain mismatch/);
  });
});
