# @kasakame/sdk

Chain layer for kasakame: claim-tree proofs, campaign reads, and transaction
assembly for Algorand. The SDK builds unsigned transactions and transaction
groups; the wallet or CLI signer keeps the keys. It never holds keys or funds.

The package ships the generated typed clients, so consumers do not need the contract artifacts.

## Install

```bash
npm install @kasakame/sdk
```

Node.js 24 or newer, ESM.

## Configure once

```ts
import { configureSdk } from '@kasakame/sdk'
import { AlgorandClient } from '@algorandfoundation/algokit-utils'

const algorand = AlgorandClient.fromConfig({
  algodConfig: { server, port, token },
  indexerConfig: { server, port, token },
})

configureSdk({
  algorand,
  factoryAppId: 774437557n,
  vaultAppId: 774437570n,
})
```

Every read and write uses that session. Reads go through the indexer; writes
build transaction groups for the caller's `WalletSession`.

## Read and write

```ts
import { fetchChainTimestamp, getCampaign, pledge } from '@kasakame/sdk'

const now = await fetchChainTimestamp()
const campaign = await getCampaign(appId, now)

await pledge(appId, { address, signer }, amountMicroAlgos)
```

See the [SDK documentation](https://github.com/kasakame/kasakame/blob/main/docs/sdk.md)
for the full public API: campaign reads, claim-tree math and replay, pledge and
refund groups, and the settlement calls.

## License

MIT. See [LICENSE](https://github.com/kasakame/kasakame/blob/main/projects/sdk/LICENSE).
