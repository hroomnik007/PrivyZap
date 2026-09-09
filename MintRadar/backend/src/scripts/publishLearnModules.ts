// One-time script: publish the 5 MintRadar Learn modules as NIP-23 long-form
// Nostr articles (kind:30023), identifiers "mintradar-learn-module-1"…"-5".
//
// Content is parsed directly from the live frontend source
// (../../../src/pages/learn/Module1.tsx…Module5.tsx) — NOT from a separate
// markdown draft. An earlier version of this script read
// learn-content-draft.md, but that file was a one-off snapshot that drifted
// out of sync with the JSX almost immediately (and has since been deleted).
// Parsing the .tsx directly means this script can never publish stale
// content — whatever's live in the app is what gets published.
//
// The parser only understands the small set of JSX tags actually used
// across the 5 modules (h3, p, ul/ol/li, strong/em/code, <a>/<Link>,
// <KeyTakeaway>, and self-closing diagram components like
// <TokenFlowDiagram />). If a module starts using something outside that
// vocabulary, extend convertInline()/extractBlocks() rather than silently
// dropping content — the assertions below (single <div>, h1 matching the
// hardcoded title) are there to catch drift loudly instead of publishing
// something wrong.
//
// SAFETY: publishing to Nostr relays is public and effectively irreversible
// (relays may retain the event indefinitely). This script defaults to a dry
// run that only prints what it would publish. Nothing is sent to a relay
// unless you pass --publish explicitly:
//
//   npx tsx src/scripts/publishLearnModules.ts            # dry run (default)
//   npx tsx src/scripts/publishLearnModules.ts --print    # dry run + full converted Markdown, for review
//   npx tsx src/scripts/publishLearnModules.ts --publish  # actually publishes
//
// Requires NOTIFICATION_SERVICE_NSEC in the environment (same identity used
// for kind:0 service profile / DM notifications) — publishLongFormArticle()
// throws if it isn't set.

import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { publishLongFormArticle } from '../nostrService.js'

// Mirrors frontend/src/constants/learnModules.ts — kept manually in sync
// (same no-workspace caveat as the relay lists in nostrService.ts/discovery.ts).
// Order matters: module id -> title/summary must match LEARN_MODULES exactly,
// or the h1-match assertion below will fail loudly.
const MODULE_META = [
  {
    order: 1,
    file: 'Module1.tsx',
    title: 'Cashu Basics',
    summary: "What Cashu actually is: the mint holds your Bitcoin, you hold a bearer token, and blind signatures keep person-to-person transfers private.",
  },
  {
    order: 2,
    file: 'Module2.tsx',
    title: 'Understanding the Risks',
    summary: "Why a mint can disappear or refuse to pay, why nobody can currently verify a mint has real backing, and how to limit what you stand to lose.",
  },
  {
    order: 3,
    file: 'Module3.tsx',
    title: 'How to Choose a Mint',
    summary: "What to check before trusting a mint — uptime, NUT support, operator transparency — and how MintRadar's Trust Score combines those signals.",
  },
  {
    order: 4,
    file: 'Module4.tsx',
    title: 'Getting Started with a Wallet',
    summary: "Choosing a wallet, adding your first mint, making a deposit, sending tokens, and why backing up your seed phrase is non-negotiable.",
  },
  {
    order: 5,
    file: 'Module5.tsx',
    title: 'Safe Habits',
    summary: "Five day-to-day habits — diversifying mints, redeeming regularly, checking Trust Score first — that meaningfully reduce your risk.",
  },
] as const

interface ParsedModule {
  order: number
  title: string
  summary: string
  content: string
}

function findModulesDir(): string {
  const override = process.env['LEARN_MODULES_DIR']
  if (override) {
    if (!existsSync(override)) throw new Error(`LEARN_MODULES_DIR set but not found: ${override}`)
    return override
  }
  // backend/src/scripts -> backend/src -> backend -> MintRadar -> src/pages/learn
  const candidate = path.join(__dirname, '..', '..', '..', 'src', 'pages', 'learn')
  if (existsSync(candidate)) return candidate
  throw new Error(
    `Learn modules directory not found at ${candidate}.\n` +
    `Set LEARN_MODULES_DIR to an explicit path instead.`
  )
}

// Converts the small set of inline JSX tags used in module content into
// Nostr-friendly Markdown. Order matters: <code> is converted last so it
// still works when nested inside an already-converted <a>/<Link> (e.g.
// Module 4's `<a href="..."><code>testnut.cashu.space</code></a>`).
function convertInline(text: string): string {
  return text
    .replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**')
    .replace(/<em>([\s\S]*?)<\/em>/g, '*$1*')
    .replace(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, '[$2]($1)')
    .replace(/<Link to="([^"]+)"[^>]*>([\s\S]*?)<\/Link>/g, (_m, to: string, label: string) => `[${label}](https://mintradar.org${to})`)
    .replace(/<code>([\s\S]*?)<\/code>/g, '`$1`')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractListItems(listInner: string): string[] {
  return [...listInner.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => convertInline(m[1]!))
}

