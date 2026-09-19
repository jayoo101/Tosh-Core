// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "forge-std/console2.sol";

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";
// Imported rather than restated, unlike `test/ToshV5ForkInfinity.t.sol`, which
// keeps its own copy so the guard has a handwritten tuple to diff against
// upstream. A rehearsal wants the opposite: if PancakeSwap reshapes the params,
// this script should break at compile time rather than encode a stale layout.
import {ICLRouterBase} from "infinity-periphery/src/pool-cl/interfaces/ICLRouterBase.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {ToshLadderTreasury} from "../src/ToshLadderTreasury.sol";
import {ToshToken} from "../src/ToshToken.sol";
import {HookAddress} from "../src/libraries/HookAddress.sol";

/// @dev Minimal view of the deployed UniversalRouter, declared here for the same
///      reason `ToshV5Fork.t.sol` declares it: `lib/` carries v4-core and
///      v4-periphery but not universal-router, and `execute` is the whole
///      surface a swap needs.
interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

// ---------------------------------------------------------------------------
// RH-F1 / RH-F2 — the rehearsal on BSC testnet (97)
// ---------------------------------------------------------------------------
// TESTNET ONLY. Rewrites the factory's economic parameters, which is acceptable
// only because Deploy.s.sol deliberately leaves it EOA-owned on 97.
//
// ── What moving off Robinhood Chain deleted from this script ───────────────
//
// A `SimArbSys` mock and an `_installArbSys()` that `vm.etch`-ed it over 0x64
// before every run. Robinhood is an Arbitrum Orbit chain, `block.number` there
// reports an L1 height, and the hook's same-block lockout has to stamp the L2
// one — so it called the ArbSys precompile. Foundry's simulation had no such
// precompile and aborted with `InvalidFEOpcode`, hence the mock.
//
// BSC has no ArbSys and no L1/L2 split: `block.number` IS the height, the hook
// constructor finds nothing at 0x64, sets `_hasArbSys` false, and
// `_blockNumber()` returns `block.number` directly. The mock and the etch go
// with it.
//
// RH-F2 stays, inverted. It used to prove the ArbSys path was live; it now
// proves the fallback is, which is the assertion that matters on this chain.
//
// ── Why this is two phases and not one ─────────────────────────────────────
//
// `launch()` requires `block.timestamp >= genesisDeadline`, and the genesis
// window is one of three rungs the hook enforces — 3 h, 24 h, 72 h. There is no
// `vm.warp` against a real chain, so the shortest honest rehearsal is a 3 h wait
// with a transaction on each side of it. Phase 1 opens the window, phase 2 runs
// everything after it closes.
//
// ── Why the parameters are scaled, and what that costs ─────────────────────
//
// Stock defaults are `defaultSoftCap` 10 ETH against a `maxPogAllocationLimit`
// of 0.5 ETH per wallet. Those multiply: reaching the cap at production values
// needs twenty separately funded, separately PoG-attested wallets. The
// per-wallet cap is a fairness property working as designed; it just makes
// genesis the one phase no faucet can underwrite.
//
// It also no longer has to be reached. The soft cap is a progress target, not a
// launch gate, so the rehearsal scales to a 0.05 ETH cap and deposits 0.01 ETH
// against it — one wallet, one fifth, and a launch that the pre-change contract
// would have refused with `SoftCapNotMet`. The raise itself stays at
// `MIN_SOFT_CAP_PROD`, the floor below which `p0` truncates toward zero.
//
// Be clear about what that forfeits: this rehearsal does NOT exercise the
// arithmetic at production magnitudes. Anything that only breaks at 10 ETH — an
// overflow, a rounding step that vanishes at small numbers — is out of scope
// here and stays covered by the local suites, which do run the real defaults.
// RH-F1 answers "does the sequence work against the real chain", not "does it
// work at the real size".
//
// ── Running it ──────────────────────────────────────────────────────────────
//
//   forge script script/RehearseTestnet.s.sol:Phase1Genesis \
//     --rpc-url $BSC_TESTNET_RPC --broadcast --slow -vv
//
//   ...wait out the 3 h genesis window, then...
//
//   forge script script/RehearseTestnet.s.sol:Phase2Launch \
//     --rpc-url $BSC_TESTNET_RPC --broadcast --slow -vv
//
//   ...wait out TWAP_WINDOW (30 min) so the ladder's listing gate opens, then...
//
//   forge script script/RehearseTestnet.s.sol:Phase2bList   ...
//   forge script script/RehearseTestnet.s.sol:Phase3Buy     ...
//   forge script script/RehearseTestnet.s.sol:Phase4Ladder  ...
//
// Phases 2-4 read HOOK_ADDRESS from .env; phase 1 prints the line to paste.
//
// ── Why four scripts and not one ────────────────────────────────────────────
//
// Beyond the 3 h gap, there is a second reason the tail cannot be one run:
// `forge script` simulates the whole body against a single block before it
// broadcasts anything. The same-block lockout means a mint simulated in the
// same block as the swap that precedes it reverts, and the run dies before a
// single transaction is sent. Launch, swap and mint therefore need to be three
// separate invocations — which is also the only way to observe the lockout
// arming and releasing across real blocks, so it costs nothing.
// ---------------------------------------------------------------------------

