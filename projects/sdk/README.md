# @kasakame/sdk

Chain layer for kasakame: claim-tree proofs, campaign reads, and transaction
assembly for Algorand. The SDK builds unsigned transactions and transaction
groups; the wallet or CLI signer keeps the keys. It never holds keys or funds.

The package ships the generated typed clients, so consumers do not need the contract artifacts.

## Install

```bash
npm install @kasakame/sdk @kasakame/constants @algorandfoundation/algokit-utils
```

Node.js 24 or newer, ESM. The SDK declares
`@kasakame/constants@^0.2.0` and `@algorandfoundation/algokit-utils@^9.0.0` as
peer dependencies; install them alongside the SDK. `algokit-utils` stays a peer
because the SDK uses the `AlgorandClient` you pass to `configureSdk`, and a
second copy can mismatch types and runtime classes.

## Usage

### Configure once

```ts
import { configureSdk } from '@kasakame/sdk'
import { AlgorandClient } from '@algorandfoundation/algokit-utils'

const algorand = AlgorandClient.fromConfig({
  algodConfig: { server, port, token },
  indexerConfig: { server, port, token },
})

configureSdk({
  algorand,
  registryAppId: 776939068n,
  vaultAppId: 776939077n,
})
```

Every read and write uses that session. Reads go through the indexer; writes
build transaction groups for the caller's `WalletSession`.

### Read and write

```ts
import { fetchChainTimestamp, getCampaign, pledge } from '@kasakame/sdk'

const now = await fetchChainTimestamp()
const campaign = await getCampaign(appId, now)

await pledge(appId, { address, signer }, amountMicroAlgos)
```

## Documentation

- [SDK documentation](https://github.com/kasakame/kasakame/blob/main/docs/sdk.md)
- [Repository](https://github.com/kasakame/kasakame)
- [Issues](https://github.com/kasakame/kasakame/issues)

## License

MIT. See [LICENSE](https://github.com/kasakame/kasakame/blob/main/projects/sdk/LICENSE).
