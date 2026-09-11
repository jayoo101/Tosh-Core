# PM-C1 — 部署日操作手册

**广播已于 2026-09-08 执行。** 本文件最初是为一次尚未发生的部署写的操作顺序;
现在它是那次已发生部署的记录,加上广播之后的流程。PM-C2 —— Safe 接受两个合约
的所有权 —— 当天完成。§§1–6 的流程保留下来,因为那就是当天实际的走法 ——
§5 的 `set -a` 正是 forge 看到 `.env.production` 而不是 `.env` 的原因 —— 而
§7 是写下这段话时的实时清单,C2 已关闭。§9 是收尾说明,好让这份文件不至于读起来
像是在交接中途断掉。

清单争论的是*做什么*和*为什么*;而在部署当天你需要的是*按什么顺序,以及我怎么
知道上一步真的成了*。这个分工至今成立:收据落地时 Gate C 就移动了,广播之后
的一切都在 §7。

下面每条命令都在 2026-09-06 对着本仓库和这台机器核对过。密钥生成的步骤在
2026-09-08 又核对了一次,因为发现 §1 里那条说明指认错了残留物。凡是有文档指令
写错的地方,这里和它的来源处都一并更正 —— 见 §6。

---

## 0. 2026-09-08 广播之后的状态

| | |
|---|---|
| 规范工厂 | `0xBa9d2E86281b988225Eca383C375215912fb20B9` —— 运行时 10,789 字节,链 4663 |
| 规范金库 | `0x99aD248dD15498957B864Fd79917F0E103Aa78F7` —— 运行时 6,035 字节。互相接线:`factory.ladderTreasury()` 和 `treasury.factory()` 各自返回对方 |
| 区块 | 57400516–57400521。五笔交易,全部 `status=0x1`。产物:`broadcast/DeployMainnet.s.sol/4663/run-latest.json` |
| 所有者 Safe | `0x2953957774482efA660921df85A1E7634ccfe27A` —— 1.4.1,2-of-3,所有者集合与 `safe-owners.json` 一致,交易服务将其索引为 `1.4.1+L2`,能以约 27,674 gas 接收纯 ETH。用 `node scripts/verifyOwnerSafe.mjs <addr>` 复核 |
| 所有权 | **移交完成。** 两个合约上 `owner()` 都是 Safe `0x2953957774482efA660921df85A1E7634ccfe27A`,`pendingOwner()` 都是零地址。PM-C2 在交易 `0x002ad51544aa6b7377d689bf30f4822e45278a882887bf1fa6f363a95ed4b3eb`、区块 57455937 关闭。部署者 EOA 已不再控制任何一个规范合约。见 §9 与 `SECURITY_AUDIT.md` §5.26 |
| `.env.production` | 四个值都已填入规范数据:`FACTORY_ADDRESS`、`LADDER_TREASURY_ADDRESS`、`DEPLOY_BLOCK=57400516`,以及 `HOOK_CREATION_CODEHASH=0xc43a20c9…41b4d139` 与 `LIVE_INITCODE_HASH=0x3a706af1…bd0e91ef`。这一行在 2026-09-11 之前一直写着后两个"还是 `0x`,那是 PM-C6" —— 那句话在两个哈希被填进去之后就过期了,而这个文件是 gitignore 的,所以没有任何守卫会注意到 |
| C1 成本 | **9,353,658 gas。** 收据在金库 create 上付了 0.28205 gwei,其余四笔付 0.28461 gwei,合计 **0.0026585890501 ETH**。本文件曾按 46630 演练重新加总预测为 14,580,627 gas —— 高了 56%。由此得出的约 0.0117 ETH(2 倍)资金指引因此是朝保守方向偏的 |
| 部署者 | `0x4E41CEa950cF40FA59774B409988D6F9F399E690`,C1 结束时 nonce 11,现在 12 —— 多出的那笔是下一行里那个孤儿 `pause()`。`0x73db078f…` 仍然是**测试网**部署者,§4.1 禁止复用它 |
| 孤儿对 | 链上存在一套更早的完整部署,而本仓库里没有它的 `run-*.json`。工厂 `0x96a2A0f43225184d4C47A47Ed8d919233f5c1aBF`,金库 `0xbA6c032d0FAacd2A11B86Da7D3c82fbbba1ce4D4`。那个孤儿工厂已由部署者在交易 `0x1cb660941cbaef807c6575d2512eaaa7d3b395751dc4f093d05006bde6f04404` 中暂停;`paused()` 为 `true`,`createLaunch` 已死。两个孤儿的 `owner()` 仍是那把已销毁的部署者密钥,`pendingOwner()` 仍是 Safe。原计划的"部署者放弃再销毁"路径未发送(部署者 nonce 12)。现在选定的补救是一笔 Safe 接受后放弃的 MultiSend;已于 2026-09-08 构建并验证,**未执行**(Safe nonce 仍为 1)。见 `SECURITY_AUDIT.md` §5.25、§5.26 和 §5.31 |

