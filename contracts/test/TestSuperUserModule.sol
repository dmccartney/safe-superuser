// SPDX-License-Identifier: MIT
pragma solidity >=0.8.1 <0.9.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../SuperUserModule.sol";

/// @title a test super-user module owned by the deployer.
/// @author Daniel McCartney <dmccartney@gmail.com>
contract TestSuperUserModule is SuperUserModule, Ownable {
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
