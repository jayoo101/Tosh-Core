# 部署当天执行清单（BSC 56 · WBNB 新工厂）

照着从上往下做，每一步都有「看到什么才算完成」；没看到就停下，不要往下走。
为什么换 WBNB、参数怎么定的，见 `BNB_QUOTE_MIGRATION_zh.md`；这里只写命令。

上一次（BEM 工厂，2026-10-08）的执行记录在 git 历史里。这次的不同点：

- 计价资产固定为 WBNB，部署脚本和预检都拒绝其他地址；
- 新回购池**不绑定旧工厂**（`LEGACY_FACTORY_ADDRESS` 留空）：两个旧工厂都是 BEM 计价，WBNB 回购池挂不上它们的池子，所以原来的「第 11 步挂 TO」取消；
- 退役的是 BEM 工厂 `0xBCa6…7f2c`，它的 owner 是旧网关，交接批次会通过网关暂停它；
- 部署钱包**继续用** `0x35b2…874a`。它的私钥泄露过，所以从第 4 步广播到第 6 步 Safe 接受所有权之间，
  拿到私钥的人也能操作新合约。对策是第 5、6 步的 `check` 会审计这段时间两个合约的**全部事件**：
  部署、暂停、交接以外的任何操作都会报 FAIL。出现 FAIL 就放弃这套合约，换新钱包重新部署
  （新工厂还没公布、没有用户，损失只有 gas）。第 4 步之前约好两位签名人，第 4 到第 6 步之间不要停顿。

## 部署前必须先完成

| 项目 | 状态 |
|---|---|
| 合约、部署脚本、交接脚本切到 WBNB（`feat/bnb-quote`） | 已完成，`forge test` 通过 |
| 前端 18 位小数 / BNB 显示 / `depositNative` / 多旧工厂 | 代码已在分支完成；**合并并发布到 Vercel** 要在第 8 步之前 |
| PoG 签名服务：1 ETH gas → 1.3 BNB 配额 | 代码已在分支完成（随前端一起发布）；第 12 步之前必须上线 |
| 监控：新的一组盯 WBNB 新工厂，旧的一组继续盯第一代工厂 | 已完成；地址在第 9 步设置 |
| 主网 fork 全流程演练（第 3–6、10、12.5、13 步，用的就是本清单的命令；含「部署私钥在交接前动合约」演习，`check` 必须报 FAIL） | 已通过：`node scripts/rehearseRedeploy.mjs`，34/34，2026-10-10 |

固定地址：