## 1. 生成部署者 EOA

在一个编辑器不托管的终端里做:从开始菜单打开的 PowerShell 或 Windows Terminal
窗口,**不是** Cursor 的集成终端。这台机器上的 `cast` 是 1.7.1,已在 PATH 中。

```powershell
cd C:\Users\Administrator\Desktop\Tosh-Core_Workspace\Tosh-Core
$out  = cast wallet new
$addr = ($out | Select-String 'Address:').ToString().Split()[-1]
$key  = ($out | Select-String 'Private key:').ToString().Split()[-1]
(Get-Content .env.production) -replace '^PRIVATE_KEY=.*', "PRIVATE_KEY=$key" | Set-Content .env.production
Write-Host "deployer address: $addr"
Remove-Variable key
```

这段代码把密钥直接写进 `.env.production`,只回显地址。密钥从不显示。

这一把确实必须存在本地文件里:`script/DeployMainnet.s.sol:97` 用
`vm.envUint("PRIVATE_KEY")` 读它,所以加密的 keystore(`cast wallet new <path>`)
不适配这个脚本。对这个角色、且只对这个角色而言这是可接受的 —— 部署者是一个临时
身份,只签一次,并且在第 6 步 Safe 接受的那一刻就失去权力。第 2 步的 PoG 密钥是
相反的情形。

只按第 3 步说的约 **0.0117 ETH** 给它打钱,不要更多。密钥出于必要住在本地文件
里,所以余额就是暴露面。之前有一次给它打了 0.12 ETH,大约是所需的十倍。

密钥是 `cast` 打印的,不是手打的,所以它不会进入 PowerShell 的 PSReadLine 历史。
这半句是真的。但把它当作安心的理由是错的。这台机器上真正要紧的残留物不是你关掉
就没了的窗口回滚:Cursor 会持续把它托管的每个终端的输出**明文**落盘到
`.cursor/projects/<slug>/terminals/*.txt`。关窗口不会删掉那个文件,而且同一份
捕获还会把输出送进 agent 对话里。**两个 EOA 都要在那份捕获之外生成。**

**用读来验证,不要用推导。** 上面那段代码回显地址而不回显密钥,所以不需要推导 ——
用眼睛确认回显的地址不是 `0x73db078f…` 就行。如果你仍然需要推导,就从文件或环境
变量里读那把密钥;**永远不要**把它作为字面量参数传进去。见第 2 步之后的说明。
要抵抗那个显而易见的 `cast wallet address --private-key <key>`:它把一把活的
主网密钥放在了命令行上,而命令行正是 shell 历史记录的东西。活的 PoG 密钥就是这么
泄露的(`SECURITY_AUDIT.md` §5.32)。

机器侧的检查在第 4 步。`preflightMainnet.mjs` 会从 `.env.production` 的
`PRIVATE_KEY` 推导出部署者,并断言它与 PoG 签名者、Safe 和金库都不同 —— 也就是
`requireDistinctRoles` 会在广播中途做的那四条断言。

## 2. 生成 PoG 签名者 EOA

