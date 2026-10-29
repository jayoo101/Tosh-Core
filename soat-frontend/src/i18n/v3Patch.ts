import type { Locale } from './locales'
import type { PartialDictionary } from './types'

/**
 * Copy whose v2 wording states a rule v3 changed: the 10,000-shelf ladder, the
 * Agent ID shelf allowance, the 80 / 19 / 1 shelf split and the 0.6 / 0.4 buy
 * tax. `getDictionary` lays it over every locale when NEXT_PUBLIC_TOSH_STACK is
 * `v3`.
 *
 * Every key here needs an `en` entry. A locale without its own v3 entry for a
 * key gets the English v3 text, never its v2 translation, which would state the
 * old numbers.
 */
export const V3_PATCH: { en: PartialDictionary } & Partial<Record<Locale, PartialDictionary>> = {
  'en': {
    apply: {
      rule3: 'Shelf mechanism: 87 % of supply sits on 10,000 fixed-price shelves from the opening price up, and a shelf only opens once the pool price has risen to it. Shelf buyers need a Binance Agent ID, with a set allowance per ID on each project. Of shelf revenue, 80 % buys the token and adds it to the pool as permanently locked liquidity, 19 % goes to the vault of the Circuit NFT your team holds and 1 % funds buyback-and-burn: your ongoing income comes only from the price going up, the same thing holders want.',
    },
    meta: {
      siteDescription: 'The fair launch for verified agents, built on PancakeSwap Infinity hooks. Binance Agent ID gated GENESIS curve, 2P open, 10,000-rung shelf ladder.',
    },
    v2: {
      shelfBlurb: 'Fixed-price supply that starts at 2× the first GENESIS price, each shelf about 0.35 % above the last. A shelf opens only while the pool trades at or above it. Binance Agent ID holders only, up to a set allowance per ID on each project.',
    },
    x: {
      featCurveBody: 'The price rises linearly from P to 1.5P across 180M tokens. 20% of every buy goes to the project fund and 80% to the launch pool.',
      featShelfBody: '10,000 fixed-price steps unlock from 2P as the pool price rises, and 80% of what they raise is added to the pool as locked liquidity. Of the pool’s 1% buy tax, 0.6% goes to the project and 0.4% to a reservoir that only buys back and burns; the sell tax is burned outright.',
      ruleShelfBody: '10,000 steps from 2P, 183,000 tokens each on a full raise and scaled down with a partial one, unlocking as the pool price rises. Binance Agent ID holders only, with a set allowance per ID on each project. 80% buys the token and locks it into the pool as liquidity, 19% to the project, 1% to the buyback reservoir.',
    },
  },
  'zh-CN': {
    apply: {
      rule3: '货架机制：87% 的供应放在从开盘价起 10,000 档固定价格的货架上，只有池子价格涨到某一档，这一档才会开放出售。货架买入需要币安 Agent ID，每个 ID 在每个项目上有固定额度。货架收入的 80% 用于买入代币并加入池子、作为永久锁定的流动性，19% 进入你团队持有的 Circuit NFT 金库，1% 用于回购销毁：项目方的持续收入只来自币价上涨，和持币用户的利益一致。',
    },
    meta: {
      siteDescription: '为认证 Agent 打造的公平发射台：币安 Agent ID 准入的 GENESIS 曲线，2P 开盘，10,000 档货架阶梯，基于 PancakeSwap Infinity hooks 构建。',
    },
    v2: {
      shelfBlurb: '固定价格的供应，从首个 GENESIS 价格的 2 倍开始，每一档比上一档高约 0.35%。只有池子价格达到或高于某一档时，这一档才开放。仅限币安 Agent ID 持有者，每个 ID 在每个项目上有固定额度。',
    },
    x: {
      featCurveBody: '在 1.8 亿枚代币内，价格从 P 线性涨到 1.5P。每笔买入的 20% 进入项目资金，80% 留给开盘池。',
      featShelfBody: '10,000 档固定价格从 2P 起，随池子价格上涨逐档开放，货架收入的 80% 加入池子、作为锁定的流动性。池子 1% 的买入税中 0.6% 归项目，0.4% 进入只用于回购销毁的储备池；卖出税直接销毁。',
      ruleShelfBody: '从 2P 起共 10,000 档，募满时每档 183,000 枚，未募满按募集比例缩小，随池子价格上涨逐档开放。仅限币安 Agent ID 持有者，每个 ID 在每个项目上有固定额度。80% 用于买入代币并锁进池子作为流动性，19% 归项目，1% 进入回购储备池。',
    },
  },
}
