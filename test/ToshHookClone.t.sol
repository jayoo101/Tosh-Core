// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {ToshCloneLib} from "../src/libraries/ToshCloneLib.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {ToshToken} from "../src/ToshToken.sol";
import {HookMiner} from "../src/libraries/HookMiner.sol";

/// @dev Stands in for the refactored `ToshLaunchpadHook`: reads its per-project
///      config through the same library readers the real hook will use, so these
///      tests pin the production read path rather than a parallel copy of it.
contract MockCloneImpl {
    error OnlyClone();

    /// @dev Captured at construction, so it is baked into the implementation's
    ///      code and stays correct under delegatecall (where `address(this)`
    ///      becomes the clone). This is the pattern the real hook adopts.
    address private immutable _self;

    uint256 public counter;
    address public lastCaller;

    constructor() {
        _self = address(this);
    }

    modifier onlyClone() {
        if (address(this) == _self) revert OnlyClone();
        _;
    }

    function guardedSoftCap() external view onlyClone returns (uint256) {
        return ToshCloneLib.argSoftCap();
    }

    function creator() external view returns (address) {
        return ToshCloneLib.argCreator();
    }

    function projectTreasury() external view returns (address) {
        return ToshCloneLib.argProjectTreasury();
    }

    function softCap() external view returns (uint256) {
        return ToshCloneLib.argSoftCap();
    }

    function perWalletCap() external view returns (uint256) {
        return ToshCloneLib.argPerWalletCap();
    }

    function genesisDuration() external view returns (uint256) {
        return ToshCloneLib.argGenesisDuration();
    }

    function bump() external {
        ++counter;
    }

    /// @dev Proves the delegatecall preserves the original `msg.sender` rather
    ///      than reporting the proxy.
    function recordCaller() external {
        lastCaller = msg.sender;
    }

    function selfAddress() external view returns (address) {
        return address(this);
    }

    receive() external payable {}
}

/// @dev Minimal deployer so CREATE2 happens from a contract, matching the
///      factory's context.
contract CloneDeployer {
    function deploy(
        bytes32 salt,
        address impl,
        address creator,
        address projectTreasury,
        uint256 softCap,
        uint256 perWalletCap,
        uint256 genesisDuration
    ) external returns (address) {
        return ToshCloneLib.deployHook(salt, impl, creator, projectTreasury, softCap, perWalletCap, genesisDuration);
    }

    function deployMeasured(
        bytes32 salt,
        address impl,
        address creator,
        address projectTreasury,
        uint256 softCap,
        uint256 perWalletCap,
        uint256 genesisDuration
    ) external returns (address addr, uint256 gasUsed) {
        uint256 before = gasleft();
        addr = ToshCloneLib.deployHook(salt, impl, creator, projectTreasury, softCap, perWalletCap, genesisDuration);
        gasUsed = before - gasleft();
    }

    /// @dev The token needs no immutable args at all — `factory` is
    ///      platform-global and stays an immutable on the implementation, and
    ///      `name`/`symbol` are strings that could never have been packed into
    ///      bytecode, so they live in storage. Its clone is therefore the
    ///      canonical 45-byte EIP-1167 proxy with nothing appended.
    function deployBareCloneMeasured(address impl) external returns (address deployed, uint256 gasUsed) {
        uint256 before = gasleft();
        deployed = ToshCloneLib.deployBareClone(impl);
        gasUsed = before - gasleft();
    }

    /// @dev The status quo for the token: a full copy per launch.
    function deployFullTokenMeasured() external returns (address deployed, uint256 gasUsed) {
        uint256 before = gasleft();
        deployed = address(new ToshToken(address(this)));
        gasUsed = before - gasleft();
    }

    /// @dev The status quo for the hook: CREATE2 a full ~19.6 KB copy.
    ///
    ///      The nine words appended here are what the per-project constructor
    ///      tuple used to be. The constructor now takes four, and the extra
    ///      words are simply ignored — which is fine, because the only thing
    ///      being measured is the cost of depositing that much code.
    ///
    ///      Every argument must nonetheless be non-zero: the constructor rejects
    ///      a zero `poolManager`, `factory`, `ladderTreasury`, or
    ///      `platformFeeRecipient`, and a reverted CREATE2 yields `address(0)`
    ///      and a gas figure that measures nothing.
    function deployFullHookMeasured(
        bytes32 salt,
        address poolManager,
        address vault,
        address ladderTreasury,
        address platformFeeRecipient
    ) external returns (address deployed, uint256 gasUsed) {
        // Five constructor arguments, not four. `vault` was added by the
        // PancakeSwap Infinity port, and a mismatch here does not fail loudly:
        // the constructor's zero-address `require` reverts, CREATE2 returns
        // address(0), and only the caller's own assertion notices.
        bytes memory initcode = abi.encodePacked(
            type(ToshLaunchpadHook).creationCode,
            abi.encode(poolManager, vault, address(this), ladderTreasury, platformFeeRecipient)
        );
        uint256 before = gasleft();
        assembly {
            deployed := create2(0, add(initcode, 0x20), mload(initcode), salt)
        }
        gasUsed = before - gasleft();
    }
}