同一个不受托管的窗口。同一条规则:密钥从不显示。

```powershell
$out  = cast wallet new
$addr = ($out | Select-String 'Address:').ToString().Split()[-1]
$key  = ($out | Select-String 'Private key:').ToString().Split()[-1]
(Get-Content .env.production) -replace '^POG_SIGNER_ADDRESS=.*', "POG_SIGNER_ADDRESS=$addr" | Set-Content .env.production
$key | Set-Clipboard
Write-Host "pog signer address: $addr"
Remove-Variable key
```

这段代码把地址写进 `.env.production`,并把密钥放到剪贴板上以便粘进 Vercel。
粘完之后用 Set-Clipboard -Value ' ' 清空剪贴板。

规则和第 1 步不同,而这个不同正是关键所在:

- **地址**以 `POG_SIGNER_ADDRESS=0x…` 的形式进 `.env.production`。
- **私钥**进 Vercel Production,变量名 `POG_SIGNER_PRIVATE_KEY`,标记为
  Sensitive,作用域**仅 Production**,这样预览构建会以失败关闭 ——
  和 `BLOCKSCOUT_API_KEY` 在 2026-09-05 得到的待遇一样。
- 私钥**不写入任何本地文件**。不写 `.env`,不写 `.env.production`,不写
  `soat-frontend/.env.local`。`PRE_MAINNET_CHECKLIST.md` §4.1 把主网密钥出现
  在上述任何一处都算作切换失败。

地址和密钥来自同一次 `cast wallet new` 的输出,所以它们天生匹配。这之后没有
任何东西会检查这件事 —— `preflightMainnet.mjs` 在它的收尾行里说明了这点,而
不匹配第一次显形的地方,是发射之后每个存款人都收到 `InvalidSignature`。

**这把密钥不能是部署者。** `requireDistinctRoles` 会在角色冲突时于广播中途
revert,而今天的 `.env` 里恰好就有这个冲突,这正是第 4 步存在的理由。

**如何在不把密钥放上命令行的前提下确认一个地址。**
上面那些代码片段会回显地址。那就是检查本身。如果你仍然需要推导 —— 因为剪贴板
可能被覆盖了,或者因为你面对的是一把已经在文件里的密钥 —— 就从文件或环境变量里
读它。不要把那串十六进制粘贴成参数。

```powershell
# deployer: already in .env.production
cast wallet address --private-key ((Select-String -Path .env.production -Pattern '^PRIVATE_KEY=').Line -replace '^PRIVATE_KEY=','')

# a key that is only on the clipboard — still do not type it
$env:TMP_KEY = Get-Clipboard
cast wallet address --private-key $env:TMP_KEY
Remove-Item Env:TMP_KEY
```

PSReadLine 可以用 `Set-PSReadLineOption -AddToHistoryHandler` 抑制匹配的行。
那是按 profile 生效的,而且很容易丢。耐久的做法是压根不去键入那个字面量。
把一串 64 位十六进制作为参数传给 `cast wallet address`,就是把活的主网 PoG
密钥送进 ConsoleHost_history.txt 的那次操作(`SECURITY_AUDIT.md` §5.32)。

## 3. 给部署者打钱

往第 1 步的地址、链 **4663** 上至少发 **0.0117 ETH**,不要更多。之前有一次给
一个部署者打了 0.120292 ETH,而那把密钥随后泄露了 —— 大约是这个数字的十倍,
全部都得清扫回来。密钥出于必要住在 `.env.production` 里,所以余额就是暴露面。

这不是谁随手取的整数:它是 2026-09-06 从 46630 演练测得的
`14,580,627 gas × 0.4009 gwei` 的 2 倍。实际的 4663 运行用了
**9,353,658 gas**(见 §0),所以那个演练数字高了 56%,这个 2 倍余量是朝保守
方向偏的。gas 价格会动,而第 4 步会实时重新定价,不去信这一行。这个 2 倍是留给
检查与广播之间价格变动的余量,不是填充物,更不是打 0.12 ETH 的理由。

