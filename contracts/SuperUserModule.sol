// SPDX-License-Identifier: MIT
pragma solidity >=0.8.1 <0.9.0;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/// @title a safe module allowing super-users to execute transactions
/// @author Daniel McCartney <dmccartney@gmail.com>
///
/// @dev Implementations should call _setSafe, _addSuperUser, and _removeSuperUser
/// @dev to configure the super-users on the corresponding safe.
///
/// The super-user can call `execTransactionAsSuperUser()` to execute a transaction.
///
/// Warning: These super-users are not protected by the safe's threshold.
///          They can execute transactions without further confirmations.
///          This includes the ability to remove all other owners and super-users.
///
/// Review Support
/// ------------------
///
/// This module also supports an optional transaction `reviewer` to reduce the
/// exposure if a super-user's wallet is compromised.
///
/// @dev Implementations should call _setReviewer to configure the `reviewer`.
///
/// With no `reviewer` (default) a super-user can execute any transaction.
/// But if a `reviewer` is configured, then a super-user can only execute
/// transactions if it has been signed-off by the `reviewer`. And this
/// review signature must be provided to `execTransactionAsSuperUserWithReview()`.
///
/// The idea here is to allow a second system (e.g. the backend to a website
/// that presents a UI for crafting super-user transactions) to act as the `reviewer`.
/// That system can implement rules (like limiting access or transaction types) to
/// prevent a compromised super-user wallet from executing arbitrary transactions.
abstract contract SuperUserModule is ReentrancyGuard {
    using ECDSA for bytes32;
    using EnumerableSet for EnumerableSet.AddressSet;
    using SignatureChecker for address;

    /// Emitted when a super-user is added.
    event AddedSuperUser(address superUser);

    /// Emitted when a super-user is removed.
    event RemovedSuperUser(address superUser);

    /// Emitted when the safe is changed.
    event ChangedSafe(address safe);

    /// Emitted when the reviewer is changed.
    event ChangedReviewer(address reviewer);

    /// Emitted when a super-user executes a transaction.
    event SuperUserExecuted(address superUser);

    // The set of super-users.
    EnumerableSet.AddressSet private _superUsers;

    /// The address of the reviewer that can approve transactions.
    /// @dev If this is address(0) then no review is required.
    address public reviewer;

    /// The address of the safe that super-users can control.
    address payable public safe;

    /// The number of super-user executed transactions
    /// @dev This protects against replay of review signatures.
    uint256 public superUserNonce;

    /// @return true if the `superUser` is a super-user.
    function isSuperUser(address superUser) external view returns (bool) {
        return _superUsers.contains(superUser);
    }

    /// @return the list of super-users.
    function listSuperUsers() external view returns (address[] memory) {
        return _superUsers.values();
    }

    /// @return whether the safe has been configured to enable these super-users.
    function isSafeConfigured() public view returns (bool) {
        return
            safe != address(0) &&
            IGnosisSafe(safe).isModuleEnabled(address(this));
    }

    /// This should be called by a super-user to execute a transaction without further confirmations.
    ///
    /// Note: this method assumes there is no review required.
    function execTransactionAsSuperUser(
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation
    ) external nonReentrant returns (bool success) {
        return _execTransaction(to, value, data, operation, "");
    }

    /// This should be called by a super-user to execute a transaction without further confirmations.
    ///
    /// The included reviewer signed hash is used to verify that the reviewer has approved the transaction.
    ///
    /// @param reviewSignature the reviewer's signature approving the transaction.
    /// @dev The reviewer signs a hashed `message` that can be created in solidity like this:
    /// @dev   message = keccak256(abi.encodePacked(to, value, data, operation, superUserNonce));
    /// @dev Or it can be created in javascript like this:
    /// @dev   message = ethers.utils.solidityKeccak256(
    /// @dev                  ["address", "uint256", "bytes", "uint8", "uint256"],
    /// @dev                  [to, value, data, operation, superUserNonce]);
    function execTransactionAsSuperUserWithReview(
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation,
        bytes memory reviewSignature
    ) external nonReentrant returns (bool) {
        return _execTransaction(to, value, data, operation, reviewSignature);
    }

    /// Executes a transaction as a super-user.
    /// This reverts if the transaction fails.
    function _execTransaction(
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation,
        bytes memory reviewSignature
    ) private returns (bool success) {
        require(_superUsers.contains(msg.sender), "not a super-user");
        require(isSafeConfigured(), "safe not configured");
        require(
            reviewer == address(0) ||
                _wasReviewed(to, value, data, operation, reviewSignature),
            "failed review"
        );
        superUserNonce += 1;
        success = IGnosisSafe(safe).execTransactionFromModule(
            to,
            value,
            data,
            operation
        );
        require(success, "transaction failed");
        emit SuperUserExecuted(msg.sender);
    }

    /// @return whether the transaction was properly signed-off by the reviewer
    /// @dev This supports use of a smart-contract as `reviewer` via ERC1271
    function _wasReviewed(
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation,
        bytes memory reviewSignature
    ) private view returns (bool) {
        /// @dev This is equivalent to the following in JS using ethers:
        /// @dev   let message = ethers.utils.solidityKeccak256(
        /// @dev     ["address", "uint256", "bytes", "uint8", "uint256"],
        /// @dev     [to, value, data, operation, superUserNonce]
        /// @dev   );
        /// @dev   let hash = ethers.utils.hashMessage(ethers.utils.arrayify(message));
        bytes32 message = keccak256(
            abi.encodePacked(to, value, data, operation, superUserNonce)
        );
        bytes32 hash = message.toEthSignedMessageHash();

        /// This falls back to ERC1271 if the reviewer is a smart-contract.
        return reviewer.isValidSignatureNow(hash, reviewSignature);
    }

    /// @dev This should be called to set the safe that super-users can control.
    function _setSafe(address payable safe_) internal {
        require(safe != safe_, "safe already set to this address");
        safe = safe_;
        emit ChangedSafe(safe_);
    }

    /// @dev This should be called to add a super-user.
    function _addSuperUser(address superUser) internal {
        require(!_superUsers.contains(superUser), "super-user already added");
        _superUsers.add(superUser);
        emit AddedSuperUser(superUser);
    }

    /// @dev This should be called to remove a super-user.
    function _removeSuperUser(address superUser) internal {
        require(_superUsers.contains(superUser), "super-user not found");
        _superUsers.remove(superUser);
        emit RemovedSuperUser(superUser);
    }

    /// @dev This should be called to set the reviewer of super-user transactions.
    /// @dev If set to address(0), then no review is required.
    /// @dev If set to a smart contract, the signatures will be verified via ERC1271
    function _setReviewer(address reviewer_) internal {
        require(reviewer != reviewer_, "reviewer already set to this address");
        reviewer = reviewer_;
        emit ChangedReviewer(reviewer);
    }
}

/// @title A trimmed-down version of the GnosisSafe interface.
/// @dev We define this to avoid importing the entire GnosisSafe contract.
/// @dev It contains only the methods that are needed by SafeSuperUsers.
interface IGnosisSafe {
    /// @dev See safe-contracts/.../ModuleManager.sol
    function isModuleEnabled(address module) external view returns (bool);

    /// @dev See safe-contracts/.../ModuleManager.sol
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation
    ) external returns (bool success);
}

/// @dev See safe-contracts/.../common/Enum.sol
contract Enum {
    enum Operation {
        Call,
        DelegateCall
    }
}
