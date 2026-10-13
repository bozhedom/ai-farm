ExecutionFixture.sol is a small local contract fixture, not Aave source code.
It implements the ERC20 and Pool calls/events used by the execution adapter.
The tests verify signing, exact allowance, receipts, nonce conflicts and recovery.
They do not verify public Aave deployment addresses, liquidity or live acceptance.

bytecode.json was compiled with solc 0.8.30 using Foundry v1.3.5:

mkdir -p output/aave-fixture-build
docker run --rm -v "$PWD/tests/fixtures/aave:/fixture:ro" -v "$PWD/output/aave-fixture-build:/output" --entrypoint forge ghcr.io/foundry-rs/foundry:v1.3.5 build --root /fixture --contracts /fixture --out /output --cache-path /tmp/forge-cache --use 0.8.30

The artifact stores abi and bytecode.object for FixtureToken and FixturePool,
the compiler version, and the SHA256 of ExecutionFixture.sol. The integration
suite checks this source digest before deploying on a verified local Anvil node.

Run with the isolated Anvil started by npm run test:crypto, or explicitly:
AAVE_ANVIL_RPC_URL=http://127.0.0.1:18549 npx vitest run tests/integration/execution-aave-anvil.test.ts
