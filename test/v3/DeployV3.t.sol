// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vault} from "infinity-core/src/Vault.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {CLPoolManager} from "infinity-core/src/pool-cl/CLPoolManager.sol";

import {DeployV3} from "../../script/DeployV3.s.sol";
import {ToshBidBook} from "../../src/ToshBidBook.sol";
import {ToshLadderTreasury} from "../../src/ToshLadderTreasury.sol";
import {ToshLaunchGateway} from "../../src/ToshLaunchGateway.sol";
import {ToshAutoLp} from "../../src/v3/ToshAutoLp.sol";
import {ToshFactoryV3} from "../../src/v3/ToshFactoryV3.sol";
import {ToshHookLensV3} from "../../src/v3/ToshHookLensV3.sol";
import {ToshLaunchpadHookV3} from "../../src/v3/ToshLaunchpadHookV3.sol";
import {HookAddress} from "../../src/libraries/HookAddress.sol";
import {MockQuoteAsset} from "../utils/MockQuoteAsset.sol";
import {MockAgentRegistryV3} from "./utils/MockAgentRegistryV3.sol";
import {MockSafeV3} from "./FactoryV2.t.sol";

/// @dev The real script, with the deployment record kept in memory instead of
///      written to `deployments/`.
contract DeployV3Harness is DeployV3 {
    address public book;
    address public lens;
    Stack internal _bnb;
    Stack internal _usdt;

    function _write(ToshBidBook b, ToshHookLensV3 l, Stack memory b_, Stack memory u_) internal override {
        (book, lens, _bnb, _usdt) = (address(b), address(l), b_, u_);
    }

    /// @dev `run` without the process environment. `DeployV2Test` rewrites
    ///      the same variables and Foundry runs suites in parallel, so a suite
    ///      reading them would race it. Same checks, same deploy.
    function deployWith(uint256 pk, Env memory e, uint256 target, Params memory bp, Params memory up) external {
        _validate(e, target);
        _deploy(pk, e, bp, up);
    }

    function defaults() external pure returns (Params memory, Params memory) {
        return (_bnbDefaults(), _usdtDefaults());
    }

    function paramsFrom(string memory prefix) external view returns (Params memory) {
        return _params(prefix, _usdtDefaults());
    }

    function bnb() external view returns (Stack memory) {
        return _bnb;
    }

    function usdt() external view returns (Stack memory) {
        return _usdt;
    }
}