一次跑到一半没钱的广播,会留下 `HookDeployLib` 和金库活着而工厂缺席,或者工厂
活着但无主。这是这份清单上唯一一个发生在*不可逆步骤进行中*的故障。

## 4. 预检 —— 必须退出 0

```bash
node scripts/preflightMainnet.mjs
```

读退出码,不要读感觉:

| 退出码 | 含义 |
|---|---|
| 0 | `✓ clear for C1` —— 继续 |
| 1 | 有检查失败 —— **不要广播** |
| 2 | 无法运行。**这不是通过。** 一个跑不起来的守卫,绝不能被当成一个什么都没发现的守卫 |

如果有任何角色是从 `.env` 而不是 `.env.production` 解析出来的,检查 0b 会以 2
退出。这条检查存在的原因是:没有它的时候,这个脚本曾按测试网部署者来计算资金
缺口,并打印出 `Fund 0x73db078f…` —— 一条指名了禁用钱包的打钱指令。见
`SECURITY_AUDIT.md` §5.20。

## 5. 广播

**用 Git Bash,不要用 PowerShell**(这台机器上是
`C:\Program Files\Git\bin\bash.exe`)。那个 `set -a` 是承重的;§6 解释为什么。

```bash
cd /c/Users/Administrator/Desktop/Tosh-Core_Workspace/Tosh-Core
set -a && source .env.production && set +a

forge script script/DeployMainnet.s.sol:DeployMainnetScript \
  --rpc-url "$TARGET_RPC" \
  --broadcast \
  --verify \
  --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api \
  -vvvv
```

**走开之前先确认:** `broadcast/DeployMainnet.s.sol/4663/` 存在并且装着收据。
那个目录同时也是给 `checkStatusPage.mjs` 上膛的东西 —— 在状态页还指向测试网的
期间它会开始失败,那是 PM-C7 在告诉你轮到你了,不是回归。

关于 `--verify` 的一点后见之明,写在这里以免下一次操作者按字面理解这一步:
它**没有**验证成任何东西。Cloudflare 对那个浏览器上 `/api` 的每一条路径都回
403 拦截页,而 forge 把它报成反序列化错误。两个已验证的合约都是后来手工验证的 ——
详见 §7 第 3 条。

## 6. 旧指令错在哪

`script/DeployMainnet.s.sol` 的文件头曾写着"在 `source .env.production` 之后"。
不完整,而且当天会失败。

`source` 设置的是 shell 变量。它不导出它们,而这个脚本是通过 `vm.envUint` /
`vm.envAddress` 读**环境**的。所以没有 `set -a`,那些值压根到不了 forge。真正
到得了 forge 的是 `.env`,那个文件它会自动加载,而里面装的是测试网角色:
`TARGET_CHAIN_ID=46630`、`PLATFORM_TREASURY` 和 `POG_SIGNER_ADDRESS` 都是
`0x73db078f…`,而且完全没有 `PROD_OWNER_SAFE`。

最后那个"没有"是救了它的意外 —— `vm.envAddress` 在变量缺失时会 revert,所以
这次运行会死掉,而不是带着测试网角色部署一个真收费的工厂。**靠遗漏得来的
fail-closed 不是一种控制**,所以文件头被更正了,而不是留给运气。

下一条错的指令是 §1 里那段话:它说密钥是打印的而非键入的,所以不会进 PSReadLine
历史,而且关掉窗口就够了,因为残留物是回滚缓冲区。前半句是真的。后半句指认错了
残留物,而**一个对错误威胁精确无误的警告,读起来就是安心** —— 这和
`SECURITY_AUDIT.md` §5.20 里的 `preflightMainnet.mjs` 检查 0b、以及 §5.22 里的
`checkBlockscoutKey.mjs` 是同一个形状:一个控制,对一个已经漂移了的世界模型
充满自信。

