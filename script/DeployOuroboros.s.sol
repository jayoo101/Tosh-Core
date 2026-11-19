// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {OuroborosToken} from "../src/ouroboros/OuroborosToken.sol";
import {OuroborosMint} from "../src/ouroboros/OuroborosMint.sol";
import {OuroborosBidBook} from "../src/ouroboros/OuroborosBidBook.sol";
import {IPancakeV2Factory} from "../src/ouroboros/interfaces/IOuroborosExternal.sol";

/// @notice Deploys Ouroboros on BSC mainnet.
///
///   PRIVATE_KEY        deployer
///   PROD_OWNER_SAFE    treasury and pause owner (Safe)
///   OURO_L1_START      unix time L1 opens; L1 lasts 2 hours
///   OURO_L2_START      unix time L2 opens; from then a Safe signer seeds the
///                      pair with `OuroborosMint.seedPool`, which opens trading
///
/// Order: token → pair → mint → bid book → `token.wire`. Wiring is one-shot,
/// so the script finishes with nothing left for the deployer to do.
contract DeployOuroboros is Script {
    address internal constant ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address internal constant FACTORY = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address internal constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address internal constant BNB_USD_FEED = 0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE;
    address internal constant AGENT_REGISTRY = 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F;
    /// @dev The project's 2-of-3 Safe on BSC.
    address internal constant PROJECT_SAFE = 0x02DE4629129D104C63329D13A6Ca67E43db7B310;

    // Single-contract venues: every pool's tokens sit in one contract that
    // answers no per-pool getter, so the token cannot recognise them by probing.
    // Checked on chain 56 (code present, and for Infinity, `CLPoolManager.vault()`).
    // Balancer V3 and Ambient have no deployment on BSC.
    address internal constant INFINITY_VAULT = 0x238a358808379702088667322f80aC48bAd5e6c4;
    address internal constant UNISWAP_V4_POOL_MANAGER = 0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF;
    address internal constant BALANCER_V2_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address internal constant FLUID_LIQUIDITY = 0x52Aa899454998Be5b000Ad077a46Bbe360F4e497;

    struct Deployment {
        OuroborosToken token;
        address pair;
        OuroborosMint mint;
        OuroborosBidBook book;
    }

    function blockedVenues() public pure returns (address[] memory blocked) {
        blocked = new address[](4);
        blocked[0] = INFINITY_VAULT;
        blocked[1] = UNISWAP_V4_POOL_MANAGER;
        blocked[2] = BALANCER_V2_VAULT;
        blocked[3] = FLUID_LIQUIDITY;
    }

    function run() external {
        Deployment memory d = deploy(
            vm.envUint("PRIVATE_KEY"),
            vm.envAddress("PROD_OWNER_SAFE"),
            uint64(vm.envUint("OURO_L1_START")),
            uint64(vm.envUint("OURO_L2_START"))
        );
        // The site's env, ready to paste. FROM_BLOCK is the block the script
        // ran against, at or before the deployment: the indexer starts there.
        console2.log(string.concat("NEXT_PUBLIC_OURO_TOKEN=", vm.toString(address(d.token))));
        console2.log(string.concat("NEXT_PUBLIC_OURO_MINT=", vm.toString(address(d.mint))));
        console2.log(string.concat("NEXT_PUBLIC_OURO_BIDBOOK=", vm.toString(address(d.book))));
        console2.log(string.concat("NEXT_PUBLIC_OURO_PAIR=", vm.toString(d.pair)));
        console2.log(string.concat("NEXT_PUBLIC_OURO_USDT=", vm.toString(USDT)));
        console2.log(string.concat("NEXT_PUBLIC_OURO_TREASURY=", vm.toString(PROJECT_SAFE)));
        console2.log(string.concat("NEXT_PUBLIC_OURO_FROM_BLOCK=", vm.toString(block.number)));
    }

    function deploy(uint256 pk, address safe, uint64 l1Start, uint64 l2Start) public returns (Deployment memory d) {
        require(block.chainid == 56, "BSC mainnet only");
        // Owner, treasury and seeder for good (ownership cannot be renounced):
        // only the project Safe will do.
        require(safe == PROJECT_SAFE, "PROD_OWNER_SAFE is not the project Safe");
        require(safe.code.length > 0, "PROD_OWNER_SAFE holds no code");
        require(l1Start > block.timestamp, "L1 start in the past");
        require(l2Start > l1Start + 2 hours, "L2 must open after L1 closes");
        address[] memory blocked = blockedVenues();
        for (uint256 i; i < blocked.length; ++i) {
            require(blocked[i].code.length > 0, "blocked venue holds no code");
        }

        vm.startBroadcast(pk);
        d.token = new OuroborosToken(USDT, ROUTER, safe, blocked);
        // Anyone can create the pair once the token exists; taking an existing
        // one is safe because seeding skims and accounts for any donated USDT.
        d.pair = IPancakeV2Factory(FACTORY).getPair(address(d.token), USDT);
        if (d.pair == address(0)) d.pair = IPancakeV2Factory(FACTORY).createPair(address(d.token), USDT);
        d.mint = new OuroborosMint(
            OuroborosMint.Config({
                token: d.token,
                usdt: USDT,
                wbnb: WBNB,
                router: ROUTER,
                pair: d.pair,
                agentRegistry: AGENT_REGISTRY,
                bnbUsdFeed: BNB_USD_FEED,
                treasury: safe,
                owner: safe,
                l1Start: l1Start,
                l2Start: l2Start
            })
        );
        d.book = d.mint.bidBook();
        d.token.wire(address(d.mint), d.pair, l2Start);
        vm.stopBroadcast();
    }
}