/// @notice `script/DeployV3.s.sol` end to end against a local Infinity, and every
///         pre-flight check that refuses a bad environment.
///
/// @dev    Drives the script through `deployWith`, not `run`: see the
///         harness. `run` itself is `_readEnv` and `_params` in front of
///         the same two calls.
contract DeployV3Test is Test {
    uint256 constant PK = 0xD3B13; // throwaway test key, holds nothing
    address deployer;
    MockSafeV3 safe;
    address platform = makeAddr("platform");
    address feeRecipient = makeAddr("feeRecipient");
    address dev = makeAddr("dev");
    Vault vault;
    CLPoolManager manager;
    MockAgentRegistryV3 registry;
    MockQuoteAsset wbnb;
    MockQuoteAsset usdt;

    function setUp() public {
        deployer = vm.addr(PK);
        vm.chainId(97);
        vault = new Vault();
        manager = new CLPoolManager(IVault(address(vault)));
        vault.registerApp(address(manager));
        registry = new MockAgentRegistryV3();
        wbnb = new MockQuoteAsset();
        usdt = new MockQuoteAsset();
        safe = new MockSafeV3();
        safe.add(makeAddr("signer"));
    }

    function _e() internal view returns (DeployV3.Env memory) {
        return DeployV3.Env({
            deployer: deployer,
            poolManager: address(manager),
            vault: address(vault),
            platform: platform,
            safe: address(safe),
            feeRecipient: feeRecipient,
            registry: address(registry),
            wbnb: address(wbnb),
            usdt: address(usdt)
        });
    }

    function _expectRefusal(DeployV3.Env memory e, uint256 target, string memory reason) internal {
        DeployV3Harness h = new DeployV3Harness();
        (DeployV3.Params memory bp, DeployV3.Params memory up) = h.defaults();
        vm.expectRevert(bytes(reason));
        h.deployWith(PK, e, target, bp, up);
    }

    function test_deployV3Script_endToEnd_andEveryPreflight() public {
        // ── refusals ────────────────────────────────────────────────────────
        DeployV3.Env memory e = _e();
        _expectRefusal(e, 56, "chain id mismatch: wrong --rpc-url");
        e.vault = address(wbnb);
        _expectRefusal(e, 97, "INFINITY_VAULT does not match the manager");
        e = _e();
        e.safe = makeAddr("eoa");
        _expectRefusal(e, 97, "PROD_OWNER_SAFE is not a Safe");
        e = _e();
        e.platform = deployer;
        _expectRefusal(e, 97, "deployer must hold no role");
        e = _e();
        e.registry = makeAddr("empty");
        _expectRefusal(e, 97, "AGENT_REGISTRY holds no code");
        e = _e();
        e.usdt = makeAddr("empty");
        _expectRefusal(e, 97, "quote assets hold no code");

        vm.chainId(1);
        _expectRefusal(_e(), 1, "TARGET_CHAIN_ID must be 56 or 97");
        vm.chainId(56);
        _expectRefusal(_e(), 56, "AGENT_REGISTRY is not the Binance registry");
        vm.chainId(97);

        {
            DeployV3Harness h = new DeployV3Harness();
            (DeployV3.Params memory bp, DeployV3.Params memory up) = h.defaults();
            up.shelfCap = 0;
            vm.expectRevert(bytes("zero shelf cap"));
            h.deployWith(PK, _e(), 97, bp, up);
        }

        // Env parsing, under a prefix nothing else in the suite writes.
        {
            DeployV3Harness h = new DeployV3Harness();
            vm.setEnv("V3TEST_SHELF_CAP", "123000000000000000000");
            DeployV3.Params memory p = h.paramsFrom("V3TEST_");
            assertEq(p.shelfCap, 123e18, "read from the environment");
            assertEq(p.minBuy, 5e18, "unset keys fall back to the defaults");
            assertEq(p.triggerStep, 180e18);
        }

        // ── a clean run ─────────────────────────────────────────────────────
        DeployV3Harness s = new DeployV3Harness();
        {
            (DeployV3.Params memory bp, DeployV3.Params memory up) = s.defaults();
            s.deployWith(PK, _e(), 97, bp, up);
        }

        ToshBidBook book = ToshBidBook(s.book());
        DeployV3.Stack memory b = s.bnb();
        DeployV3.Stack memory u = s.usdt();
        address[] memory fs = book.factories();
        assertEq(fs.length, 2);
        assertEq(fs[0], b.factory);
        assertEq(fs[1], u.factory);
        assertEq(book.feeRecipient(), feeRecipient);

        _checkStack(b, address(wbnb), true, 0.01e18, 500e18, 0.1e18, 0.007e18);
        _checkStack(u, address(usdt), false, 5e18, 300_000e18, 30_000e18, 5e18);
        assertEq(ToshLadderTreasury(payable(b.treasury)).TRIGGER_STEP(), 0.3e18);
        assertEq(ToshLadderTreasury(payable(u.treasury)).TRIGGER_STEP(), 180e18);
        assertEq(ToshLaunchpadHookV3(payable(u.hookImplementation)).PIGGYBACK_TRIGGER_STEP(), 180e18);
        assertTrue(b.autoLp != u.autoLp, "one AutoLp per factory");

        // The deployer keeps nothing once the Safe accepts.
        _accept(b);
        _accept(u);
        assertEq(ToshFactoryV3(b.factory).owner(), address(safe));
        assertEq(ToshLadderTreasury(payable(b.treasury)).owner(), address(safe));

        // The Safe can list through the deployed BNB stack.
        ToshFactoryV3 f = ToshFactoryV3(b.factory);
        bytes memory call = abi.encodeCall(
            ToshFactoryV3.createLaunch, ("Deployed", "DPL", dev, makeAddr("fund"), _salt(f), 10e18, 0.1e18, 24 hours)
        );
        safe.exec(address(f), call);
        assertEq(f.launchCount(), 1);

        // After the gateway handoff the Safe still retunes the shelf cap.
        ToshLaunchGateway gw = ToshLaunchGateway(u.gateway);
        safe.exec(u.factory, abi.encodeCall(ToshFactoryV3(u.factory).transferOwnership, (address(gw))));
        safe.exec(address(gw), abi.encodeCall(gw.execute, (abi.encodeWithSignature("acceptOwnership()"))));
        assertEq(ToshFactoryV3(u.factory).owner(), address(gw));
        safe.exec(
            address(gw), abi.encodeCall(gw.execute, (abi.encodeCall(ToshFactoryV3.setShelfCapPerAgent, (300e18))))
        );
        assertEq(ToshFactoryV3(u.factory).shelfCapPerAgent(), 300e18);
    }

    function _checkStack(
        DeployV3.Stack memory s,
        address quote,
        bool native,
        uint256 minBuy,
        uint256 maxHardCap,
        uint256 maxAgentCap,
        uint256 shelfCap
    ) internal view {
        ToshFactoryV3 f = ToshFactoryV3(s.factory);
        ToshLadderTreasury t = ToshLadderTreasury(payable(s.treasury));
        ToshLaunchpadHookV3 impl = ToshLaunchpadHookV3(payable(s.hookImplementation));
        ToshAutoLp a = ToshAutoLp(s.autoLp);
        assertEq(address(f.quoteAsset()), quote);
        assertEq(f.acceptsNative(), native);
        assertEq(f.minBuy(), minBuy);
        assertEq(f.maxHardCap(), maxHardCap);
        assertEq(f.maxAgentCap(), maxAgentCap);
        assertEq(f.shelfCapPerAgent(), shelfCap);
        assertEq(f.platformTreasury(), platform);
        assertEq(f.agentRegistry(), address(registry));
        assertEq(f.hookImplementation(), s.hookImplementation);
        assertEq(impl.factory(), s.factory);
        assertEq(impl.autoLp(), s.autoLp);
        assertEq(a.factory(), s.factory);
        assertEq(address(a.vault()), address(vault));
        assertEq(address(a.poolManager()), address(manager));
        assertEq(t.factory(), s.factory);
        assertEq(address(t.quoteAsset()), quote);
        assertEq(f.owner(), deployer, "two-step: the deployer until the Safe accepts");
        assertEq(f.pendingOwner(), address(safe));
        assertEq(t.pendingOwner(), address(safe));
        ToshLaunchGateway gw = ToshLaunchGateway(s.gateway);
        assertEq(address(gw.factory()), s.factory);
        assertEq(address(gw.safe()), address(safe));
    }

    function _accept(DeployV3.Stack memory s) internal {
        safe.exec(s.factory, abi.encodeWithSignature("acceptOwnership()"));
        safe.exec(s.treasury, abi.encodeWithSignature("acceptOwnership()"));
    }

    function _salt(ToshFactoryV3 f) internal view returns (bytes32 raw) {
        bytes32 initHash = f.hookInitcodeHash(dev, address(safe), 10e18, 0.1e18, 24 hours);
        for (uint256 i;; ++i) {
            raw = bytes32(i);
            address h = HookAddress.computeAddress(address(f), keccak256(abi.encode(address(safe), raw)), initHash);
            if (h.code.length == 0) return raw;
        }
    }
}