Cursor 会把每个受托管终端的输出持久化到
`.cursor/projects/<slug>/terminals/*.txt`。关掉窗口不会删除那个文件。2026-09-08
有一位操作者在 Cursor 集成终端里逐字照着 §1 和 §2 执行,跑了两次
`cast wallet new`;两对密钥都以明文落进了那份捕获,也落进了 agent 转录。两个 EOA
都已烧毁:部署者 `0xf9D360fC5AC1045d79054a850b05F646939c3366`(在暴露被发现之前
于 4663 上被打入 0.120292 ETH,随后清扫;**2026-09-08 有 0.108286 ETH 被打回
这个地址**,至今未再清扫 —— 见 `SECURITY_AUDIT.md` §5.23),以及 PoG 签名者
`0xE7c1bCbCc5b8bB9B40F6E39C382bA94713588B7a`(余额 0)。`.env.production` 未被
触碰 —— 三行 `REPLACE_ME` 全部完好 —— 所以爆炸半径止于两对密钥和清扫的 gas。

git 历史里已经把漏掉 `set -a` 这件事称为"它里面第二条错的指令"。这是第三条,
而这份文件的存在意义恰恰是防止这件事。现在 §1 和 §2 的流程会在编辑器不托管的
终端里生成两个 EOA,把部署者密钥不回显地直接写进 `.env.production`,并把 PoG
密钥放上剪贴板供粘进 Vercel,而不是放上屏幕。

## 7. 广播之后

按顺序。每一条都是一个清单行。这是实时清单:C1 和 C2 已完成。
`checkStatusPage.mjs` 已经在失败,这是故意的 —— 那是被 `broadcast/*/4663/`
产物上膛的 PM-C7,不是坏掉的守卫。

1. **PM-C2 —— 已完成,2026-09-08。** Safe 在一笔批量交易里对工厂和阶梯金库都
   调用了 `acceptOwnership()`,交易
   `0x002ad51544aa6b7377d689bf30f4822e45278a882887bf1fa6f363a95ed4b3eb`。
   两个合约上 `owner()` 是 Safe,`pendingOwner()` 是零。部署者 EOA 已不再控制
   任何一个规范合约。复核用:

   ```bash
   forge script script/VerifyDeployment.s.sol:VerifyDeploymentScript \
     --rpc-url "$TARGET_RPC" \
     --sig 'run()' \
     -vvv
   ```

   环境里要有 `FACTORY_ADDRESS` 和 `EXPECTED_OWNER`。这个合约同时声明了
   `run()` 和 `run(address)`,所以省掉 `--sig` 会以
   "Multiple functions with the same name 'run' found in the ABI" 失败。
2. **PM-C3 —— 公布工厂地址。两道闸门都已消失:** C2 于 2026-09-08 关闭,那是
   原本的那道;而后来变成第二道的、泄露的签名者密钥已在 2026-09-09 轮换
   (`SECURITY_AUDIT.md` §5.32)。下面第 6 条早就记下了那次轮换,而这一条没有,
   于是这份清单自相矛盾了两天。仍然未做,但技术上没有任何东西在拦它。
3. **PM-C4 —— 浏览器验证。三个全部完成,而且第 5 步的 `--verify` 一个都没做成**
   —— 三个都是手工验证的。工厂在 2026-09-09 23:18:07、阶梯金库在 23:26:10,
   各自显示 "Contract source code verified (exact match)";`HookDeployLib`
   `0x873E0841…` 在 2026-09-11 02:23:12Z,`is_fully_verified` 为真、
   `is_partially_verified` 为假,即完全匹配而非剥掉 metadata 的部分匹配。
   三者都是 `v0.8.26+commit.8a97fa7a`,cancun,优化器开启 / 200 轮,`viaIR` 开启。

   `HookDeployLib` 拖到最后只是因为它此前不可见:它是第三个主网合约,而之前
   任何一次清点都不知道它的存在。`node scripts/genVerifyInput.mjs` 会写出它的
   standard-JSON 输入;这个文件必须通过浏览器上传,因为 Cloudflare 对那个浏览器
   上 `/api` 的每一条路径都回 403 拦截页,而 forge 把它报成反序列化错误。构造
   函数参数一栏留空——表单在选了 standard-JSON 之后根本不会显示这一栏,因为
   优化器、`viaIR`、EVM 版本这些设置都写在 JSON 文件内部,表单上只需要选
   license 和编译器版本。完整细节在 `PRE_MAINNET_CHECKLIST.md` 的 PM-C4。

   部署三天之后仍然能打出完全匹配,这件事本身就是可复现性的证据:它成立的
   前提是 `src/`、`foundry.toml` 和 `lib/` 的指针跟部署提交 `d0220e2` 逐字节
   一致。

   这一行现在已经关闭,但不要把它当成解决了别的问题:**Safe 不读
   Blockscout。** 工厂在 2026-09-09 傍晚就验证了,而 Safe 界面在第二天晚上仍然
   显示 "Unverified contract",所以做完这一行**并不能**解决选择器错误那个隐患。
   在 Safe 里签任何一笔交易,仍然要自己核对 calldata 的前四个字节。