contract ToshHookCloneTest is Test {
    MockCloneImpl impl;
    CloneDeployer deployer;

    address constant CREATOR = address(0xC0FFEE);
    address constant TREASURY = address(0xBEEF);
    uint256 constant SOFT_CAP = 5 ether;
    uint256 constant WALLET_CAP = 2 ether;
    uint256 constant DURATION = 24 hours;

    function setUp() public {
        impl = new MockCloneImpl();
        deployer = new CloneDeployer();
    }

    function _deploy(bytes32 salt) internal returns (MockCloneImpl) {
        return
            MockCloneImpl(
                payable(deployer.deploy(salt, address(impl), CREATOR, TREASURY, SOFT_CAP, WALLET_CAP, DURATION))
            );
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Bytecode shape
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev The creation stub hard-codes the runtime length as a single PUSH1
    ///      byte (`0x79`). If the arg layout ever grows, this is the test that
    ///      catches the stub going stale.
    function test_initcodeAndRuntimeSizesAreExact() public {
        bytes memory initcode =
            ToshCloneLib.cloneInitcode(address(impl), CREATOR, TREASURY, SOFT_CAP, WALLET_CAP, DURATION);

        assertEq(initcode.length, 131, "initcode length");
        assertEq(ToshCloneLib.RUNTIME_LEN, 121, "runtime constant");
        assertEq(uint8(initcode[2]), 0x79, "PUSH1 operand must equal RUNTIME_LEN");

        address clone = address(_deploy(bytes32(uint256(1))));
        assertEq(clone.code.length, ToshCloneLib.RUNTIME_LEN, "deployed runtime length");
    }

    /// @dev Guards the byte the whole proxy hinges on: the JUMPI destination at
    ///      runtime index 43 must be a JUMPDEST, or every successful call
    ///      reverts.
    function test_proxyJumpDestinationIsCorrect() public {
        bytes memory code = address(_deploy(bytes32(uint256(2)))).code;
        assertEq(uint8(code[43]), 0x5b, "JUMPDEST at 43");
        assertEq(uint8(code[44]), 0xf3, "RETURN at 44");
        assertEq(uint8(code[40]), 0x2b, "JUMPI target operand is 43");
    }

    /// @dev The implementation address must appear verbatim in the clone's code;
    ///      this is what makes the clone non-upgradeable.
    function test_implementationIsBakedIntoRuntime() public {
        bytes memory code = address(_deploy(bytes32(uint256(3)))).code;
        address embedded;
        for (uint256 i; i < 20; ++i) {
            embedded = address(uint160(uint256(uint160(embedded)) << 8 | uint8(code[10 + i])));
        }
        assertEq(embedded, address(impl), "impl at runtime offset 10");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Argument round-trip
    // ══════════════════════════════════════════════════════════════════════════

    function test_argsRoundTrip() public {
        MockCloneImpl clone = _deploy(bytes32(uint256(10)));

        assertEq(clone.creator(), CREATOR, "creator");
        assertEq(clone.projectTreasury(), TREASURY, "projectTreasury");
        assertEq(clone.softCap(), SOFT_CAP, "softCap");
        assertEq(clone.perWalletCap(), WALLET_CAP, "perWalletCap");
        assertEq(clone.genesisDuration(), DURATION, "genesisDuration");
    }

    /// @dev The offsets are the one genuinely new failure mode this design adds,
    ///      and adjacent-field bleed is how an offset bug shows up. Fuzzing all
    ///      five fields together is what makes that detectable: a wrong shift or
    ///      a one-byte slip corrupts a neighbour, which fixed vectors can mask.
    function testFuzz_argsRoundTrip(
        address creator_,
        address treasury_,
        uint128 softCap_,
        uint128 walletCap_,
        uint32 duration_,
        bytes32 salt_
    ) public {
        address addr = deployer.deploy(salt_, address(impl), creator_, treasury_, softCap_, walletCap_, duration_);
        MockCloneImpl clone = MockCloneImpl(payable(addr));

        assertEq(clone.creator(), creator_, "creator");
        assertEq(clone.projectTreasury(), treasury_, "projectTreasury");
        assertEq(clone.softCap(), softCap_, "softCap");
        assertEq(clone.perWalletCap(), walletCap_, "perWalletCap");
        assertEq(clone.genesisDuration(), duration_, "genesisDuration");
    }

    /// @dev All-ones in every field at once: catches a reader whose mask is too
    ///      wide, which zero-valued neighbours would otherwise hide.
    function test_argsRoundTripAtMaxValues() public {
        address addr = deployer.deploy(
            bytes32(uint256(11)),
            address(impl),
            address(type(uint160).max),
            address(type(uint160).max),
            type(uint128).max,
            type(uint128).max,
            type(uint32).max
        );
        MockCloneImpl clone = MockCloneImpl(payable(addr));

        assertEq(clone.creator(), address(type(uint160).max));
        assertEq(clone.projectTreasury(), address(type(uint160).max));
        assertEq(clone.softCap(), type(uint128).max);
        assertEq(clone.perWalletCap(), type(uint128).max);
        assertEq(clone.genesisDuration(), type(uint32).max);
    }

    /// @dev `genesisDuration` is the last field, so its reader runs past the end
    ///      of the code and relies on EXTCODECOPY zero-padding. Pin that.
    function test_lastFieldReadRunsPastCodeEndSafely() public {
        MockCloneImpl clone = _deploy(bytes32(uint256(12)));
        assertEq(clone.genesisDuration(), DURATION);
        assertEq(ToshCloneLib.OFF_GENESIS_DURATION + 32, 149);
        assertGt(ToshCloneLib.OFF_GENESIS_DURATION + 32, ToshCloneLib.RUNTIME_LEN);
    }

    function test_capsAboveUint128Revert() public {
        vm.expectRevert(ToshCloneLib.CapTooLargeToPack.selector);
        deployer.deploy(
            bytes32(uint256(13)), address(impl), CREATOR, TREASURY, uint256(type(uint128).max) + 1, WALLET_CAP, DURATION
        );

        vm.expectRevert(ToshCloneLib.CapTooLargeToPack.selector);
        deployer.deploy(
            bytes32(uint256(14)), address(impl), CREATOR, TREASURY, SOFT_CAP, uint256(type(uint128).max) + 1, DURATION
        );
    }

    /// @dev `genesisDuration` is packed into 4 bytes, and unlike the two caps it
    ///      used to be truncated with a bare `uint32(...)` cast and no check.
    ///      The value that matters is not the deployment — the hook rejects any
    ///      duration outside its three rungs — but `initcodeHash`, which is a
    ///      public view the frontend mines salts against. Silent truncation
    ///      there means two different durations hash the same, so a salt mined
    ///      for `2**32 + 24 hours` predicts the address of a `24 hours` launch
    ///      and the caller has no way to know the value they passed was not the
    ///      value committed to. Same shape of bug as an unchecked cap, so the
    ///      same shape of revert.
    function test_genesisDurationAboveUint32Reverts() public {
        uint256 tooLong = uint256(type(uint32).max) + 1;

        vm.expectRevert(ToshCloneLib.DurationTooLargeToPack.selector);
        deployer.deploy(bytes32(uint256(15)), address(impl), CREATOR, TREASURY, SOFT_CAP, WALLET_CAP, tooLong);

        // The hash path is the one that would mislead a salt miner, so pin it
        // separately rather than trusting that it shares the guard.
        vm.expectRevert(ToshCloneLib.DurationTooLargeToPack.selector);
        this.initcodeHashExternal(SOFT_CAP, WALLET_CAP, tooLong);
    }

    /// @dev `expectRevert` needs an external call boundary to catch a revert
    ///      raised by an internal library function.
    function initcodeHashExternal(uint256 softCap, uint256 walletCap, uint256 duration)
        external
        view
        returns (bytes32)
    {
        return ToshCloneLib.initcodeHash(address(impl), CREATOR, TREASURY, softCap, walletCap, duration);
    }

    /// @dev The arg offsets land inside the implementation's own ~19 KB of
    ///      runtime code, so reading them on the bare implementation is not out
    ///      of bounds and does NOT zero-fill — it returns live bytecode
    ///      reinterpreted as a config. Nothing about that value is safe, and
    ///      crucially it is not zero, so a `require(softCap > 0)` would pass it.
    ///
    ///      This is the one new attack surface the clone design introduces: the
    ///      implementation is otherwise a complete, callable hook. The test
    ///      documents the hazard so nobody later "simplifies" the guard away.
    function test_implementationReadsGarbageNotZero() public view {
        assertTrue(impl.softCap() != 0, "impl reads its own code, not zeros");
        assertTrue(impl.softCap() != SOFT_CAP, "and certainly not a real config");
    }

    /// @dev Therefore the implementation must be unusable as itself. The guard
    ///      compares `address(this)` against the address captured at
    ///      construction: equal means nobody delegatecalled us.
    function test_implementationCannotBeUsedDirectly() public {
        vm.expectRevert(MockCloneImpl.OnlyClone.selector);
        impl.guardedSoftCap();

        MockCloneImpl clone = _deploy(bytes32(uint256(15)));
        assertEq(clone.guardedSoftCap(), SOFT_CAP, "same call through a clone works");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Isolation — the property that justified proxies over a singleton hook
    // ══════════════════════════════════════════════════════════════════════════

    function test_clonesHaveIndependentStorageAndBalances() public {
        MockCloneImpl a = _deploy(bytes32(uint256(20)));
        MockCloneImpl b = _deploy(bytes32(uint256(21)));

        assertTrue(address(a) != address(b), "distinct addresses");

        a.bump();
        a.bump();
        b.bump();

        assertEq(a.counter(), 2, "a storage");
        assertEq(b.counter(), 1, "b storage");
        assertEq(impl.counter(), 0, "impl storage untouched");

        // An uncapped `call`, not `transfer`: a clone's fallback delegatecalls,
        // which does not fit in the 2300-gas stipend.  That is asserted on its
        // own in `test_valueBearingCallReachesTheImplementation`; here it is
        // just the reason this line cannot be a `transfer`.
        vm.deal(address(this), 10 ether);
        (bool ok,) = address(a).call{value: 1 ether}("");
        assertTrue(ok, "funding the clone");

        assertEq(address(a).balance, 1 ether, "a balance");
        assertEq(address(b).balance, 0, "b balance isolated");
    }

    function test_delegatecallContextIsTheClone() public {
        MockCloneImpl clone = _deploy(bytes32(uint256(22)));
        assertEq(clone.selfAddress(), address(clone), "address(this) is the clone");

        address caller = address(0xA11CE);
        vm.prank(caller);
        clone.recordCaller();
        assertEq(clone.lastCaller(), caller, "msg.sender survives the proxy");
    }

    /// @dev Every ETH path into the hook uses `call{value:}` with no gas cap, so
    ///      the proxy's delegatecall has room to run. A bare `transfer` (2300 gas)
    ///      would not — this asserts which of the two the protocol can rely on.
    function test_valueBearingCallReachesTheImplementation() public {
        MockCloneImpl clone = _deploy(bytes32(uint256(23)));
        vm.deal(address(this), 10 ether);

        (bool ok,) = address(clone).call{value: 1 ether}("");
        assertTrue(ok, "uncapped call with value");
        assertEq(address(clone).balance, 1 ether);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Address prediction over the new initcode
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev ⚠ A TEST WAS DELETED HERE, not ported.
    ///
    ///      `test_saltMiningFindsValidHookAddressForClone` asserted that a
    ///      mined salt yields an address carrying the 0x20CC flag bits, and
    ///      that shrinking the initcode to a clone stub had not made those bits
    ///      harder to reach. Under Uniswap V4 that was a real property: the
    ///      PoolManager read a hook's permissions out of its address, so an
    ///      unminable mask would have made the clone undeployable.
    ///
    ///      PancakeSwap Infinity reads permissions from
    ///      `getHooksRegistrationBitmap()` instead, `ToshFactory` no longer
    ///      checks any address bits, and `HookMiner.find` /
    ///      `isValidHookAddress` were removed with the gate. Rewriting the test
    ///      to assert the bits anyway would pin a number nothing reads.
    ///
    ///      What survives the deletion is below, and it is the half that was
    ///      always load-bearing.
    function test_predictedSaltMatchesTheDeployedAddress() public {
        bytes32 hash = ToshCloneLib.initcodeHash(address(impl), CREATOR, TREASURY, SOFT_CAP, WALLET_CAP, DURATION);

        // Any salt will do now, which is the point — this used to be the output
        // of a 20k-iteration search.
        bytes32 salt = bytes32(uint256(42));
        address predicted = HookMiner.computeAddress(address(deployer), salt, hash);

        address actual = deployer.deploy(salt, address(impl), CREATOR, TREASURY, SOFT_CAP, WALLET_CAP, DURATION);
        assertEq(actual, predicted, "CREATE2 prediction matches deployment");
    }

    /// @dev The prediction has to stay sensitive to the initcode, or
    ///      `ToshFactory.verifyHookDeployment` would confirm hooks it never
    ///      deployed. Same salt, one differing constructor argument, different
    ///      address.
    function test_predictionTracksTheInitcode() public view {
        bytes32 salt = bytes32(uint256(42));
        bytes32 hash = ToshCloneLib.initcodeHash(address(impl), CREATOR, TREASURY, SOFT_CAP, WALLET_CAP, DURATION);
        bytes32 otherCap =
            ToshCloneLib.initcodeHash(address(impl), CREATOR, TREASURY, SOFT_CAP + 1, WALLET_CAP, DURATION);

        assertTrue(
            HookMiner.computeAddress(address(deployer), salt, hash)
                != HookMiner.computeAddress(address(deployer), salt, otherCap),
            "a different soft cap must predict a different address"
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  The measurement this whole exercise exists to produce
    // ══════════════════════════════════════════════════════════════════════════

    function test_gasCloneVersusFullHook() public {
        (, uint256 cloneGas) = deployer.deployMeasured(
            bytes32(uint256(100)), address(impl), CREATOR, TREASURY, SOFT_CAP, WALLET_CAP, DURATION
        );

        (address fullHook, uint256 fullGas) = deployer.deployFullHookMeasured(
            bytes32(uint256(101)), address(0x1111), address(0x2222), address(0x3333), address(0x4444)
        );

        assertTrue(fullHook != address(0), "the full deploy must actually have landed");

        uint256 fullRuntime = fullHook.code.length;
        uint256 cloneRuntime = ToshCloneLib.RUNTIME_LEN;

        console2.log("--- hook deployment: full CREATE2 vs EIP-1167 clone ---");
        console2.log("full  runtime bytes      ", fullRuntime);
        console2.log("full  code deposit gas   ", fullRuntime * 200);
        console2.log("full  measured gas       ", fullGas);
        console2.log("clone runtime bytes      ", cloneRuntime);
        console2.log("clone code deposit gas   ", cloneRuntime * 200);
        console2.log("clone measured gas       ", cloneGas);
        console2.log("saved gas                ", fullGas - cloneGas);
        console2.log("saved percent            ", (fullGas - cloneGas) * 100 / fullGas);

        assertLt(cloneGas, fullGas / 20, "clone must cost under 5% of a full deploy");
        assertLt(cloneRuntime, 200, "clone runtime stays tiny");
    }

    /// @notice Quantifies what the two deploys inside `createLaunch` used to cost
    ///         and what they cost now, against the 5,016,031 gas the whole call
    ///         measured before any of this.
    ///
    /// @dev    This bounds the DEPLOY COMPONENT only, and deliberately does not
    ///         claim to predict the end-to-end figure.  Some of the saving is
    ///         given back elsewhere: a clone runs no constructor, so work the
    ///         constructors used to do moved into `ToshToken.initialize` (which
    ///         now writes name and symbol to storage) and
    ///         `ToshLaunchpadHook.initializeToken` (which now writes
    ///         `projectAdmin` and `genesisDeadline` and validates the clone's
    ///         args).  Together those grew by roughly 160 k.
    ///
    ///         `test_createLaunch_gasStaysUnderBudget` in ToshV5Factory.t.sol is
    ///         the honest end-to-end number and the actual regression guard.
    function test_deployComponentOfCreateLaunch() public {
        uint256 MEASURED_CREATE_LAUNCH = 5_016_031;

        (, uint256 hookFull) = deployer.deployFullHookMeasured(
            bytes32(uint256(200)), address(0x1111), address(0x2222), address(0x3333), address(0x4444)
        );
        (, uint256 hookClone) = deployer.deployMeasured(
            bytes32(uint256(201)), address(impl), CREATOR, TREASURY, SOFT_CAP, WALLET_CAP, DURATION
        );

        (, uint256 tokenFull) = deployer.deployFullTokenMeasured();
        (, uint256 tokenClone) = deployer.deployBareCloneMeasured(address(impl));

        uint256 deploysBefore = hookFull + tokenFull;
        uint256 deploysNow = hookClone + tokenClone;

        console2.log("--- the two deploys inside createLaunch ---");
        console2.log("baseline whole call      ", MEASURED_CREATE_LAUNCH);
        console2.log("hook  full / clone       ", hookFull, hookClone);
        console2.log("token full / clone       ", tokenFull, tokenClone);
        console2.log("deploys before / after   ", deploysBefore, deploysNow);
        console2.log("saved on deploys         ", deploysBefore - deploysNow);
        console2.log("as pct of the whole call ", (deploysBefore - deploysNow) * 100 / MEASURED_CREATE_LAUNCH);

        // The deploys used to be 98 % of the call and must now be a rounding
        // error against it. If this trips, code deposit has crept back in —
        // someone added immutable args, or stopped cloning something.
        assertLt(deploysNow, MEASURED_CREATE_LAUNCH / 25, "deploys must be under 4% of the old whole call");
        assertGt(deploysBefore, MEASURED_CREATE_LAUNCH * 9 / 10, "sanity: they really were the whole cost");
    }
}
