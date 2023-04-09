// SPDX-License-Identifier: MIT
pragma solidity >=0.8.1 <0.9.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @title a simple reviewer contract for verifying ERC1271 support.
/// @author Daniel McCartney <dmccartney@gmail.com>
contract TestReviewer is IERC1271, Ownable {
    mapping(bytes32 => bytes32) public signaturesByHash;

    // bytes4(IERC1271.isValidSignature.selector)
    bytes4 internal constant MAGIC_TRUE = 0x1626ba7e;
    bytes4 internal constant MAGIC_FALSE = 0;

    function saveSignature(bytes32 hash, bytes32 signature) external onlyOwner {
        require(signature != bytes32(0), "invalid signature");
        signaturesByHash[hash] = signature;
    }

    /// @dev See {IERC1271-isValidSignature}.
    function isValidSignature(
        bytes32 hash,
        bytes memory signature
    ) public view override returns (bytes4 magicValue) {
        require(bytes32(signature) != bytes32(0), "invalid signature");
        if (signaturesByHash[hash] == bytes32(signature)) {
            return MAGIC_TRUE;
        }
        return MAGIC_FALSE;
    }
}