4. **PM-C6 —— 已完成,2026-09-08,并于 2026-09-11 在区块 59,605,031 重新测量。**
   `RecomputeInitcodeHash.s.sol` 对着活的工厂重跑了一次,这次是在首次主网发射
   *之后*:链上的
   `HOOK_CREATION_CODEHASH`(`0xc43a20c91d0f3164cdeb07d8786c61184c105825a9edec30a8df949f41b4d139`)
   仍然等于本仓库的 `keccak256(type(ToshLaunchpadHook).creationCode)`。
   `getLiveHookInitcodeHash()` 是 `0x3a706af1817f0f630ccde8389a67d0bffd6a4744f5e4e0dc6e914bb8bd0e91ef` ——
   那是克隆的 initcode 哈希,与前者是**不同的测量**,两者本就必须不同,不要拿来
   互相比较。脚本在不匹配时会以 `HookCreationCodehashMismatch` revert,所以干净
   退出本身就是那条断言。

   这一条此前写的是"重新生成并提交",仿佛还没做。它在 2026-09-08 就做完了,
   `PRE_MAINNET_CHECKLIST.md` 的 PM-C6 行有记录。跳过它本来也不会报错:发射页
   是从链上读 `factory.hookInitcodeHash(...)` 的,两种情况都能工作,已公布的
   数字只是会静悄悄地错 —— 而这正是没人会注意到它已经做完了的原因。
5. **PM-C7 —— 前端那一半已完成,2026-09-10。** 生产环境提供的是 4663,带主网
   工厂和金库。这是从已部署的客户端 bundle 里读回来的,不是假定的:
   `NEXT_PUBLIC_*` 在构建时被内联,所以出厂的 bundle 才是"这个部署究竟指向哪里"
   的权威。站点渲染出 MAINNET 徽章和那个活着的项目。这一行存在所要抓的那种
   不匹配 —— 主网地址配测试网 chain id —— 并不存在。

   仍然未做:另一个仓库里状态页自己的 `CHAIN` 块,以及在真实部署上走一遍两段式
   PoG 流程,`/api/pog-scan` 然后 `/api/sign-allocation`。首次主网发射两者都没
   碰到。它是用 `cast` 驱动的,PoG 证明是本地用 `scripts/signPoG.mjs` 签的,
   所以这两条路由至今仍然只有单元测试和实测,从未被人在真实部署上点过一次。
6. **PM-C8 —— `treasury.addLadderToken`,但要**轮询 TWAP 成熟,不要自己算**。
   **签名前先跑 `node scripts/preflightLadderListing.mjs <token>`** —— 只读,
   不持私钥,直接告诉你能不能签,并且会说明这个 treasury 自己有没有强制这条
   规则(活体那个没有,所以脚本和读它的人就是全部控制)。
   第一次测试网上机是在发射后 52 秒挂牌的;见 `PRE_MAINNET_CHECKLIST.md` §3.2。
   ~~在活的 PoG 签名者轮换之前不要挂牌~~ —— **已于 2026-09-09 满足**,轮换已
   落地(`SECURITY_AUDIT.md` §5.32),所以这一点不再是挂牌的闸门。