| | 地址 |
|---|---|
| Safe（owner + 平台收款） | `0x02DE4629129D104C63329D13A6Ca67E43db7B310` |
| WBNB（计价资产） | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` |
| 退役：BEM 工厂 | `0xBCa66f7382aaC0C6EE2b833fc2072CA607367f2c`（owner 是旧网关，未暂停） |
| 退役：BEM 工厂的网关 | `0x305E16cf376f1800683C9aE5c66D99a08f107c83` |
| 退役：BEM 工厂的回购池 | `0x3009e10a696AC43465C8bdb9AFD8C989aB9cebdE` |
| 退役：第一代工厂 | `0x20dE906A96FfB89BE6fd6267A0876A68017792F7`（owner 是 Safe，已暂停） |
| 退役：第一代回购池 | `0x7105d36715e4d2bFbBEaD2B7c085e6CDE6f85a4B` |

暂停旧工厂只挡 `createLaunch` 和 `registerPoG`；旧项目的存款、退款、开池、领取照常。

2026-10-10 执行结果（第 0–12.5 步已完成）：

| | 地址 |
|---|---|
| WBNB 工厂（部署块 126796453，已解除暂停） | `0xb5D1bBB16fED6048920a78CEEd15fd00b998d362` |
| WBNB 回购池（owner 是 Safe） | `0xE5743620aBdE7A76b1683Be9f607Be6Cf5bbF83d` |
| 发射网关（工厂的 owner，`safe()` 是上面的 Safe） | `0xbD378b7A30adf3AdBcC4D6369206472232a75dD3` |
| hook 实现 | `0xfa26b461A00C1803e6b241d2F13EaCb757A70FC7` |
| CircuitNFT | `0xBEDfcBf5f3E09e627Cf8BF9a0A2F2E0466FD2888` |

`.env.production` 里的 `ETHERSCAN_API_KEY` 还是占位符，所以第 3 步和第 12.5 步都没有在 BscScan 验证源码，需要换成真 key 后补做。

---

## 第 0 步：部署钱包

用旧部署钱包 `0x35b2…874a`，`.env.production` 里的 `DEPLOYER_ADDRESS` 已经是它。
钱包里约 0.0041 BNB；上次部署用了 1727 万 gas，按 0.05 gwei 约 0.00086 BNB。
这点余额只够 gas 价在 **0.23 gwei 以下**时部署。第 4 步广播前先看一眼：

```powershell
cast gas-price --rpc-url https://bsc-dataseed.bnbchain.org
```

结果（单位 wei）超过 `200000000`（0.2 gwei）就先往这个钱包补 BNB：补到「1727 万 × gas 价」的两倍。
余额不够会在广播中途停下，只部署出一半，接下来要补钱再用 `--resume` 续传，这段时间旧私钥的风险窗口也跟着拉长。

记下预计地址（回购池用当前 nonce，工厂用当前 nonce + 1）。
⚠ 如果 `HookDeployLib` 改过、链上还没有，广播的第一笔是用固定部署器 0x4e59…956C 部署它（占掉当前 nonce），
回购池和工厂就各往后顺延一位（nonce + 1 / nonce + 2）。试跑输出里第一笔是 `Create2Deployer::create2()` 就是这种情况；
2026-10-10 那次正是这样（nonce 17 部署库，18 回购池，19 工厂），不是私钥被动过。

```powershell
$n = [int](cast nonce 0x35b232E26a275f62E594e010624aEA0c46b7874a --rpc-url https://bsc-dataseed.bnbchain.org)
cast compute-address 0x35b232E26a275f62E594e010624aEA0c46b7874a --nonce $n
cast compute-address 0x35b232E26a275f62E594e010624aEA0c46b7874a --nonce ($n + 1)
```

完成：记下两个地址（2026-10-10 时 nonce 是 17）。从这里到第 4 步，这个钱包不能发任何交易，否则预计地址会变。
如果到第 3 步试跑时地址和这里不一致，说明有人用这把私钥发过交易：停下，换新钱包。

## 第 1 步：预检

在仓库根目录（有 `foundry.toml` 的那一层）打开一个**新的** PowerShell 窗口，接下来第 2–5 步都在这个窗口里做。

```powershell
node scripts/preflightMainnet.mjs
```

完成：最后一行是全部通过、退出码 0。其中要看到：

- `5c` 是 `QUOTE_ASSET is an 18-decimal token — WBNB …`；
- `5d` 是 `LEGACY_FACTORY_ADDRESS is unset`。

## 第 2 步：载入变量和私钥

```powershell
.\scripts\deployday-step1.ps1
```

提示粘贴私钥时，粘贴 `.env.testnet-parked` 里 `PRIVATE_KEY` 那一行（旧部署钱包的私钥）。粘贴时屏幕上不显示，是正常的。

完成：看到 `same wallet`、`TARGET_CHAIN_ID is 56`、`PLATFORM_TREASURY is the owner Safe`、`QUOTE_ASSET is WBNB`、`LEGACY_FACTORY_ADDRESS is unset`，最后一行 `Step 1 done`。

## 第 3 步：试跑（不发交易）

```powershell
forge script script/DeployMainnet.s.sol:DeployMainnetScript --rpc-url $env:TARGET_RPC -vvvv
```

完成：输出里

- `Chain ID (verified) : 56`
- `Deployer : 0x35b2…874a`
- `PROD owner : 0x02DE…B310`
- `PoG Signer : 0x5756…F877`
- `Platform fee recipient : 0x02DE…B310`
- `Quote asset (WBNB) : 0xbb4C…095c`
- `Legacy factory (listable) : 0x0000…0000`
- `MAX_POG_ALLOC_WEI = 1300000000000000000`（1.3 BNB）
- `FACTORY_ADDRESS` / `TREASURY_ADDRESS` 和第 0 步的预计地址一致
- 最后是 `SIMULATION COMPLETE`

公共节点偶尔握手失败（`tls handshake eof`），重跑一次即可。

## 第 4 步：广播

```powershell
forge script script/DeployMainnet.s.sol:DeployMainnetScript --rpc-url $env:TARGET_RPC --broadcast --slow -vvvv
```

**中途断了，不要重跑，改用续传**（重跑会多部署一套）：

```powershell
forge script script/DeployMainnet.s.sol:DeployMainnetScript --rpc-url $env:TARGET_RPC --broadcast --slow --resume -vvvv
```

完成：`ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`。把地址记下来：

```powershell
$factory  = '<输出里的 FACTORY_ADDRESS>'
$treasury = '<输出里的 TREASURY_ADDRESS>'
$blk = (cast receipt (Get-Content broadcast\DeployMainnet.s.sol\56\run-latest.json -Raw | ConvertFrom-Json).receipts[0].transactionHash blockNumber --rpc-url $env:TARGET_RPC)
$blk
```

`$blk` 是部署区块，第 5、6 步的 `check` 从这里开始审计事件。`TARGET_RPC` 不支持查事件，脚本会自动改用 `bsc-rpc.publicnode.com` 查（输出里有一行 `note … logs read from`）；它只保留最近一两天的事件，所以第 6 步不要拖过一天。马上进第 5 步，再马上让签名人签第 6 步。

## 第 5 步：部署钱包立刻暂停新工厂，然后清掉私钥

```powershell
cast send $factory "pause()" --rpc-url $env:TARGET_RPC --private-key $env:PRIVATE_KEY
cast call $factory "paused()(bool)" --rpc-url $env:TARGET_RPC
node scripts/redeployTx.mjs check --factory $factory --treasury $treasury --stage deployed --deploy-block $blk
Remove-Item Env:\PRIVATE_KEY
```

完成：`paused()` 是 `true`；`check` 最后是 `all checks passed`（其中包括 `quoteAsset() is WBNB`、`TRIGGER_STEP() == 0.3 BNB`、`legacyFactory() is unset`、`has depositNative`，
以及两行 `nothing but deploy / pause / handoff before the Safe took over`）。
从这里起部署钱包的工作结束，后面都由 Safe 签。

## 第 6 步：Safe 第一批（暂停 BEM 工厂 + 接受两份所有权）

```powershell
node scripts/redeployTx.mjs handoff --factory $factory --treasury $treasury --out safe-handoff.json
```

完成：三行 `simulated as the Safe … PASS`，一行 `note first factory … already paused`，写出 `safe-handoff.json`。

然后：

1. 签名人 A 打开 [Safe](https://app.safe.global/home?safe=bnb:0x02DE4629129D104C63329D13A6Ca67E43db7B310) → Apps → **Transaction Builder**。
2. 把 `safe-handoff.json` 拖进去，确认列表里是三笔：
   - 发给旧网关 `0x305E…7c83` 的 `execute(…)`（内容是 BEM 工厂的 `pause()`）；
   - 新工厂的 `acceptOwnership()`；
   - 新回购池的 `acceptOwnership()`。
3. 点 Create batch → Send batch → Sign。
4. 签名人 B 进 Transactions → Queue → Confirm → Execute。B 的钱包里要有一点 BNB。

完成：

```powershell
node scripts/redeployTx.mjs check --factory $factory --treasury $treasury --stage handed --deploy-block $blk
$env:EXPECTED_PAUSED='true'; $env:EXPECTED_OWNER='0x02DE4629129D104C63329D13A6Ca67E43db7B310'
forge script script/VerifyDeployment.s.sol:VerifyDeploymentScript --sig "run(address)" $factory --rpc-url $env:TARGET_RPC
```

两条都通过（`all checks passed`、`ALL CHECKS PASSED`，`Paused? : true`）。`check` 里两个退役工厂都显示 `is paused`。

**这一条是旧私钥风险的关口**：Safe 接受所有权之后，部署钱包对新合约就没有任何权限了。
如果 `nothing but deploy / pause / handoff` 报 FAIL（例如出现 `PoGRegistered`、`LaunchCreated`、`pending owner set to 0x…`），
说明有人在交接前用这把私钥动过合约：不要往下走，放弃这套地址，换新钱包从第 0 步重来。

## 第 7 步：把新地址告诉我

我会更新这几个文件，并提交：

- `.env.production`：`FACTORY_ADDRESS`、`LADDER_TREASURY_ADDRESS`、`DEPLOY_BLOCK`、`HOOK_CREATION_CODEHASH`；
- `monitoring/alerts.json`：里面的地址。

这一步不发交易。

## 第 8 步：前端切到新工厂（发射入口仍然关着）

前提：18 位小数版本的前端已经合并（见「部署前必须先完成」）。

在 `soat-frontend` 目录下：

```powershell
vercel env update NEXT_PUBLIC_FACTORY_ADDRESS production --value $factory --yes
vercel env update NEXT_PUBLIC_TREASURY_ADDRESS production --value $treasury --yes
vercel env update NEXT_PUBLIC_LEGACY_FACTORY_ADDRESSES production --value "0xBCa66f7382aaC0C6EE2b833fc2072CA607367f2c,0x20dE906A96FfB89BE6fd6267A0876A68017792F7" --yes
vercel env update NEXT_PUBLIC_QUOTE_ASSET production --value 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c --yes
vercel env rm NEXT_PUBLIC_QUOTE_SYMBOL production --yes
```

- 四个变量必须在同一次 Redeploy 里一起生效：工厂换成 WBNB 工厂而计价资产还是 BEM（或反过来），
  前端会按错的小数位读金额。
- `NEXT_PUBLIC_QUOTE_SYMBOL` 删掉：WBNB 和 BEM 都在前端的已知资产表里，符号和小数位自带；
  留着旧的 `BEM` 没有作用，只会让人误会。

- `NEXT_PUBLIC_LAUNCHES_PAUSED` 保持 `1`。

然后在 Vercel → Deployments → 最新的 Production → **Redeploy**（只触发这一次）。

完成：

```powershell
$env:NEXT_PUBLIC_FACTORY_ADDRESS=$factory; npm run check:quote
```

- 上面的检查通过；
- 线上目录里两个旧工厂的项目都还在，金额仍按 BEM 显示；
- `https://toshx.xyz/api/admin/config` 返回 `globalGasToSatoRate: 1.3`、
  `pogMaxAllocWei: "1300000000000000000"`、`pogFloorWei: "25000000000000000"`。
  PoG 参数在 Upstash 里按工厂地址分开存，新工厂第一次读到的就是代码里的初始值，
  不需要 Safe 签名去改；旧的 46.4 BEM 那组参数留在旧键里，不会被带过来；
- `/launch` 仍显示暂停；
- `/apply` 提交一条测试申请能到 Telegram 群。

## 第 9 步：监控同时盯新旧两组

前提：监控脚本已按 WBNB 改好（见「部署前必须先完成」）。

旧的一组**不动**，继续盯第一代工厂 0x20dE…：它有 10 个项目，hook 还在交易、退款、结算。
BEM 工厂 0xBCa6… 一个项目都没有，链上没有东西要盯，只需要保持暂停——第 6 步的交接批量会暂停它，
`redeployTx check` 每次都会核对它是不是暂停着。

```powershell
gh variable set MONITOR_FACTORY --body $factory
gh variable set MONITOR_TREASURY --body $treasury
gh variable set MONITOR_DEPLOY_BLOCK --body $blk
gh variable delete MONITOR_EXPECTED_GATEWAY
gh workflow run watch.yml
```

`MONITOR_EXPECTED_OWNER`（Safe）、`MONITOR_EXPECTED_POG_SIGNER` 和三个 `MONITOR_LEGACY_*` 都不用改。`MONITOR_EXPECTED_GATEWAY` 指的是旧网关，新工厂此时 owner 是 Safe，所以先删掉，第 12.5 步再设成新网关。

完成：这一轮 watch 两组都跑到。新的一组从 `$blk` 重扫，所以除了 WATCHER-06（「盯的工厂换了」），部署日自己的交易也会全部报出来，会推送到 Telegram：

- 构造函数里的 OwnershipTransferred：GOV-02 是工厂，GOV-03 是 treasury；
- `setFactory` 触发 GOV-06；
- 两笔 `transferOwnership(Safe)`：GOV-01 和 GOV-07；
- 第 5 步的暂停触发 SWITCH-01；
- 第 6 步 Safe 批量里的两笔 OwnershipTransferred：GOV-02 和 GOV-03。

在 `tosh-alerts` 里逐条核对：交易的发送方要么是部署钱包，要么是 Safe 的 owner（经 `execTransaction`）；新 owner 是 Safe。全部对上后再关闭。对不上的那一条就是真事故。

## 第 10 步：Safe 第二批（解除新工厂暂停）

```powershell
node scripts/redeployTx.mjs unpause --factory $factory --out safe-unpause.json
```

同第 6 步：拖进 Transaction Builder，签名人 A 签，签名人 B 确认并执行。

完成：

```powershell
node scripts/redeployTx.mjs check --factory $factory --treasury $treasury --stage live
Remove-Item Env:\EXPECTED_PAUSED
forge script script/VerifyDeployment.s.sol:VerifyDeploymentScript --sig "run(address)" $factory --rpc-url $env:TARGET_RPC
```

两条都通过，`Paused? : false`。

## 第 11 步：（本次取消）

上次这一步把 TO 挂到新回购池。这次新回购池是 WBNB 计价，挂不上 BEM 池子（`InvalidPoolKey`），部署时也没有绑定旧工厂。TO 继续由第一代回购池回购，BEM 工厂的项目继续由 BEM 回购池回购，都不受影响。

`redeployTx.mjs list` 只接受新工厂发射的代币，以后需要手动挂新项目时再用。

## 第 12 步：打开发射入口

前提：PoG 签名服务已经按 1 ETH gas → 1.3 BNB 上线。

```powershell
vercel env rm NEXT_PUBLIC_LAUNCHES_PAUSED production --yes
```

再在 Vercel 上 Redeploy 一次。

完成：顶栏出现「发射」；`/launch` 显示表单，并提示 owner 是多签、要用脚本发射。

## 第 12.5 步：发射网关（让三个签名人直接在网站上发射）

旧网关 `0x305E…7c83` 绑死在 BEM 工厂上，新工厂要部署一个新网关。

工厂的 `createLaunch` / `launch` 只认 owner。owner 换成 `ToshLaunchGateway` 后，Safe 的任一签名人用自己的钱包就能在 `/launch` 创建项目、在项目页开池；暂停、配额、黑名单、停铸等其余管理操作仍然只有 Safe 能做（通过网关的 `execute` 转发）。签名人名单实时读取 Safe 的 `isOwner`，Safe 增删签名人，发射权限随之变化。

1. 部署网关（任何有 BNB 的钱包都行，部署者不获得任何权限；私钥按第 2 步的方式放进 `$env:PRIVATE_KEY`，用完即删；gas 约 0.65M）：

```powershell
$env:FACTORY_ADDRESS=$factory; $env:PROD_OWNER_SAFE='0x02DE4629129D104C63329D13A6Ca67E43db7B310'
forge script script/DeployLaunchGateway.s.sol --rpc-url $env:TARGET_RPC --broadcast --verify
Remove-Item Env:\PRIVATE_KEY
```

记下输出的 `ToshLaunchGateway:` 地址，下面记作 `$gateway`。

forge 可能报 `dropped from the mempool` 和 `Total Paid: 0`，这是公共 RPC 没及时返回回执造成的误报。不要重跑，先用 `cast code $gateway` 和部署钱包的 `cast nonce` 确认是否已经上链。`--verify` 需要真的 `ETHERSCAN_API_KEY`，没有的话去掉它，之后再单独验证。

2. 生成交接批次（两笔调用、一笔 Safe 交易：`transferOwnership(gateway)` 和 `gateway.execute(acceptOwnership())`）：

```powershell
node scripts/safeLaunchTx.mjs gateway-handoff --factory $factory --gateway $gateway --out safe-gateway-handoff.json
```

同第 6 步走 Transaction Builder。

3. 执行后马上设置监控变量，否则 STATE-03 会因为 owner 变了而报警：

```powershell
gh variable set MONITOR_EXPECTED_GATEWAY --body $gateway
```

`MONITOR_EXPECTED_OWNER` 保持 Safe 不变：监控会同时核对「工厂 owner = 网关」和「网关的 Safe = 这个 Safe」。

完成：

```powershell
cast call $factory "owner()(address)" --rpc-url $env:TARGET_RPC
cast call $gateway "canLaunch(address)(bool)" 0x签名人地址 --rpc-url $env:TARGET_RPC
```

第一条显示网关地址，第二条显示 `true`。签名人连上 `/launch` 后按钮可用，网关创建的项目，发射后同一个钱包就能签名发布资料。

撤回网关：Safe 调 `gateway.execute(transferOwnership(Safe))`，再由 Safe 调工厂的 `acceptOwnership()`，并删除 `MONITOR_EXPECTED_GATEWAY`。

## 第 13 步：第一个项目

做完第 12.5 步后，直接用签名人钱包在 `/launch` 填表发射即可；下面的脚本仍可用，会自动识别网关、把交易发给网关。金额单位是 BNB，脚本从工厂的 `quoteAsset()` 读小数位。

例：不设硬顶、单地址 1.3 BNB、24 小时。

```powershell
node scripts/safeLaunchTx.mjs create --factory $factory --name "项目名" --symbol "TICKER" --developer 0x开发者地址 --hard-cap none --wallet-cap 1.3 --duration 24h --out safe-create.json
```

- 要设硬顶就把 `none` 换成 BNB 数量，1–500。
- 脚本会先模拟，全部 PASS 才写文件。
- 文件同样走 Safe Transaction Builder。

募资结束后开池：

```powershell
node scripts/safeLaunchTx.mjs launch --factory $factory --hook 0x钩子地址 --out safe-launch.json
```

开池后第一笔池内买单之前，回购阶梯的第 0 档暂时高于上限（18 位小数下现价略低于 p0 的取整结果，属于已知设计），第一笔买单后恢复正常。

---

## 回退

| 做到哪一步 | 能否回退 | 怎么做 |
|---|---|---|
| 第 4 步之前 | 完全可以 | 什么都不用做 |
| 第 4–7 步 | 可以 | 新合约放着不用；BEM 工厂已暂停的话，Safe 调旧网关 `execute(unpause())` |
| `check` 事件审计 FAIL | 可以 | 同上；换新钱包（`cast wallet new`）从第 0 步重新部署 |
| 第 8–10 步 | 可以 | 把 Vercel 三个变量改回旧值再 Redeploy；新工厂上还没有项目 |
| 第 13 步之后 | 不能 | 新钩子不可变，存款人已经进来 |

## 收尾

部署完成后：

- 部署钱包 `0x35b2…874a` 继续保留。交接完成后它对新合约没有任何权限；网关的部署者也不获得权限，
  所以第 12.5 步同样可以用它。不要再让它持有任何合约的 owner 身份，余额保持在够付 gas 的水平；
- `.env.testnet-parked` 里是旧部署钱包的私钥，确认测试网不再需要后删除。