/// @dev Shared fixture. Deliberately thin: the point of a rehearsal is to drive
///      the deployed contracts, not to build a second harness around them.
/// @dev The one Permit2 entry point this script needs. Declared locally rather
///      than imported because the repo has no Permit2 dependency and adding one
///      for a four-argument setter would pull in a library for a signature.
interface IPermit2Approve {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

abstract contract RehearsalBase is Script {
    using MessageHashUtils for bytes32;

    /// Genesis window. The hook allows 3 h / 24 h / 72 h and nothing else, so
    /// this is the shortest rehearsal the contracts permit.
    uint256 internal constant GENESIS_WINDOW = 3 hours;

    /// Deliberately five times the raise below, so the rehearsal launches with
    /// the soft cap UNMET. That is the whole point of it now: the cap became a
    /// progress target rather than a gate, and a rehearsal that fills it
    /// exactly — as this one did while the gate existed — exercises only the
    /// path that worked before the change.
    ///
    /// ⚠ THESE ARE QUOTE-ASSET BASE UNITS — 8 decimals, so `e8` and never
    ///   `ether`. This file has now been missed by a denomination pass twice: the
    ///   ×3.5 BNB conversion skipped it, and `REHEARSAL_RAISE` at its old 0.01
    ///   fell BELOW the factory's `MIN_SOFT_CAP_PROD`, so phase 1 reverted on its
    ///   own assertion the first time it met a real BSC factory. The assertion in
    ///   `_scaleParameters` is what caught it, and it is the reason to keep
    ///   reading these as ratios rather than as numbers.
    ///
    ///   THE SHORTFALL IS NO LONGER FREE, which is the substantive change here.
    ///   The raise had to stay at the contract floor and the cap at five times it,
    ///   because the floor is what keeps the shelf ladder monotone — and that
    ///   floor is now 100 BEM against a 4.75x margin over the flattening cliff,
    ///   not a 16.6-million-to-one margin over it. So this rehearsal costs 500 BEM
    ///   of allowance for the cap and 100 BEM actually deposited, where the BNB
    ///   version cost 0.035. Dropping the raise to make it cheaper does not widen
    ///   the shortfall, it flattens the ladder, which is the thing under test.
    uint256 internal constant REHEARSAL_SOFT_CAP = 500e8;
    uint256 internal constant REHEARSAL_WALLET_CAP = 100e8;
    uint256 internal constant REHEARSAL_LAUNCH_FEE = 10e8;

    /// What one wallet actually deposits: 20 % of the cap.
    ///
    /// Equal to `ToshFactory.MIN_SOFT_CAP_PROD`, and asserted against the
    /// contract in `_scaleParameters` rather than trusted — which is what caught
    /// the missed rescaling above. The floor binds the RAISE, not the cap: below
    /// it the ladder flattens before `p0` ever truncates. Going lower to widen
    /// the shortfall would trade the thing under test for a degenerate pool.
    uint256 internal constant REHEARSAL_RAISE = 100e8;

    /// PancakeSwap Infinity's UniversalRouter on BSC testnet (97). Table and
    /// re-check commands in docs/PANCAKESWAP_INFINITY.md §7.
    ///
    /// NOT Uniswap's, and the distinction is sharper than it looks: Infinity's
    /// swap command byte is also 0x10 and its params tuple encodes to the same
    /// length, so pointing this at a Uniswap router would send calldata that
    /// passes the length floor and decodes into a different struct. See
    /// `_buyThroughRouter`.
    address internal constant UNIVERSAL_ROUTER = 0x87FD5305E6a40F378da124864B2D479c2028BD86;

    /// Permit2, canonical on every chain and the one address the BSC migration
    /// did not have to touch. Mirrors `PERMIT2` in soat-frontend/src/lib/contracts.ts.
    /// Needed now that the swap's input leg is an ERC20 — see `_buyThroughRouter`.
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // From pancakeswap/infinity-universal-router `Commands.sol` and
    // infinity-periphery `Actions.sol`.
    //
    // Every one of these bytes happens to equal its Uniswap counterpart —
    // `V4_SWAP` is also 0x10, and the three action bytes are also 0x06 / 0x0c /
    // 0x0f. That is a coincidence, not compatibility: the PARAMS the swap action
    // decodes are a different tuple, and the two encode to the same length (see
    // `_buyThroughRouter`). Identical dispatch bytes are exactly what makes the
    // mismatch easy to reach.
    uint8 internal constant CMD_INFI_SWAP = 0x10;
    uint8 internal constant ACTION_CL_SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant ACTION_SETTLE_ALL = 0x0c;
    uint8 internal constant ACTION_TAKE_ALL = 0x0f;

    uint256 internal deployerPk;
    address internal deployer;
    ToshFactory internal factory;
    ToshLadderTreasury internal treasury;

    /// @dev Read off the factory rather than from env, so the rehearsal cannot
    ///      approve one token while the factory pulls another. The factory is the
    ///      authority on what it is denominated in; a `QUOTE_ASSET` in `.env`
    ///      would be a second opinion with nothing reconciling the two.
    IERC20 internal quoteAsset;

    function _setUp() internal {
        require(block.chainid == 97, "RehearseTestnet is BSC testnet (97) only");

        deployerPk = vm.envUint("PRIVATE_KEY");
        deployer = vm.addr(deployerPk);

        factory = ToshFactory(payable(vm.envAddress("FACTORY_ADDRESS")));
        treasury = ToshLadderTreasury(payable(vm.envAddress("TREASURY_ADDRESS")));

        // The factory is the thing under test; a typo in .env would otherwise
        // produce a confusing revert several calls later.
        require(address(factory).code.length > 0, "FACTORY_ADDRESS holds no code");
        require(factory.owner() == deployer, "deployer does not own the factory");
        require(factory.ladderTreasury() == address(treasury), "factory/treasury are not wired to each other");

        quoteAsset = IERC20(address(factory.quoteAsset()));
        require(
            address(treasury.quoteAsset()) == address(quoteAsset), "factory/treasury disagree on the quote asset"
        );

        // ⚠ WHATEVER THIS IS, IT IS NOT BEM. BEM has no deployment on 97, so a
        //   factory reachable here was necessarily constructed against some other
        //   8-decimal token. The phases below therefore rehearse the SHAPE of the
        //   flows — approve, pull, settle, refund — and not the asset. What they
        //   cannot rehearse is the part of the risk that is specific to BEM: a
        //   float of 1,959 tokens in its only real pool, and a mint authority
        //   behind an upgradeable proxy. See docs/BEM_QUOTE_ASSET.md §3.
        require(
            quoteAsset.balanceOf(deployer) >= REHEARSAL_LAUNCH_FEE + REHEARSAL_RAISE,
            "deployer holds too little quote asset for the fee plus the raise -- mint or acquire some first"
        );

        // Nothing to install. On Robinhood this is where `_installArbSys()`
        // etched a mock over 0x64 so the local simulation would not abort on
        // the Orbit stub's `0xfe` byte. BSC has no precompile there, which is
        // the case the hook's fallback already handles.
    }

    /// @dev The PoG oracle attestation, signed here because on testnet the
    ///      signer key and the deployer key are the same one. In production
    ///      this digest is produced by the backend and the key never touches a
    ///      script.
    function _registerPoG(uint256 maxAlloc) internal {
        uint256 nonce = factory.pogNonces(deployer);
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 digest = keccak256(abi.encode(deployer, maxAlloc, nonce, deadline, address(factory), block.chainid))
            .toEthSignedMessageHash();

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(deployerPk, digest);
        factory.registerPoG(maxAlloc, deadline, nonce, abi.encodePacked(r, s, v));
    }

    /// @dev Loads the hook and token phase 1 created.
    function _loadProject() internal view returns (ToshLaunchpadHook hook, ToshToken token) {
        hook = ToshLaunchpadHook(payable(vm.envAddress("HOOK_ADDRESS")));
        token = ToshToken(vm.envAddress("TOKEN_ADDRESS"));
        require(address(hook).code.length > 0, "HOOK_ADDRESS holds no code");
        require(factory.registeredHooks(address(hook)), "hook is not registered with this factory");
    }

    /// @dev A native-BNB buy through the deployed Infinity UniversalRouter —
    ///      the path real traffic takes. `zeroForOne` is always true because the
    ///      native coin sorts to `currency0`.
    ///
    ///      The tuple has FIVE fields, and the count is the thing to be careful
    ///      about. Uniswap's has six: it carries `minHopPriceX36` and its
    ///      `PoolKey` has five members. Infinity drops that field and its
    ///      `PoolKey` gains one — it names its own pool manager — so both
    ///      tuples encode to the same ten head slots and the same `0x160`
    ///      minimum length. Both decoders are the same raw calldata pointer
    ///      cast with no check past that floor, so neither can reject the
    ///      other's calldata on size.
    ///
    ///      Sending the wrong one here reverts rather than settling a swap
    ///      nobody described, but only because Uniswap's `fee` lands on the slot
    ///      Infinity reads as `poolManager` and that field is validated. One
    ///      field in one position. `scripts/checkV4RouterTuple.mjs` check 6
    ///      pins this struct against infinity-periphery, and
    ///      `test_forkInfinity_theUniswapShapedTupleIsNotInterchangeable`
    ///      measures the near-miss; see docs/PANCAKESWAP_INFINITY.md §10.
    /// @dev Buys `currency1` with `amountIn` of `currency0` through Infinity's
    ///      UniversalRouter.
    ///
    ///      ⚠ THE INPUT LEG NOW GOES THROUGH PERMIT2, AND THIS PATH IS UNVERIFIED
    ///        ON-CHAIN. While `currency0` was native, `execute{value: amountIn}`
    ///        was the whole settlement: `SETTLE_ALL` saw the value already sitting
    ///        in the router. An ERC20 input has no such arrival, so the router
    ///        pulls it, and PancakeSwap's UniversalRouter pulls through Permit2
    ///        rather than a direct `transferFrom`. That makes the buyer's approval
    ///        a TWO-STEP grant: the token to Permit2 once, then Permit2 to the
    ///        router with an expiry.
    ///
    ///        Unverified because nobody has run this. BEM does not exist on 97,
    ///        the 97 rehearsal was deliberately skipped, and the fork suite
    ///        exercises the hook's own swap accounting rather than the router's
    ///        settlement. Treat the two approvals below as the intended shape and
    ///        expect to debug them the first time this is actually executed —
    ///        specifically whether this router honours the canonical Permit2 and
    ///        whether `SETTLE_ALL` wants `payerIsUser` set differently for ERC20.
    function _buyThroughRouter(PoolKey memory key, uint128 amountIn, uint128 minOut) internal {
        // `quoteAsset` rather than unwrapping `key.currency0`, which is the same
        // token by construction and is re-asserted here. If they ever diverge the
        // pool's sides are inverted and this swap would be selling, not buying.
        require(Currency.unwrap(key.currency0) == address(quoteAsset), "currency0 is not the quote asset");

        quoteAsset.approve(PERMIT2, amountIn);
        IPermit2Approve(PERMIT2).approve(
            address(quoteAsset), UNIVERSAL_ROUTER, amountIn, uint48(block.timestamp + 600)
        );

        bytes memory actions = abi.encodePacked(ACTION_CL_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE_ALL);

        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ICLRouterBase.CLSwapExactInputSingleParams({
                poolKey: key, zeroForOne: true, amountIn: amountIn, amountOutMinimum: minOut, hookData: ""
            })
        );
        params[1] = abi.encode(key.currency0, amountIn);
        params[2] = abi.encode(key.currency1, uint256(minOut));

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        // No `{value:}`. The router takes the input from the Permit2 allowance
        // granted above; sending BNB alongside would leave it stranded in the
        // router with nothing in this calldata instructing a refund.
        IUniversalRouter(UNIVERSAL_ROUTER).execute(abi.encodePacked(CMD_INFI_SWAP), inputs, block.timestamp + 600);
    }

