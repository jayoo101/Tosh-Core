# 部署当天执行清单（BSC 56 · WBNB 新工厂）

照着从上往下做，每一步都有「看到什么才算完成」；没看到就停下，不要往下走。
为什么换 WBNB、参数怎么定的，见 `BNB_QUOTE_MIGRATION_zh.md`；这里只写命令。

上一次（BEM 工厂，2026-10-08）的执行记录在 git 历史里。这次的不同点：

- 计价资产固定为 WBNB，部署脚本和预检都拒绝其他地址；
- 新回购池**不绑定旧工厂**（`LEGACY_FACTORY_ADDRESS` 留空）：两个旧工厂都是 BEM 计价，WBNB 回购池挂不上它们的池子，所以原来的「第 11 步挂 TO」取消；
- 退役的是 BEM 工厂 `0xBCa6…7f2c`，它的 owner 是旧网关，交接批次会通过网关暂停它；
- 换一个**全新的部署钱包**：旧部署钱包 `0x35b2…874a` 的私钥泄露过，不再使用。

## 部署前必须先完成

| 项目 | 状态 |
|---|---|
| 合约、部署脚本、交接脚本切到 WBNB（`feat/bnb-quote`） | 已完成，`forge test` 通过 |
| 前端 18 位小数 / BNB 显示 / `depositNative` / 多旧工厂 | **未完成**，第 8 步之前必须上线 |
| PoG 签名服务：1 ETH gas → 1.3 BNB 配额 | **未完成**，第 12 步之前必须上线 |
| 监控改为盯 WBNB 新工厂 + BEM 旧工厂 | **未完成**，第 9 步之前必须完成 |
| 主网 fork 全流程演练（广播 → 交接 → `VerifyDeployment` → 解除暂停 → 各阶段 `redeployTx.mjs check`） | 待重新演练 |

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

---

## 第 0 步：新部署钱包

在你自己的电脑上生成，私钥只存在你自己那里：

```powershell
cast wallet new
```

1. 把输出的地址写进 `.env.production` 的 `DEPLOYER_ADDRESS=`（私钥**不要**写进任何文件）。
2. 从你自己的钱包向这个新地址转 **0.005 BNB**。
3. 记下预计地址（新钱包 nonce 从 0 开始：回购池 nonce 0，工厂 nonce 1）：

```powershell
cast compute-address <新部署地址> --nonce 0
cast compute-address <新部署地址> --nonce 1
```

完成：

```powershell
cast balance <新部署地址> --rpc-url https://bsc-dataseed.bnbchain.org --ether
```

显示 ≥ 0.005。从这里到第 4 步，这个钱包不能发任何交易，否则预计地址会变。

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

提示粘贴私钥时，粘贴第 0 步新钱包的私钥。粘贴时屏幕上不显示，是正常的。

完成：看到 `same wallet`、`TARGET_CHAIN_ID is 56`、`PLATFORM_TREASURY is the owner Safe`、`QUOTE_ASSET is WBNB`、`LEGACY_FACTORY_ADDRESS is unset`，最后一行 `Step 1 done`。

## 第 3 步：试跑（不发交易）

```powershell
forge script script/DeployMainnet.s.sol:DeployMainnetScript --rpc-url $env:TARGET_RPC -vvvv
```

完成：输出里

- `Chain ID (verified) : 56`
- `Deployer : <新部署地址>`
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
```

## 第 5 步：部署钱包立刻暂停新工厂，然后清掉私钥

```powershell
cast send $factory "pause()" --rpc-url $env:TARGET_RPC --private-key $env:PRIVATE_KEY
cast call $factory "paused()(bool)" --rpc-url $env:TARGET_RPC
node scripts/redeployTx.mjs check --factory $factory --treasury $treasury --stage deployed
Remove-Item Env:\PRIVATE_KEY
```

完成：`paused()` 是 `true`；`check` 最后是 `all checks passed`（其中包括 `quoteAsset() is WBNB`、`TRIGGER_STEP() == 0.3 BNB`、`legacyFactory() is unset`、`has depositNative`）。
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
node scripts/redeployTx.mjs check --factory $factory --treasury $treasury --stage handed
$env:EXPECTED_PAUSED='true'; $env:EXPECTED_OWNER='0x02DE4629129D104C63329D13A6Ca67E43db7B310'
forge script script/VerifyDeployment.s.sol:VerifyDeploymentScript --sig "run(address)" $factory --rpc-url $env:TARGET_RPC
```

两条都通过（`all checks passed`、`ALL CHECKS PASSED`，`Paused? : true`）。`check` 里两个退役工厂都显示 `is paused`。

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
$blk = (cast receipt (Get-Content broadcast\DeployMainnet.s.sol\56\run-latest.json -Raw | ConvertFrom-Json).receipts[0].transactionHash blockNumber --rpc-url $env:TARGET_RPC)
gh variable set MONITOR_FACTORY --body $factory
gh variable set MONITOR_TREASURY --body $treasury
gh variable set MONITOR_DEPLOY_BLOCK --body $blk
gh variable delete MONITOR_EXPECTED_GATEWAY
gh workflow run watch.yml
```

`MONITOR_EXPECTED_OWNER`（Safe）、`MONITOR_EXPECTED_POG_SIGNER` 和三个 `MONITOR_LEGACY_*` 都不用改。`MONITOR_EXPECTED_GATEWAY` 指的是旧网关，新工厂此时 owner 是 Safe，所以先删掉，第 12.5 步再设成新网关。

完成：这一轮 watch 两组都跑到，新的一组只报预期的 WATCHER-06（「盯的工厂换了」）。

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
| 第 8–10 步 | 可以 | 把 Vercel 三个变量改回旧值再 Redeploy；新工厂上还没有项目 |
| 第 13 步之后 | 不能 | 新钩子不可变，存款人已经进来 |

## 收尾

部署完成后：

- 新部署钱包里剩下的 BNB 转回 Safe；交接完成后这把私钥对新合约没有任何权限，可以销毁；
- 旧部署钱包 `0x35b2…874a`（私钥泄露过）里的约 0.0041 BNB 转到 Safe，然后弃用；
- `.env.testnet-parked` 里是旧部署钱包的私钥，确认测试网不再需要后删除。
