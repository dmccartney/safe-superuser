# safe-superuser

[![NPM version](https://img.shields.io/npm/v/safe-superuser.svg?style=flat-square)](https://www.npmjs.com/package/safe-superuser)
![Test](https://github.com/dmccartney/safe-superuser/actions/workflows/test.yml/badge.svg)

The `SuperUserModule` is a Gnosis Safe add-on that enables trusted super-users to execute
transactions without additional confirmations, streamlining the process.

The module also supports an optional `reviewer` for enhanced security, reducing
exposure in case a super-user's wallet gets compromised.

> **Warning**
> As with any Safe module, using this exposes your Safe to any bugs in this module.
>
> This module has been carefully tested and is being used on mainnet. But it has not been formally audited.
>
> Use at your own risk.

## Usage

This is an abstract implementation that must be extended and deployed for you to use.

### Install the dependency

To install the dependency in your project, run:

```js
npm install safe-superuser
```

### Implement the `SuperUserModule`

Extend the `SuperUserModule` to implement your module with your own logic for adding and removing super-users:

```solidity
/// A simple mutable implementation of the SuperUserModule.
contract MutableSuperUserModule is SuperUserModule, Ownable {
  function setSafe(address payable safe) external onlyOwner {
    _setSafe(safe);
  }

  function setReviewer(address reviewer) external onlyOwner {
    _setReviewer(reviewer);
  }

  function addSuperUser(address superUser) external onlyOwner {
    _addSuperUser(superUser);
  }

  function removeSuperUser(address superUser) external onlyOwner {
    _removeSuperUser(superUser);
  }
}
```

```solidity
/// A simple immutable implementation of the SuperUserModule.
contract ImmutableSuperUserModule is SuperUserModule {
  constructor(address payable safe, address reviewer, address[] superUsers) {
    _setSafe(safe);
    _setReviewer(reviewer);
    for (uint256 i = 0; i < superUsers.length; i++) {
      _addSuperUser(superUsers[i]);
    }
  }
}
```

### Deploy and enable the module in your Safe.

After creating your module, you need to deploy it and enable it in your Safe. Follow these steps:

1. Deploy your module to the blockchain and note its `address`.
2. Call `enableModule(address)` on your Safe with the obtained `address`.

### Execute transactions as a super-user

Super-users can now execute transactions using the module:

```solidity
function execTransactionAsSuperUser(
  address to,
  uint256 value,
  bytes memory data,
  Enum.Operation operation
) external returns (bool success);
```

### Enable a reviewer

To enable a reviewer, call `_setReviewer(address)` on the `SuperUserModule` with the reviewer's `address`:

```solidity
function _setReviewer(address reviewer_) internal;
```

No review is required if the `reviewer` is set to `address(0)`.

If set to a non-zero address, super-users must include a `reviewSignature` when executing a transaction:

```solidity
function execTransactionAsSuperUserWithReview(
  address to,
  uint256 value,
  bytes memory data,
  Enum.Operation operation,
  bytes memory reviewSignature
) external returns (bool success);
```

#### Review as an EOA reviewer

If the `reviewer` is an EOA (normal external account with a public/private key)
then the `reviewSignature` must be a valid ECDSA signature:

```js
// Using the `ethers` library to construct a `reviewSignature`
// for a super-user transaction using `module`:
let superUserNonce = await module.superUserNonce();
let message = ethers.utils.solidityKeccak256(
  ["address", "uint256", "bytes", "uint8", "uint256"],
  [to, value, data, operation, superUserNonce]
);
let reviewSignature = await reviewer.signMessage(
  ethers.utils.arrayify(message)
);
```

#### Review as an [ERC1271](https://eips.ethereum.org/EIPS/eip-1271) smart contract

For an [ERC1271](https://eips.ethereum.org/EIPS/eip-1271) smart contract `reviewer`,
the contents of the `reviewSignature` depends on how the contract implements `isValidSignature(bytes32,bytes)`.
For an example see the simple ERC1271 contract in [contracts/test/TestReviewer.sol].

> **Note**
> For more details, including recipes for transactions and review signatures,
> see the test scenarios in `test/SuperUserModule.test.js`.

### Development

```shell
npm install
npm run pretty
npm test
```
