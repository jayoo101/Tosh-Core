// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vault} from "infinity-core/src/Vault.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {CLPoolManager} from "infinity-core/src/pool-cl/CLPoolManager.sol";

import {DeployV2} from "../../script/DeployV2.s.sol";
import {DeployLaunchGateway} from "../../script/DeployLaunchGateway.s.sol";
import {ToshBidBook} from "../../src/ToshBidBook.sol";
import {ToshFactory} from "../../src/ToshFactory.sol";
import {ToshHookLens} from "../../src/ToshHookLens.sol";
import {ToshLadderTreasury} from "../../src/ToshLadderTreasury.sol";
import {ToshLaunchGateway} from "../../src/ToshLaunchGateway.sol";
import {ToshLaunchpadHook} from "../../src/ToshLaunchpadHook.sol";
import {HookAddress} from "../../src/libraries/HookAddress.sol";
import {MockQuoteAsset} from "../utils/MockQuoteAsset.sol";
import {MockAgentRegistry} from "./utils/MockAgentRegistry.sol";
import {MockSafe} from "./FactoryV2.t.sol";

/// @dev The real script, with the deployment record kept in memory instead of
///      written to `deployments/`.
contract DeployV2Harness is DeployV2 {
    address public book;
    address public lens;
    Stack internal _bnb;
    Stack internal _usdt;

    function _write(ToshBidBook b, ToshHookLens l, Stack memory b_, Stack memory u_) internal override {
        (book, lens, _bnb, _usdt) = (address(b), address(l), b_, u_);
    }

    function bnb() external view returns (Stack memory) {
        return _bnb;
    }

    function usdt() external view returns (Stack memory) {
        return _usdt;
    }
}

