# AgentPayAccountV2 security specification

`AgentPayAccountV2.t.sol` was the RED suite for I-002.1. After the V2 contract was implemented and the matrix became green, it was promoted to `contracts/test/AgentPayAccountV2.t.sol` so the default Foundry gate includes it.

The historical RED-to-green activation command was:

```sh
cd contracts
FOUNDRY_TEST=spec forge test --match-path AgentPayAccountV2.t.sol
```

The current normal gate is simply:

```sh
cd contracts
forge test --fuzz-runs 1024
```
