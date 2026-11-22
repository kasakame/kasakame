# @kasakame/contracts

Compiled contract artifacts for the kasakame crowdfunding protocol: ARC-56 and
ARC-32 application specs, approval and clear TEAL, and Puya source maps.

The artifacts are generated from the kasakame contracts repository. That
repository is the source of truth; this package is the npm mirror of the
`contracts-v<version>` GitHub release, built from the same commit.

## Install

```bash
npm install @kasakame/contracts
```

## Layout

Each artifact family keeps one directory per application:

```text
dist/arc56/<app>/<App>.arc56.json
dist/arc32/<app>/<App>.arc32.json
dist/teal/<app>/<App>.approval.teal
dist/teal/<app>/<App>.clear.teal
dist/puya/<app>/<App>.approval.puya.map
dist/puya/<app>/<App>.clear.puya.map
```

The package contains no contract source, no deployer, and no generated clients.

## Usage

- The SDK reads the ARC-56 specs from this package to generate its typed
  clients.
- Deployers and verifiers can read the ARC-32 specs, TEAL, and Puya source maps
  directly by path.
- Applications are decoded from the ARC-56 spec at the version this package
  ships.

## Versioning

The package version matches the `contracts-v<version>` GitHub release and the
contract interface used by the matching SDK release. Protocol-breaking changes
bump the major version once the interface is stable.

## Links

- [Repository](https://github.com/kasakame/kasakame)
- [Contracts documentation](https://github.com/kasakame/kasakame/blob/main/docs/campaign.md)
- [Limits and sizes](https://github.com/kasakame/kasakame/blob/main/docs/limits.md)
- [Issues](https://github.com/kasakame/kasakame/issues)

## License

MIT
