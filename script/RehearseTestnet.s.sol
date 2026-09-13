// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "forge-std/console2.sol";

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {ToshLadderTreasury} from "../src/ToshLadderTreasury.sol";
import {ToshToken} from "../src/ToshToken.sol";
import {HookMiner} from "../src/libraries/HookMiner.sol";

/// @dev Minimal view of the deployed UniversalRouter, declared here for the same
///      reason `ToshV5Fork.t.sol` declares it: `lib/` carries v4-core and
///      v4-periphery but not universal-router, and `execute` is the whole
///      surface a swap needs.
interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @dev Stand-in for the ArbSys precompile, used only by the local simulation
///      `forge script` runs before it broadcasts. See `_installArbSys`.
contract SimArbSys {
    uint256 private _height;

    function arbBlockNumber() external view returns (uint256) {
        return _height;
    }

    function setHeight(uint256 h) external {
        _height = h;
    }
}

// ---------------------------------------------------------------------------
// RH-F1 / RH-F2 — the rehearsal on Robinhood Chain testnet (46630)
// ---------------------------------------------------------------------------
// TESTNET ONLY. Rewrites the factory's economic parameters, which is acceptable
// only because Deploy.s.sol deliberately leaves it EOA-owned on 46630.
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
// of 0.1 ETH per wallet. Those multiply: filling genesis at production values
// needs one hundred separately funded, separately PoG-attested wallets. The
// per-wallet cap is a fairness property working as designed; it just makes
// genesis the one phase no faucet can underwrite.
//
// So the soft cap goes to `MIN_SOFT_CAP_PROD` (0.01 ETH — the contract's own
// floor, below which `p0` truncates toward zero) and the wallet cap goes to the
// same figure, so one wallet fills it exactly.
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
//     --rpc-url $ROBINHOOD_TESTNET_RPC --broadcast --slow -vv
//
//   ...wait out the 3 h window, then...
//
//   forge script script/RehearseTestnet.s.sol:Phase2Launch \
//     --rpc-url $ROBINHOOD_TESTNET_RPC --broadcast --slow -vv
//   forge script script/RehearseTestnet.s.sol:Phase3Buy      ...
//   forge script script/RehearseTestnet.s.sol:Phase4Ladder   ...
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
abstract contract RehearsalBase is Script {
    using MessageHashUtils for bytes32;

    /// Genesis window. The hook allows 3 h / 24 h / 72 h and nothing else, so
    /// this is the shortest rehearsal the contracts permit.
    uint256 internal constant GENESIS_WINDOW = 3 hours;

    /// Equal to `ToshFactory.MIN_SOFT_CAP_PROD`. Asserted against the contract
    /// in `_scaleParameters` rather than trusted, because a `lib` bump or a
    /// constant edit would otherwise make this silently unreachable.
    uint256 internal constant REHEARSAL_SOFT_CAP = 0.01 ether;
    uint256 internal constant REHEARSAL_WALLET_CAP = 0.01 ether;
    uint256 internal constant REHEARSAL_LAUNCH_FEE = 0.001 ether;

    /// Robinhood Chain's deployed Uniswap V4 periphery. Same constants as
    /// `test/ToshV5Fork.t.sol` §2.2 — kept in sync by eye, and by the fact that
    /// a wrong one here simply fails against the live chain in seconds.
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;

    /// The ArbSys precompile. Real on chain, mocked in simulation — see
    /// `_installArbSys`.
    address internal constant ARB_SYS = address(uint160(100));

    uint8 internal constant CMD_V4_SWAP = 0x10;
    uint8 internal constant ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant ACTION_SETTLE_ALL = 0x0c;
    uint8 internal constant ACTION_TAKE_ALL = 0x0f;

    uint256 internal deployerPk;
    address internal deployer;
    ToshFactory internal factory;
    ToshLadderTreasury internal treasury;

    function _setUp() internal {
        require(block.chainid == 46630, "RehearseTestnet is Robinhood Chain testnet (46630) only");

        deployerPk = vm.envUint("PRIVATE_KEY");
        deployer = vm.addr(deployerPk);

        factory = ToshFactory(payable(vm.envAddress("FACTORY_ADDRESS")));
        treasury = ToshLadderTreasury(payable(vm.envAddress("TREASURY_ADDRESS")));

        // The factory is the thing under test; a typo in .env would otherwise
        // produce a confusing revert several calls later.
        require(address(factory).code.length > 0, "FACTORY_ADDRESS holds no code");
        require(factory.owner() == deployer, "deployer does not own the factory");
        require(factory.ladderTreasury() == address(treasury), "factory/treasury are not wired to each other");

        _installArbSys();
    }

    /// @dev `forge script` simulates the whole sequence locally before it sends
    ///      anything, and that simulation runs on a vanilla EVM with no notion
    ///      of Arbitrum precompiles.
    ///
    ///      Fetching 0x64 from the RPC does not help. An Orbit chain stores a
    ///      stub there whose bytecode is literally `0xfe`, and the node
    ///      intercepts calls to the address rather than executing it. Foundry
    ///      has nothing to intercept with, so it runs the stub and aborts with
    ///      `InvalidFEOpcode` — which is exactly how phase 2 failed on its
    ///      first attempt, after simulating the entire launch correctly right
    ///      up to the closing `_blockNumber()`.
    ///
    ///      `vm.etch` is a local-state cheatcode and is never part of a
    ///      broadcast, so the transaction that actually lands is unaffected and
    ///      resolves 0x64 against the real precompile. The mock therefore buys
    ///      a simulation that completes without weakening what is tested on
    ///      chain — but it does mean the simulation cannot prove anything about
    ///      `_blockNumber()`, which is why RH-F2 is asserted afterwards against
    ///      the mined receipt rather than here. Same trade recorded for the
    ///      fork suite against the public 4663 endpoint.
    ///
    ///      Seeded from `block.number` because Foundry takes that from the
    ///      RPC's `eth_blockNumber`, which on an Orbit chain is the L2 height —
    ///      the same quantity ArbSys reports.
    function _installArbSys() internal {
        SimArbSys impl = new SimArbSys();
        vm.etch(ARB_SYS, address(impl).code);
        SimArbSys(ARB_SYS).setHeight(block.number);
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

    /// @dev A native-ETH buy through the deployed UniversalRouter — the path
    ///      real traffic takes. `zeroForOne` is always true because native ETH
    ///      sorts to `currency0`, and `minHopPriceX36: 0` disables the router's
    ///      own per-hop floor so `amountOutMinimum` is the only slippage bound,
    ///      matching what the frontend sends.
    ///
    ///      The six-field struct is not cosmetic: Robinhood's router is a newer
    ///      build than Ethereum's and decodes a sixth field here. See §5.1 of
    ///      the migration doc and `scripts/checkV4RouterTuple.mjs`.
    function _buyThroughRouter(PoolKey memory key, uint128 amountIn, uint128 minOut) internal {
        bytes memory actions = abi.encodePacked(ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE_ALL);

        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            IV4Router.ExactInputSingleParams({
                poolKey: key,
                zeroForOne: true,
                amountIn: amountIn,
                amountOutMinimum: minOut,
                minHopPriceX36: 0,
                hookData: ""
            })
        );
        params[1] = abi.encode(key.currency0, amountIn);
        params[2] = abi.encode(key.currency1, uint256(minOut));

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        IUniversalRouter(UNIVERSAL_ROUTER).execute{value: amountIn}(
            abi.encodePacked(CMD_V4_SWAP), inputs, block.timestamp + 600
        );
    }

    function _logHeader(string memory title) internal view {
        console2.log("============================================================");
        console2.log(title);
        console2.log("============================================================");
        console2.log("chain     : 46630 (Robinhood Chain testnet)");
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
        bytes32 salt = _mineSalt();
        _registerPoG(REHEARSAL_WALLET_CAP);

        (address token, address hook) = factory.createLaunch{value: REHEARSAL_LAUNCH_FEE}(
            "Tosh Rehearsal",
            "RHRSL",
            deployer, // projectTreasury
            deployer, // projectAdmin
            salt,
            REHEARSAL_LAUNCH_FEE,
            GENESIS_WINDOW
        );

        // One wallet fills the whole soft cap, which is only possible because
        // the wallet cap was raised to meet it above.
        factory.deposit{value: REHEARSAL_SOFT_CAP}(hook, address(0));

        vm.stopBroadcast();

        _report(token, hook);
    }

    /// @dev Order matters and is not obvious: `createLaunch` snapshots
    ///      `defaultSoftCap` and `maxPogAllocationLimit` into the clone's
    ///      immutable args, and the salt is mined against those same two
    ///      values. Mining before the setters land would produce an address the
    ///      factory then refuses as `InvalidHookSalt`.
    function _scaleParameters() internal {
        require(
            REHEARSAL_SOFT_CAP >= factory.MIN_SOFT_CAP_PROD(), "REHEARSAL_SOFT_CAP is below the contract's own floor"
        );

        factory.setLaunchFee(REHEARSAL_LAUNCH_FEE);
        factory.setDefaultSoftCap(REHEARSAL_SOFT_CAP);
        factory.setMaxPogAllocationLimit(REHEARSAL_WALLET_CAP);

        console2.log("launchFee            :", factory.launchFee());
        console2.log("defaultSoftCap       :", factory.defaultSoftCap());
        console2.log("maxPogAllocationLimit:", factory.maxPogAllocationLimit());
    }

    /// @dev Runs during simulation only — it is a view loop, so it produces no
    ///      transactions and the broadcast carries just the mined salt.
    function _mineSalt() internal view returns (bytes32 rawSalt) {
        bytes32 initcodeHash =
            factory.hookInitcodeHash(deployer, deployer, REHEARSAL_SOFT_CAP, REHEARSAL_WALLET_CAP, GENESIS_WINDOW);

        for (uint256 i; i < 500_000; ++i) {
            rawSalt = bytes32(i);
            bytes32 finalSalt = keccak256(abi.encode(deployer, rawSalt));
            address predicted = HookMiner.computeAddress(address(factory), finalSalt, initcodeHash);
            if (HookMiner.isValidHookAddress(predicted) && predicted.code.length == 0) return rawSalt;
        }
        revert("no valid salt found in 500k attempts");
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
        console2.log("totalEthDeposited:", h.totalEthDeposited());
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
        require(hook.totalEthDeposited() >= hook.softCap(), "soft cap was never met");

        vm.startBroadcast(deployerPk);
        hook.launch();
        treasury.addLadderToken(address(token));
        vm.stopBroadcast();

        _report(hook, token);
    }

    /// @dev `lastSwapBlock` is the assertion RH-F2 exists for, and it is the one
    ///      number in this whole rehearsal that could not have been checked
    ///      anywhere else.
    ///
    ///      `launch()` stamps it via `_blockNumber()`. On an Orbit chain the
    ///      `NUMBER` opcode returns the **L1** height — around 25.8 M — while
    ///      this chain's own head is around 108 M. If the stamp comes back in
    ///      the L1 range then `_blockNumber()` is not reading ArbSys, the
    ///      flash-loan lockout is comparing two different clocks, and it would
    ///      never once fire in production.
    ///
    ///      Every test of this until now supplied its own ArbSys with
    ///      `vm.etch`, including the fork suite. This is the first time the real
    ///      precompile answers.
    function _report(ToshLaunchpadHook hook, ToshToken token) internal view {
        uint256 stamped = hook.lastSwapBlock();
        uint256 head = block.number;

        console2.log("============================================================");
        console2.log("PHASE 2 COMPLETE");
        console2.log("============================================================");
        console2.log("launched        :", hook.launched());
        console2.log("token totalSupply:", token.totalSupply());
        console2.log("treasury balance :", address(treasury).balance);
        console2.log("------------------------------------------------------------");
        console2.log("RH-F2 -- which clock did the hook stamp?");
        console2.log("  lastSwapBlock (via _blockNumber) :", stamped);
        console2.log("  block.number as this script sees :", head);
        console2.log("------------------------------------------------------------");

        // Deliberately a hard failure rather than a printed warning. A rehearsal
        // that reports the wrong clock and exits 0 is how this ships broken.
        require(stamped > 50_000_000, "lastSwapBlock looks like an L1 height -- _blockNumber() is NOT reading ArbSys");
        console2.log("  -> L2 height. ArbSys path confirmed against the real precompile.");
        console2.log("------------------------------------------------------------");
        console2.log("maxMintable() right now:", hook.maxMintable());
        console2.log("(0 is expected and correct -- launch() closed the launch block.)");
        console2.log("Next: Phase3Buy");
        console2.log("============================================================");
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Phase 3 — a real buy through the deployed UniversalRouter
// ═══════════════════════════════════════════════════════════════════════════

/// @dev Two jobs. It is the first swap this platform has ever sent through
///      Robinhood's own router, and it is what lifts spot off `p0` so the
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

        uint256 reservoirBefore = address(treasury).balance;
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
        uint256 taxed = address(treasury).balance - reservoirBefore;

        console2.log("============================================================");
        console2.log("PHASE 3 COMPLETE");
        console2.log("============================================================");
        console2.log("ETH in            :", BUY_AMOUNT);
        console2.log("tokens received   :", received);
        console2.log("dark tax to reservoir:", taxed);
        console2.log("treasury ETH now  :", address(treasury).balance);
        console2.log("nextSpendAmount   :", treasury.nextSpendAmount());
        console2.log("------------------------------------------------------------");
        console2.log("lastSwapBlock re-armed to :", stamped);
        console2.log("maxMintable() this block  :", hook.maxMintable());
        console2.log("(0 again -- the swap just re-armed the lockout. That is RH-F2:");
        console2.log(" on a 100 ms chain the next block is 100 ms away, not 10.7 s,");
        console2.log(" which is only true because _blockNumber() reads ArbSys.)");
        console2.log("------------------------------------------------------------");
        require(received > 0, "router returned no tokens");
        require(stamped > 50_000_000, "lastSwapBlock looks like an L1 height after the swap");
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

        vm.startBroadcast(deployerPk);
        // 1 % over the quote. `mintBondingCurve` refunds the excess, and a quote
        // taken one block earlier can be a shelf boundary out.
        uint256 charged = hook.mintBondingCurve{value: cost + cost / 100}(amount);
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
        console2.log("  treasury ETH   :", address(treasury).balance);
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
        uint256 ethBefore = address(treasury).balance;

        vm.startBroadcast(deployerPk);
        treasury.pokeBuyback();
        vm.stopBroadcast();

        console2.log("  ETH spent      :", ethBefore - address(treasury).balance);
        console2.log("  tokens to dead :", IERC20(address(token)).balanceOf(dead) - deadBefore);
        console2.log("  dead balance   :", IERC20(address(token)).balanceOf(dead));
        console2.log("  totalSupply    :", token.totalSupply(), "(unchanged by design)");
        console2.log("  treasury ETH   :", address(treasury).balance);
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