// Walks the module body in source order, converting each top-level block
// (h3/p/ul/ol/KeyTakeaway/self-closing diagram component) to Markdown.
// Deliberately does NOT try to handle arbitrary/nested JSX — see file header.
function extractBlocks(body: string): string[] {
  // Order matters: the top-level <Link> alternative must come before the
  // generic self-closing-component one so it isn't mistaken for it, and
  // must be tried even though <Link>...</Link> also gets handled by
  // convertInline() when nested inside a <p> — here it's a standalone CTA
  // element (e.g. Module 3's "Try the Best Mint Wizard" button), not text.
  const blockRe = /<h3>([\s\S]*?)<\/h3>|<ol>([\s\S]*?)<\/ol>|<ul>([\s\S]*?)<\/ul>|<KeyTakeaway>([\s\S]*?)<\/KeyTakeaway>|<Link to="([^"]+)"[^>]*>([\s\S]*?)<\/Link>|<([A-Z]\w*)\s*\/>|<p>([\s\S]*?)<\/p>/g

  const blocks: string[] = []
  let match: RegExpExecArray | null
  while ((match = blockRe.exec(body)) !== null) {
    const [, h3, ol, ul, keyTakeaway, linkTo, linkLabel, selfClosingComponent, p] = match
    if (h3 !== undefined) {
      blocks.push(`## ${convertInline(h3)}`)
    } else if (ol !== undefined) {
      blocks.push(extractListItems(ol).map((item, i) => `${i + 1}. ${item}`).join('\n'))
    } else if (ul !== undefined) {
      blocks.push(extractListItems(ul).map(item => `- ${item}`).join('\n'))
    } else if (keyTakeaway !== undefined) {
      const lines = convertInline(keyTakeaway).split(/(?<=[.!?])\s+/)
      blocks.push(['> 🔑 **Key takeaway**', '>', ...lines.map(l => `> ${l}`)].join('\n'))
    } else if (linkTo !== undefined) {
      blocks.push(`[${convertInline(linkLabel!)}](https://mintradar.org${linkTo})`)
    } else if (selfClosingComponent !== undefined) {
      blocks.push(`*(interactive diagram — best viewed at mintradar.org/learn)*`)
    } else if (p !== undefined) {
      blocks.push(convertInline(p))
    }
  }
  return blocks
}

function parseModule(meta: (typeof MODULE_META)[number], modulesDir: string): ParsedModule {
  const filePath = path.join(modulesDir, meta.file)
  const src = readFileSync(filePath, 'utf-8')

  const divCount = (src.match(/<div\b/g) ?? []).length
  if (divCount !== 1) {
    throw new Error(`${meta.file}: expected exactly one <div> in module source, found ${divCount} — parser assumes no nested divs, extend extractBlocks() if this module now has one`)
  }

  const h1Match = src.match(/<h1>([\s\S]*?)<\/h1>/)
  if (!h1Match) throw new Error(`${meta.file}: no <h1> found`)
  const parsedTitle = convertInline(h1Match[1]!)
  if (parsedTitle !== meta.title) {
    throw new Error(`${meta.file}: <h1> is "${parsedTitle}" but MODULE_META title is "${meta.title}" — update MODULE_META in this script to match`)
  }

  const openTag = '<div className="learn-content">'
  const openIdx = src.indexOf(openTag)
  const closeIdx = src.lastIndexOf('</div>')
  if (openIdx === -1 || closeIdx === -1 || closeIdx <= openIdx) {
    throw new Error(`${meta.file}: could not locate learn-content div body`)
  }
  const body = src.slice(openIdx + openTag.length, closeIdx).replace(h1Match[0]!, '')

  const content = extractBlocks(body).join('\n\n')
  if (content.length === 0) {
    throw new Error(`${meta.file}: parsed zero content blocks — parser likely doesn't recognize a tag this module uses`)
  }

  return { order: meta.order, title: meta.title, summary: meta.summary, content }
}

async function main(): Promise<void> {
  const shouldPublish = process.argv.includes('--publish')
  const shouldPrint = process.argv.includes('--print')

  const modulesDir = findModulesDir()
  const modules = [...MODULE_META].sort((a, b) => a.order - b.order).map(meta => parseModule(meta, modulesDir))

  console.log(`[publish-learn] parsed ${modules.length} modules from ${modulesDir}`)
  console.log(shouldPublish ? '[publish-learn] mode: LIVE — publishing to relays' : '[publish-learn] mode: DRY RUN (pass --publish to actually send)')
  console.log('')

  for (const mod of modules) {
    const identifier = `mintradar-learn-module-${mod.order}`
    console.log(`--- ${identifier} ---`)
    console.log(`title: ${mod.title}`)
    console.log(`summary: ${mod.summary}`)
    console.log(`content: ${mod.content.length} chars`)
    if (shouldPrint) {
      console.log('')
      console.log(mod.content)
      console.log('')
    }

    if (!shouldPublish) continue

    const { succeeded, failed } = await publishLongFormArticle({
      identifier,
      title: mod.title,
      summary: mod.summary,
      content: mod.content,
    })
    console.log(`published: ${succeeded} succeeded, ${failed} failed`)
  }

  console.log('')
  console.log(shouldPublish ? '[publish-learn] done' : '[publish-learn] dry run complete — re-run with --publish to send')
}

main().catch(err => {
  console.error('[publish-learn] failed:', err)
  process.exit(1)
})
