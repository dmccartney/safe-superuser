const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { SafeFactory } = require("@safe-global/safe-core-sdk");
const { default: EthersAdapter } = require("@safe-global/safe-ethers-lib");
const { AddressZero } = ethers.constants;

// Corresponds to Enum.Operation in safe-contracts/contracts/common/Enum.sol
const EnumOperation = {
  Call: 0,
  DelegateCall: 1,
};

/// This tests the SuperUserModule.sol contract.
/// It deploys a full Gnosis Safe and enables the TestSuperUserModule.
/// Then it exercises all of the module admin methods (adding/remove super-users, etc).
/// Then it separately tests:
///  - unreviewed execution (`execTransactionAsSuperUser`)
///  - EOA-reviewed execution  (`execTransactionAsSuperUserWithReview`)
///  - ERC1271-reviewed execution (`execTransactionAsSuperUserWithReview`)
describe("SuperUserModule", () => {
  async function makeFixtures() {
    const [owner, userA, userB, reviewer] = await ethers.getSigners();
    let { safe } = await deployGnosisSafe({ withSingleOwner: owner });
    let module = await deploySuperUserModule();
    return { safe, module, owner, userA, userB, reviewer };
  }

  async function makeFixturesSafeConfigured() {
    let fixtures = await makeFixtures();
    let { safe, module } = fixtures;
    let moduleAddress = module.address;
    await module.setSafe(safe.getAddress());
    // safe.getEthAdapter().getSafeContract({})
    await safe.executeTransaction(
      await safe.createEnableModuleTx(moduleAddress)
    );
    return fixtures;
  }

  it("initial deploy state", async () => {
    const { module, owner } = await loadFixture(makeFixtures);
    expect(await module.owner()).to.equal(owner.address);
    expect(await module.safe()).to.equal(AddressZero);
    expect(await module.reviewer()).to.equal(AddressZero);
  });

  it("configure safe", async () => {
    const { safe, module } = await loadFixture(makeFixtures);
    let moduleAddress = module.address;

    expect(await module.safe()).to.equal(AddressZero);
    await module.setSafe(safe.getAddress());
    expect(await module.safe()).to.equal(safe.getAddress());

    // But it still hasn't been enabled on the safe yet.
    expect(await module.isSafeConfigured()).to.equal(false);

    await safe.executeTransaction(
      await safe.createEnableModuleTx(moduleAddress)
    );
    expect(await module.isSafeConfigured()).to.equal(true);
  });

  it("adding/removing super-users", async () => {
    const { module, userA, userB } = await loadFixture(makeFixtures);
    await expectSuperUsers(module, {
      [userA.address]: false,
      [userB.address]: false,
    });

    await module.addSuperUser(userA.address);
    await expectSuperUsers(module, {
      [userA.address]: true,
      [userB.address]: false,
    });

    await module.removeSuperUser(userA.address);
    await expectSuperUsers(module, {
      [userA.address]: false,
      [userB.address]: false,
    });

    await module.addSuperUser(userA.address);
    await module.addSuperUser(userB.address);
    await expectSuperUsers(module, {
      [userA.address]: true,
      [userB.address]: true,
    });
  });

  it("super-user adding themselves as an owner to the safe", async () => {
    const { safe, module, userA } = await loadFixture(
      makeFixturesSafeConfigured
    );

    // We'll pretend user A was added as a super-user.
    // And the first thing they do is add themselves as an owner on the safe.

    // At first, they're not an owner on the safe.
    expect(await safe.getOwners()).to.not.contain(userA.address);

    // This is the transaction that would add user A as an owner to the safe.
    let addingOwner = await safe.createAddOwnerTx({
      ownerAddress: userA.address,
      threshold: 1,
    });

    await expect(
      module.connect(userA).execTransactionAsSuperUser(
        // This should fail because user A isn't a super-user yet.
        addingOwner.data.to,
        addingOwner.data.value,
        addingOwner.data.data,
        addingOwner.data.operation
      )
    ).to.be.reverted;

    await expect(module.addSuperUser(userA.address))
      // The user is added as a super-user.
      .to.emit(module, "AddedSuperUser");

    await expect(
      module.connect(userA).execTransactionAsSuperUser(
        // This should succeed now because user A is a super-user.
        addingOwner.data.to,
        addingOwner.data.value,
        addingOwner.data.data,
        addingOwner.data.operation
      )
    )
      .to.emit(module, "SuperUserExecuted")
      .and.to.emit(
        safe.getContractManager().safeContract.contract,
        "AddedOwner"
      );

    // And we see that user A shows up as an owner on the safe.
    expect(await safe.getOwners()).to.contain(userA.address);
  });

  it("super-user sending eth to/from the safe", async () => {
    const { safe, module, userA } = await loadFixture(
      makeFixturesSafeConfigured
    );

    // First we'll send 5 ETH to the safe.
    await userA.sendTransaction({
      to: safe.getAddress(),
      value: ethers.utils.parseEther("5"),
    });
    expect(await ethers.provider.getBalance(safe.getAddress())).to.equal(
      ethers.utils.parseEther("5")
    );

    await module.addSuperUser(userA.address);

    // And now that user A is a super-user they can send back some of the safe's ETH.
    await module.connect(userA).execTransactionAsSuperUser(
      userA.address, // to
      ethers.utils.parseEther("2.5"), // value
      [], // data
      EnumOperation.Call
    );
    expect(await ethers.provider.getBalance(safe.getAddress())).to.equal(
      ethers.utils.parseEther("2.5")
    );
  });

  it("super-user sending eth to/from the safe with EOA review", async () => {
    const { safe, module, userA, reviewer } = await loadFixture(
      makeFixturesSafeConfigured
    );
    await module.setReviewer(reviewer.address);
    await module.addSuperUser(userA.address);

    // First we'll send 5 ETH to the safe.
    await userA.sendTransaction({
      to: safe.getAddress(),
      value: ethers.utils.parseEther("5"),
    });

    // Prep a transaction from the safe to send 2.5 ETH back to user A.
    let to = userA.address;
    let value = ethers.utils.parseEther("2.5");
    let data = [];
    let operation = EnumOperation.Call;

    // User A is a super-user but they haven't had this reviewed yet.
    // So the execTransactionAsSuperUser should fail.
    await expect(
      module
        .connect(userA)
        .execTransactionAsSuperUser(to, value, data, operation)
    ).to.be.reverted;

    // Now we'll have the EOA reviewer review the transaction.
    let superUserNonce = await module.superUserNonce();
    let message = ethers.utils.solidityKeccak256(
      ["address", "uint256", "bytes", "uint8", "uint256"],
      [to, value, data, operation, superUserNonce]
    );
    let reviewSignature = await reviewer.signMessage(
      ethers.utils.arrayify(message)
    );

    // So now user A can execute the transaction with the reviewer's signature.
    await expect(
      module
        .connect(userA)
        .execTransactionAsSuperUserWithReview(
          to,
          value,
          data,
          operation,
          reviewSignature
        )
    ).to.emit(module, "SuperUserExecuted");

    expect(await ethers.provider.getBalance(safe.getAddress())).to.equal(
      ethers.utils.parseEther("2.5")
    );
  });

  it("super-user sending eth to/from the safe with ERC1271 contract review", async () => {
    const { safe, module, userA, userB } = await loadFixture(
      makeFixturesSafeConfigured
    );
    await module.addSuperUser(userA.address);

    // We use an ERC1271 contract to act as the reviewer.
    let reviewerK = await deployReviewer();
    await module.setReviewer(reviewerK.address);

    // First we'll send 5 ETH to the safe.
    await userA.sendTransaction({
      to: safe.getAddress(),
      value: ethers.utils.parseEther("5"),
    });

    // Prep a transaction from the safe to send 2.5 ETH back to user A.
    let to = userA.address;
    let value = ethers.utils.parseEther("2.5");
    let data = [];
    let operation = EnumOperation.Call;

    // User A is a super-user but they haven't had this reviewed yet.
    // So the execTransactionAsSuperUser should fail.
    await expect(
      module
        .connect(userA)
        .execTransactionAsSuperUser(to, value, data, operation)
    ).to.be.reverted;

    // Now we'll have the ERC1271 reviewer review the transaction.
    let superUserNonce = await module.superUserNonce();
    let message = ethers.utils.solidityKeccak256(
      ["address", "uint256", "bytes", "uint8", "uint256"],
      [to, value, data, operation, superUserNonce]
    );
    let hash = ethers.utils.hashMessage(ethers.utils.arrayify(message));
    let reviewSignature = ethers.utils.hashMessage("LGTM");
    await reviewerK.saveSignature(hash, reviewSignature);

    // So now user A can execute the transaction with the reviewer's signature.
    await expect(
      module
        .connect(userA)
        .execTransactionAsSuperUserWithReview(
          to,
          value,
          data,
          operation,
          reviewSignature
        )
    ).to.emit(module, "SuperUserExecuted");

    expect(await ethers.provider.getBalance(safe.getAddress())).to.equal(
      ethers.utils.parseEther("2.5")
    );
  });

  // Helpers

  async function deploySuperUserModule() {
    let SuperUserModule = await ethers.getContractFactory(
      "TestSuperUserModule"
    );
    return SuperUserModule.deploy();
  }

  async function deployReviewer() {
    let Reviewer = await ethers.getContractFactory("TestReviewer");
    return Reviewer.deploy();
  }

  async function deployGnosisSafe({ withSingleOwner: owner }) {
    let GnosisSafe = await ethers.getContractFactory("GnosisSafe");
    let GnosisSafeProxyFactory = await ethers.getContractFactory(
      "GnosisSafeProxyFactory"
    );
    let MultiSend = await ethers.getContractFactory("MultiSend");
    let MultiSendCallOnly = await ethers.getContractFactory(
      "MultiSendCallOnly"
    );
    let singleton = await GnosisSafe.deploy();
    let proxyFactory = await GnosisSafeProxyFactory.deploy();
    let multiSend = await MultiSend.deploy();
    let multiSendCallOnly = await MultiSendCallOnly.deploy();

    const ethAdapter = new EthersAdapter({ ethers, signerOrProvider: owner });
    let chainId = await ethAdapter.getChainId();
    let factory = await SafeFactory.create({
      ethAdapter,
      contractNetworks: {
        [`${chainId}`]: {
          masterCopyAddress: singleton.address,
          proxyFactoryAddress: proxyFactory.address,
          safeMasterCopyAddress: singleton.address,
          safeProxyFactoryAddress: proxyFactory.address,
          multiSendAddress: multiSend.address,
          multiSendCallOnlyAddress: multiSendCallOnly.address,
          fallbackHandlerAddress: AddressZero,
          signMessageLibAddress: AddressZero,
          createCallAddress: AddressZero,
        },
      },
    });
    let safe = await factory.deploySafe({
      safeAccountConfig: {
        owners: [owner.address],
        threshold: 1,
        fallbackHandler: AddressZero,
      },
    });
    return { safe };
  }

  async function expectSuperUsers(module, expected) {
    for (let [address, isExpectedSuperUser] of Object.entries(expected)) {
      expect(await module.isSuperUser(address)).to.equal(isExpectedSuperUser);
    }
    expect(await module.listSuperUsers()).to.contain.members(
      Object.entries(expected)
        .filter(([_, isExpectedSuperUser]) => isExpectedSuperUser)
        .map(([address, _]) => address)
    );
  }
});