/// @notice `script/DeployV2.s.sol` end to end against a local Infinity, and every
///         pre-flight check that refuses a bad environment.
///
/// @dev    One test function on purpose. The script reads process environment
///         variables, and Foundry runs a contract's tests in parallel, so two
///         tests setting `TARGET_CHAIN_ID` differently would race.
contract DeployV2Test is Test {
    uint256 constant PK = 0xD3B10; // throwaway test key, holds nothing
    address deployer;
    MockSafe safe;
    address platform = makeAddr("platform");
    address feeRecipient = makeAddr("feeRecipient");
    address dev = makeAddr("dev");
    Vault vault;
    CLPoolManager manager;
    MockAgentRegistry registry;
    MockQuoteAsset wbnb;
    MockQuoteAsset usdt;

    function setUp() public {
        deployer = vm.addr(PK);
        vm.chainId(97);
        vault = new Vault();
        manager = new CLPoolManager(IVault(address(vault)));
        vault.registerApp(address(manager));
        registry = new MockAgentRegistry();
        wbnb = new MockQuoteAsset();
        usdt = new MockQuoteAsset();
        safe = new MockSafe();
        safe.add(makeAddr("signer"));
    }

    function _env() internal {
        vm.setEnv("PRIVATE_KEY", vm.toString(bytes32(PK)));
        vm.setEnv("TARGET_CHAIN_ID", "97");
        vm.setEnv("INFINITY_CL_POOL_MANAGER", vm.toString(address(manager)));
        vm.setEnv("INFINITY_VAULT", vm.toString(address(vault)));
        vm.setEnv("PLATFORM_TREASURY", vm.toString(platform));
        vm.setEnv("PROD_OWNER_SAFE", vm.toString(address(safe)));
        vm.setEnv("FEE_RECIPIENT", vm.toString(feeRecipient));
        vm.setEnv("AGENT_REGISTRY", vm.toString(address(registry)));
        vm.setEnv("WBNB", vm.toString(address(wbnb)));
        vm.setEnv("USDT", vm.toString(address(usdt)));
        vm.setEnv("BNB_AGENTCAP_MIN", "100000000000000000");
        vm.setEnv("BNB_AGENTCAP_MAX", "100000000000000000");
    }

    function _expectRefusal(string memory key, string memory value, string memory reason) internal {
        _env();
        vm.setEnv(key, value);
        DeployV2Harness s = new DeployV2Harness();
        vm.expectRevert(bytes(reason));
        s.run();
    }

    function test_deployScript_endToEnd_andEveryPreflight() public {
        // ── refusals ────────────────────────────────────────────────────────
        _expectRefusal("TARGET_CHAIN_ID", "56", "chain id mismatch: wrong --rpc-url");
        _expectRefusal("INFINITY_VAULT", vm.toString(address(wbnb)), "INFINITY_VAULT does not match the manager");
        _expectRefusal("PROD_OWNER_SAFE", vm.toString(makeAddr("eoa")), "PROD_OWNER_SAFE is not a Safe");
        _expectRefusal("PLATFORM_TREASURY", vm.toString(deployer), "deployer must hold no role");
        _expectRefusal("AGENT_REGISTRY", vm.toString(makeAddr("empty")), "AGENT_REGISTRY holds no code");
        _expectRefusal("WBNB", vm.toString(makeAddr("empty")), "quote assets hold no code");

        vm.chainId(1);
        _expectRefusal("TARGET_CHAIN_ID", "1", "TARGET_CHAIN_ID must be 56 or 97");
        vm.chainId(56);
        _expectRefusal("TARGET_CHAIN_ID", "56", "AGENT_REGISTRY is not the Binance registry");
        vm.chainId(97);

        // ── a clean run ─────────────────────────────────────────────────────
        _env();
        DeployV2Harness s = new DeployV2Harness();
        s.run();

        ToshBidBook book = ToshBidBook(s.book());
        DeployV2.Stack memory b = s.bnb();
        DeployV2.Stack memory u = s.usdt();
        address[] memory fs = book.factories();
        assertEq(fs.length, 2);
        assertEq(fs[0], b.factory);
        assertEq(fs[1], u.factory);
        assertEq(book.feeRecipient(), feeRecipient);

        _checkStack(b, address(wbnb), true, 0.01e18, 500e18, 0.1e18);
        assertEq(ToshFactory(b.factory).minAgentCap(), 0.1e18);
        _checkStack(u, address(usdt), false, 5e18, 300_000e18, 30_000e18);
        assertEq(ToshLadderTreasury(b.treasury).TRIGGER_STEP(), 0.3e18);
        assertEq(ToshLadderTreasury(u.treasury).TRIGGER_STEP(), 180e18, "a USDT step is dollars, not 0.3");
        assertEq(ToshLaunchpadHook(payable(u.hookImplementation)).PIGGYBACK_TRIGGER_STEP(), 180e18);

        // The deployer keeps nothing once the Safe accepts.
        _accept(b);
        _accept(u);
        assertEq(ToshFactory(b.factory).owner(), address(safe));
        assertEq(ToshLadderTreasury(b.treasury).owner(), address(safe));

        // The Safe can list through the deployed BNB stack.
        ToshFactory f = ToshFactory(b.factory);
        bytes32 salt = _salt(f);
        bytes memory call = abi.encodeCall(
            ToshFactory.createLaunch, ("Deployed", "DPL", dev, makeAddr("fund"), salt, 10e18, 0.1e18, 24 hours)
        );
        safe.exec(address(f), call);
        assertEq(f.launchCount(), 1);

        // ── the gateway script, before and after the handoff ───────────────
        vm.setEnv("FACTORY_ADDRESS", vm.toString(u.factory));
        DeployLaunchGateway g = new DeployLaunchGateway();
        ToshLaunchGateway gw = g.run();
        assertEq(address(gw.factory()), u.factory);
        assertEq(address(gw.safe()), address(safe));

        safe.exec(u.factory, abi.encodeCall(ToshFactory(u.factory).transferOwnership, (address(gw))));
        safe.exec(address(gw), abi.encodeCall(gw.execute, (abi.encodeWithSignature("acceptOwnership()"))));
        assertEq(ToshFactory(u.factory).owner(), address(gw));
        vm.expectRevert(bytes("the factory is not owned by PROD_OWNER_SAFE"));
        g.run();
    }

    function _checkStack(
        DeployV2.Stack memory s,
        address quote,
        bool native,
        uint256 minBuy,
        uint256 maxHardCap,
        uint256 maxAgentCap
    ) internal view {
        ToshFactory f = ToshFactory(s.factory);
        ToshLadderTreasury t = ToshLadderTreasury(s.treasury);
        ToshLaunchpadHook impl = ToshLaunchpadHook(payable(s.hookImplementation));
        assertEq(address(f.quoteAsset()), quote);
        assertEq(f.acceptsNative(), native);
        assertEq(f.minBuy(), minBuy);
        assertEq(f.maxHardCap(), maxHardCap);
        assertEq(f.maxAgentCap(), maxAgentCap);
        assertEq(f.platformTreasury(), platform);
        assertEq(f.agentRegistry(), address(registry));
        assertEq(f.hookImplementation(), s.hookImplementation);
        assertEq(impl.factory(), s.factory);
        assertEq(t.factory(), s.factory);
        assertEq(address(t.quoteAsset()), quote);
        assertEq(f.owner(), deployer, "two-step: the deployer until the Safe accepts");
        assertEq(f.pendingOwner(), address(safe));
        assertEq(t.pendingOwner(), address(safe));
        ToshLaunchGateway gw = ToshLaunchGateway(s.gateway);
        assertEq(address(gw.factory()), s.factory);
        assertEq(address(gw.safe()), address(safe));
    }

    function _accept(DeployV2.Stack memory s) internal {
        safe.exec(s.factory, abi.encodeWithSignature("acceptOwnership()"));
        safe.exec(s.treasury, abi.encodeWithSignature("acceptOwnership()"));
    }

    function _salt(ToshFactory f) internal view returns (bytes32 raw) {
        bytes32 initHash = f.hookInitcodeHash(dev, address(safe), 10e18, 1e18, 24 hours);
        for (uint256 i;; ++i) {
            raw = bytes32(i);
            address h = HookAddress.computeAddress(address(f), keccak256(abi.encode(address(safe), raw)), initHash);
            if (h.code.length == 0) return raw;
        }
    }
}