7. **PM-D1 / PM-D3 —— ** D3 的笔记本副本已轮换并删除;
   `npm run check:secrets`(从 `soat-frontend/` 运行,那个脚本定义在那里)
   是 **31/31** 全绿。**D1 于 2026-09-09 关闭** —— 那把曾进入 PowerShell 历史
   的活 PoG 签名密钥已在链上、在 Vercel、在监控变量里都轮换成
   `0x9A1a8C7b…`,所以它不再是 C3 或 C8 的前置条件
   (`SECURITY_AUDIT.md` §5.32)。D3 从它那里继承了一件残留:两个仓库根文件里
   的明文 `PRIVATE_KEY`,现已都清除,而让 `check:secrets` 在此期间保持绿色的
   那两个缺口也已关闭(`PRE_MAINNET_CHECKLIST.md` §5.2)。
8. **PM-E2 —— 重新指向那一半已完成。** 四个 `MONITOR_*` GitHub 变量都持有主网
   值,2026-09-11 核对过:`MONITOR_FACTORY` 是规范工厂,`MONITOR_TREASURY` 是
   规范金库,`MONITOR_EXPECTED_OWNER` 是所有者 Safe,而
   `MONITOR_EXPECTED_POG_SIGNER` 是轮换后的 `0x9A1a8C7b…`。

   仍然未做的不是代码:**一个 P0 落地的地方仍然是一个 issue,而不是一部手机。**
   `watch.yml` 的投递汇是这一行剩下的全部内容。第一次主网巡查是瞎的 ——
   运行 34196807435 在一个包含七个 P0 治理事件的窗口里报告了 0 条日志,因为
   公共 RPC 会对密集的 `eth_getLogs` 循环限流,而 WATCHER-02 没有告警
   (`SECURITY_AUDIT.md` §5.28)。那个问题已修。

## 8. 不被上面任何一条阻塞的事

这份清单上已经没有剩下的了。PM-D4、PM-E4 和 PM-E6 是那些既不需要部署也不需要
密钥的行;它们在 2026-09-08 关闭。`INCIDENT_RESPONSE.md` §1 为 Signer #1、#2、#3
指名了加密 Signal / Telegram,handle 存在离线保险库里;事件指挥官和沟通负责人
都是部署者 / 主操作者;法务在发射时为 N/A;D1–D4 的复核触发条件由同一个人盯。
那是一次**政策上的**关闭:占位符没了,渠道有名字了。**没有人在凌晨三点被呼叫过,
以证明这个渠道真的能用。**

**Q1 的第三条判据不在这份清单上,而本文件的一个早期草稿曾把它放在这里。**
§8.3 在 2026-09-04 关闭了它:Signer #3 和 #1 在 46630 上签了全部四个 payload。
`verifyOwnerSafe.mjs` 在那之后又"唯一仍未满足的一条"打印了两天,并在与这一行
同一个提交里被更正 —— 这件事值得知道,因为本手册的 §0 就叫你去跑那个脚本。
同一个脚本后来又在 D4/E4 那些行也关闭之后,继续打印一条"仍需完成"的絮叨;
那一行也已删除。

---

## 9. 收尾 —— PM-C2 已落地

这份文件曾当作实时下一步的所有权移交,在与广播同一天、2026-09-08 完成。规范工厂
`0xBa9d2E86281b988225Eca383C375215912fb20B9` 和金库
`0x99aD248dD15498957B864Fd79917F0E103Aa78F7` 现在的 `owner()` 都是 Safe
`0x2953957774482efA660921df85A1E7634ccfe27A`,`pendingOwner()` 都是零。
链上交易 `0x002ad51544aa6b7377d689bf30f4822e45278a882887bf1fa6f363a95ed4b3eb`,
区块 57455937。单密钥窗口已关闭。§§1–6 的流程就是这次部署实际的走法;§7 仍然是
广播之后的清单,C2 已打勾。见 `SECURITY_AUDIT.md` §5.26。