    function _logHeader(string memory title) internal view {
        console2.log("============================================================");
        console2.log(title);
        console2.log("============================================================");
        console2.log("chain     : 97 (BSC testnet)");
        console2.log("deployer  :", deployer);
        console2.log("factory   :", address(factory));
        console2.log("treasury  :", address(treasury));
        console2.log("timestamp :", block.timestamp);
        console2.log("------------------------------------------------------------");
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Phase 1 — scale the parameters, create the launch, fund genesis
// ═══════════════════════════════════════════════════════════════════════════
contract Phase1Genesis is RehearsalBase {
    function run() external {
        _setUp();
        _logHeader("RH-F1 phase 1 -- genesis");

        vm.startBroadcast(deployerPk);

        _scaleParameters();
        bytes32 salt = _pickSalt();
        _registerPoG(REHEARSAL_WALLET_CAP);

        // Two approvals, not a `{value:}`. The factory pulls the launch fee and
        // the genesis deposit with `transferFrom`, so the rehearsal has to grant
        // an allowance first — which is itself part of what is being rehearsed,
        // since it is the extra transaction every real creator and depositor now
        // pays for.
        //
        // Approved exactly, and separately, rather than once for the sum. An
        // allowance sized to cover both would let a bug in either pull draw on
        // the other's budget and still succeed, which is the failure this
        // rehearsal exists to catch.
        quoteAsset.approve(address(factory), REHEARSAL_LAUNCH_FEE);

        (address token, address hook) = factory.createLaunch(
            "Tosh Rehearsal",
            "RHRSL",
            deployer, // projectTreasury
            deployer, // projectAdmin
            salt,
            REHEARSAL_LAUNCH_FEE,
            // Read live, in the same transaction that spends them. A rehearsal
            // is exactly the situation these two guard against: the Safe has
            // been moving dials in the phases above, so passing a value written
            // down earlier in the script would be the mistake being rehearsed.
            factory.defaultSoftCap(),
            factory.maxPogAllocationLimit(),
            GENESIS_WINDOW
        );

        // One wallet, one fifth of the cap. The shortfall is the point.
        quoteAsset.approve(address(factory), REHEARSAL_RAISE);
        factory.deposit(hook, address(0), REHEARSAL_RAISE);

        vm.stopBroadcast();

        _report(token, hook);
    }

    /// @dev Order still matters, though less violently than it used to.
    ///      `createLaunch` snapshots `defaultSoftCap` and
    ///      `maxPogAllocationLimit` into the clone's immutable args, so they are
    ///      part of the initcode and therefore of the predicted address. Calling
    ///      these setters after `_pickSalt` would move the address out from
    ///      under the occupancy check — a stale prediction no longer gets
    ///      refused outright now that the address-bit gate is gone, so the
    ///      failure would surface later and less clearly.
    function _scaleParameters() internal {
        require(REHEARSAL_RAISE >= factory.MIN_SOFT_CAP_PROD(), "REHEARSAL_RAISE is below the contract's own floor");
        require(REHEARSAL_SOFT_CAP > REHEARSAL_RAISE, "rehearsal must launch with the soft cap unmet");

        factory.setLaunchFee(REHEARSAL_LAUNCH_FEE);
        factory.setDefaultSoftCap(REHEARSAL_SOFT_CAP);
        factory.setMaxPogAllocationLimit(REHEARSAL_WALLET_CAP);

        console2.log("launchFee            :", factory.launchFee());
        console2.log("defaultSoftCap       :", factory.defaultSoftCap());
        console2.log("maxPogAllocationLimit:", factory.maxPogAllocationLimit());
    }

    /// @dev Picks the salt to launch with. Under Uniswap V4 this was a 500k
    ///      iteration mining loop hunting an address that carried the 0x20CC
    ///      permission mask; PancakeSwap Infinity takes permissions from the
    ///      hook's registration bitmap, so the factory accepts any salt and the
    ///      loop is gone.
    ///
    ///      One thing the loop also did has to survive it: rejecting a salt
    ///      whose address is already occupied. CREATE2 into a non-empty address
    ///      fails, and `ToshFactory` derives its salt from
    ///      `keccak256(creator, rawSalt)` — so a rehearsal re-run by the same
    ///      deployer, with the same parameters, predicts the address its own
    ///      previous run already deployed to. Walking `rawSalt` forward until
    ///      the address is empty is what makes the rehearsal repeatable.
    function _pickSalt() internal view returns (bytes32 rawSalt) {
        bytes32 initcodeHash =
            factory.hookInitcodeHash(deployer, deployer, REHEARSAL_SOFT_CAP, REHEARSAL_WALLET_CAP, GENESIS_WINDOW);

        for (uint256 i; i < 1000; ++i) {
            rawSalt = bytes32(i);
            bytes32 finalSalt = keccak256(abi.encode(deployer, rawSalt));
            if (HookAddress.computeAddress(address(factory), finalSalt, initcodeHash).code.length == 0) return rawSalt;
        }
        revert("first 1000 salts are all occupied - is this the same deployer and config as 1000 prior rehearsals?");
    }

    function _report(address token, address hook) internal view {
        ToshLaunchpadHook h = ToshLaunchpadHook(payable(hook));
        uint256 deadline = h.genesisDeadline();

        console2.log("============================================================");
        console2.log("PHASE 1 COMPLETE");
        console2.log("============================================================");
        console2.log("hook            :", hook);
        console2.log("token           :", token);
        console2.log("softCap         :", h.softCap());
        console2.log("totalNativeDeposited:", h.totalNativeDeposited());
        console2.log("genesisDeadline :", deadline);
        console2.log("seconds to wait :", deadline > block.timestamp ? deadline - block.timestamp : 0);
        console2.log("------------------------------------------------------------");
        console2.log("Append to .env, then run Phase2Launch after the deadline:");
        console2.log("HOOK_ADDRESS=%s", hook);
        console2.log("TOKEN_ADDRESS=%s", token);
        console2.log("============================================================");
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Phase 2 — launch, and observe the things only a real chain can show
// ═══════════════════════════════════════════════════════════════════════════
contract Phase2Launch is RehearsalBase {
    function run() external {
        _setUp();
        _logHeader("RH-F1 phase 2 -- launch");

        (ToshLaunchpadHook hook, ToshToken token) = _loadProject();

        uint256 deadline = hook.genesisDeadline();
        // Not a `require`: its message argument is evaluated eagerly even when
        // the condition holds, so the subtraction underflows the moment the
        // window actually opens -- which is the only moment this runs.
        if (block.timestamp < deadline) {
            revert(
                string.concat(
                    "genesis window is still open -- wait ", vm.toString(deadline - block.timestamp), " more seconds"
                )
            );
        }
        require(!hook.launched(), "already launched");

        // What `launch()` now actually requires, and nothing more. This used to
        // read `totalNativeDeposited() >= softCap()`, which would refuse the very
        // case the rehearsal exists to prove — the cap is a progress target now
        // and the clock is the gate at both ends.
        require(hook.totalNativeDeposited() > 0, "nothing was raised");
        require(block.timestamp <= deadline + hook.LAUNCH_WINDOW(), "launch window expired -- refunds are open");

        console2.log("raised / soft cap:", hook.totalNativeDeposited(), "/", hook.softCap());
        console2.log("  launching with the cap UNMET is the behaviour under test.");

        // Launch alone. Listing the token on the ladder used to ride along here
        // and could not have worked: `addLadderToken` refuses a token whose hook
        // answers 0 for `twapSqrtPriceX96()`, and `launch()` sets both oracle
        // checkpoints to the launching timestamp, so `span` is 0 and the getter
        // returns 0 by the rule at `_twapSqrtPriceX96`. The pair reverted
        // `TwapNotMature()` in simulation before a transaction was ever sent —
        // the same shape of mistake as the same-block lockout in the header, and
        // caught the same way, by a phase boundary. Listing is Phase2bList,
        // TWAP_WINDOW (1800 s) after this.
        vm.startBroadcast(deployerPk);
        hook.launch();
        vm.stopBroadcast();

        _report(hook, token);
    }

    /// @dev `lastSwapBlock` is the assertion RH-F2 exists for, and it is the one
    ///      number in this whole rehearsal that could not have been checked
    ///      anywhere else.
    ///
    ///      `launch()` stamps it via `_blockNumber()`, and the lockout later
    ///      compares that stamp against a fresh call to the same function. The
    ///      failure this catches is the two disagreeing about which clock they
    ///      are on — if they do, the same-block lockout never fires once in
    ///      production.
    ///
    ///      ⚠THE ASSERTION INVERTED WHEN WE LEFT ROBINHOOD, and it had to. On
    ///      that Orbit chain `NUMBER` returned an L1 height around 25.8 M while
    ///      the chain's own head was around 108 M, so the two clocks were
    ///      separated by 80 M and a magnitude test told them apart:
    ///      `stamped > 50_000_000` meant ArbSys had answered.
    ///
    ///      That test would now pass for the wrong reason. BSC has one clock and
    ///      its head is already past 60 M, so the old threshold is satisfied by
    ///      `block.number` alone — it would report success without checking
    ///      anything. What is provable here instead is equality: with
    ///      `_hasArbSys` false the stamp must be the chain's own height, so it
    ///      may only trail `head` by the blocks mined since `launch()` landed.
    ///      A stamp that is far behind, ahead, or zero means `_blockNumber()` is
    ///      not returning `block.number`.
    function _report(ToshLaunchpadHook hook, ToshToken token) internal view {
        uint256 stamped = hook.lastSwapBlock();
        uint256 head = block.number;

        console2.log("============================================================");
        console2.log("PHASE 2 COMPLETE");
        console2.log("============================================================");
        console2.log("launched        :", hook.launched());
        console2.log("token totalSupply:", token.totalSupply());
        console2.log("treasury balance :", treasury.reservoir());
        console2.log("------------------------------------------------------------");
        console2.log("RH-F2 -- which clock did the hook stamp?");
        console2.log("  lastSwapBlock (via _blockNumber) :", stamped);
        console2.log("  block.number as this script sees :", head);
        console2.log("------------------------------------------------------------");

        // Deliberately a hard failure rather than a printed warning. A rehearsal
        // that reports the wrong clock and exits 0 is how this ships broken.
        //
        // The window is generous on purpose: `launch()` and this read are
        // separate transactions, and BSC mines every 750 ms, so some drift is
        // expected and means nothing. A mismatched clock would be off by orders
        // of magnitude, not by a handful of blocks.
        require(stamped != 0, "lastSwapBlock is 0 -- launch() never stamped it");
        require(stamped <= head, "lastSwapBlock is ahead of the chain head -- _blockNumber() is not reading this chain");
        require(head - stamped < 10_000, "lastSwapBlock trails the head too far -- _blockNumber() is on another clock");
        console2.log("  -> matches this chain's height. No-ArbSys fallback confirmed on BSC.");
        console2.log("------------------------------------------------------------");
        console2.log("maxMintable() right now:", hook.maxMintable());
        console2.log("(0 is expected and correct -- launch() closed the launch block.)");
        console2.log("Next: Phase2bList, once TWAP_WINDOW has passed:", hook.TWAP_WINDOW());
        console2.log("============================================================");
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Phase 2b — list the token on the buyback ladder
// ═══════════════════════════════════════════════════════════════════════════
/// @dev A phase of its own because the treasury's listing gate is a clock.
///
///      `addLadderToken` reads `twapSqrtPriceX96()` and refuses both doors to
///      "unbounded" — a zero reading and a revert — so a token may only be
///      listed once its hook has a TWAP. `launch()` stamps `_prevCheckpointTs`
///      at the launching timestamp, so the getter returns 0 for the first
///      `TWAP_WINDOW`, and no transaction can shorten that.
///
///      No swap is needed to mature it. With the pool quiet,
///      `nowTs - lastObservationTs` also crosses the window and the getter
///      returns `lastTick`'s sqrt price exactly, which is the launch price.
///      Running this before or after Phase3Buy is therefore both fine; the
///      ladder mint in Phase 4 is what needs the token listed.
contract Phase2bList is RehearsalBase {
    function run() external {
        _setUp();
        _logHeader("RH-F1 phase 2b -- list on the buyback ladder");

        (ToshLaunchpadHook hook, ToshToken token) = _loadProject();
        require(hook.launched(), "not launched -- run Phase2Launch first");

        // Read the gate rather than compute the wait from a launch timestamp the
        // hook does not expose. 0 is the one value that cannot be listed, and it
        // is exactly what the treasury will see.
        uint160 twap = hook.twapSqrtPriceX96();
        if (twap == 0) {
            revert(
                string.concat(
                    "TWAP is not mature -- the treasury would revert TwapNotMature(). Wait out TWAP_WINDOW (",
                    vm.toString(uint256(hook.TWAP_WINDOW())),
                    " s) from launch and re-run."
                )
            );
        }
        console2.log("twapSqrtPriceX96 :", twap);

        vm.startBroadcast(deployerPk);
        treasury.addLadderToken(address(token));
        vm.stopBroadcast();

        console2.log("============================================================");
        console2.log("PHASE 2b COMPLETE");
        console2.log("============================================================");
        console2.log("ladder token count:", treasury.ladderTokenCount());
        console2.log("Next: Phase3Buy");
        console2.log("============================================================");
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Phase 3 — a real buy through the deployed UniversalRouter
// ═══════════════════════════════════════════════════════════════════════════
/// @dev Two jobs. It is the first swap this platform has ever sent through
///      PancakeSwap Infinity's router, and it is what lifts spot off `p0` so the
///      ladder's price gate can open — the gate is a strict `>`, and at launch
///      `spot == p0` up to sqrt truncation, so shelf 0 sits exactly ON it and
///      nothing is mintable until the market moves.
contract Phase3Buy is RehearsalBase {
    uint128 internal constant BUY_AMOUNT = 0.002 ether;

    function run() external {
        _setUp();
        _logHeader("RH-F1 phase 3 -- buy through the live UniversalRouter");

        (ToshLaunchpadHook hook, ToshToken token) = _loadProject();
        require(hook.launched(), "not launched -- run Phase2Launch first");

        uint256 reservoirBefore = treasury.reservoir();
        uint256 tokensBefore = IERC20(address(token)).balanceOf(deployer);

        console2.log("lastSwapBlock before :", hook.lastSwapBlock());
        console2.log("maxMintable   before :", hook.maxMintable());
        console2.log("treasury ETH  before :", reservoirBefore);

        vm.startBroadcast(deployerPk);
        // `minOut: 0` — this is a rehearsal against a pool nobody else is
        // trading, so there is no slippage to bound and a bound would only add
        // a way to fail for reasons unrelated to what is being tested.
        _buyThroughRouter(hook.getPoolKey(), BUY_AMOUNT, 0);
        vm.stopBroadcast();

        _report(hook, token, reservoirBefore, tokensBefore);
    }

    function _report(ToshLaunchpadHook hook, ToshToken token, uint256 reservoirBefore, uint256 tokensBefore)
        internal
        view
    {
        uint256 stamped = hook.lastSwapBlock();
        uint256 received = IERC20(address(token)).balanceOf(deployer) - tokensBefore;
        uint256 taxed = treasury.reservoir() - reservoirBefore;

        console2.log("============================================================");
        console2.log("PHASE 3 COMPLETE");
        console2.log("============================================================");
        console2.log("quote asset in    :", BUY_AMOUNT);
        console2.log("tokens received   :", received);
        console2.log("dark tax to reservoir:", taxed);
        console2.log("treasury reservoir:", treasury.reservoir());
        console2.log("nextSpendAmount   :", treasury.nextSpendAmount());
        console2.log("------------------------------------------------------------");
        console2.log("lastSwapBlock re-armed to :", stamped);
        console2.log("maxMintable() this block  :", hook.maxMintable());
        console2.log("(0 again -- the swap just re-armed the lockout. That is RH-F2:");
        console2.log(" the stamp tracks this chain's own height, so the lockout");
        console2.log(" clears on BSC's next 750 ms block rather than never.)");
        console2.log("------------------------------------------------------------");
        require(received > 0, "router returned no tokens");
        require(stamped != 0, "lastSwapBlock is 0 after the swap -- afterSwap never stamped it");
        require(
            stamped <= block.number && block.number - stamped < 10_000,
            "lastSwapBlock does not track this chain's height after the swap"
        );
        console2.log("Next: Phase4Ladder");
        console2.log("============================================================");
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Phase 4 — mint off the ladder, then deploy the reservoir
// ═══════════════════════════════════════════════════════════════════════════
contract Phase4Ladder is RehearsalBase {
    function run() external {
        _setUp();
        _logHeader("RH-F1 phase 4 -- ladder mint and buyback");

        (ToshLaunchpadHook hook, ToshToken token) = _loadProject();
        require(hook.launched(), "not launched");

        // If this is 0 the lockout has not released, or the buy in phase 3 did
        // not lift spot far enough past `p0` to clear the strict price gate.
        // Both are legible states rather than bugs, so say which.
        uint256 mintable = hook.maxMintable();
        console2.log("maxMintable      :", mintable);
        console2.log("lastSwapBlock    :", hook.lastSwapBlock());
        console2.log("block.number     :", block.number);
        require(
            mintable > 0,
            "maxMintable is 0 -- either the lockout is still armed (re-run in a later block) "
            "or spot never cleared p0 (run Phase3Buy again with a larger BUY_AMOUNT)"
        );

        // A tenth of what is on offer, so the mint spans one shelf rather than
        // sweeping the ladder — the arithmetic is the same and the gas is a
        // figure RH-B4 can actually compare against the local measurement.
        uint256 amount = mintable / 10;
        if (amount == 0) amount = mintable;

        uint256 cost = hook.quoteMint(amount);
        uint256 tokensBefore = IERC20(address(token)).balanceOf(deployer);

        console2.log("minting          :", amount);
        console2.log("quoted cost      :", cost);

        // 1 % over the quote, for a quote that can be a shelf boundary out by the
        // time this lands. What that 1 % IS has changed, and the distinction is
        // worth rehearsing rather than discovering: it used to be an overpayment
        // the hook refunded, and it is now only a slippage ceiling. The hook pulls
        // exactly `cost` and there is nothing to refund, so `charged` below should
        // equal the quote whenever no shelf boundary was crossed — a `charged`
        // above `quoted` means another buyer got there first, which is the state
        // this tolerance exists to absorb.
        uint256 tolerance = cost + cost / 100;

        vm.startBroadcast(deployerPk);
        // Approved to the HOOK, not the factory. The shelf payment is pulled by
        // the hook straight to `ladderTreasury` and `projectAdmin`, so the
        // allowance a buyer needs in Phase 2 is a different one from the
        // allowance a depositor needed in Phase 1 — a real second approval per
        // project, which the frontend has to ask for.
        quoteAsset.approve(address(hook), tolerance);
        uint256 charged = hook.mintBondingCurve(amount, tolerance);
        vm.stopBroadcast();

        _reportMint(token, tokensBefore, cost, charged);
        _buyback(hook, token);
    }

    function _reportMint(ToshToken token, uint256 tokensBefore, uint256 quoted, uint256 charged) internal view {
        console2.log("------------------------------------------------------------");
        console2.log("MINT DONE");
        console2.log("  quoted  :", quoted);
        console2.log("  charged :", charged);
        console2.log("  received:", IERC20(address(token)).balanceOf(deployer) - tokensBefore);
        require(charged == quoted, "quoteMint disagreed with mintBondingCurve on the live chain");
        console2.log("  -> quoteMint and mintBondingCurve agree to the wei.");
    }

    /// @dev `pokeBuyback` is the permissionless path. It reverts `NotArmed`
    ///      rather than returning quietly, so a rehearsal that has not collected
    ///      enough tax yet gets a clear answer instead of a silent no-op — which
    ///      is why this reports the threshold rather than just calling it.
    function _buyback(ToshLaunchpadHook hook, ToshToken token) internal {
        uint256 spend = treasury.nextSpendAmount();

        console2.log("------------------------------------------------------------");
        console2.log("BUYBACK");
        console2.log("  treasury reserv:", treasury.reservoir());
        console2.log("  nextSpendAmount:", spend);

        if (spend == 0) {
            console2.log("  reservoir below the per-cycle minimum -- nothing to deploy.");
            console2.log("  Not a failure: re-run Phase3Buy a few times to collect more tax.");
            return;
        }

        // Measured at DEAD_ADDRESS, not via `totalSupply`. The buyback burns by
        // transferring to `0x…dEaD` rather than calling `_burn`, so total supply
        // is unchanged by design and a supply delta would always read zero.
        address dead = treasury.DEAD_ADDRESS();
        uint256 deadBefore = IERC20(address(token)).balanceOf(dead);
        uint256 quoteBefore = treasury.reservoir();

        vm.startBroadcast(deployerPk);
        treasury.pokeBuyback();
        vm.stopBroadcast();

        console2.log("  quote spent    :", quoteBefore - treasury.reservoir());
        console2.log("  tokens to dead :", IERC20(address(token)).balanceOf(dead) - deadBefore);
        console2.log("  dead balance   :", IERC20(address(token)).balanceOf(dead));
        console2.log("  totalSupply    :", token.totalSupply(), "(unchanged by design)");
        console2.log("  treasury reserv:", treasury.reservoir());
        console2.log("  lastSwapBlock  :", hook.lastSwapBlock());
        require(
            IERC20(address(token)).balanceOf(dead) > deadBefore,
            "buyback spent ETH but burned nothing -- every leg was caught by its try/catch"
        );
        console2.log("============================================================");
        console2.log("RH-F1 COMPLETE -- create, genesis, launch, mint, buyback");
        console2.log("============================================================");
    }
}
