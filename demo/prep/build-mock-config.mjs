#!/usr/bin/env node
/**
 * Emits <projectDir>/.dex/mock-config.json for the demo run against
 * dex-ecommerce ("Eshopy").
 *
 * Why this exists when dex-ecommerce already ships a mock-config: the committed
 * one is a *regression fixture*. Its features are named "Authentication",
 * "Payments", "Final feature" and its spec dirs are `specs/mock-c1-f-001-<sha>`
 * — the literal word "mock" and a synthetic feature name would be on screen in
 * the timeline and task board, which the demo brief rules out. Same schema,
 * demo-grade content.
 *
 * Written as a generator rather than a JSON blob because every artefact the
 * mock "agent" produces is a multi-line markdown or TypeScript file, and the
 * demo depends on those reading like real agent output on camera.
 *
 * Schema authority is src/core/agent/MockConfig.ts. Notes that cost time to
 * rediscover:
 *   - writes[] need inline `content`; the `from` fixture variant was removed
 *   - every step descriptor needs a numeric `delay`
 *   - manifest feature count MUST equal dex_loop.cycles.length, or the loop
 *     asks for a cycle the script does not declare and the mock throws
 *   - verify must report passed:true, or the loop burns a fix-retry on camera
 *
 * Pacing is deliberate and differs per cycle:
 *   cycle 1  fast    storyboard 02 watches stages tick through in ~20s
 *   cycle 2  slow    storyboard 03 clicks Pause and must land *inside* a stage
 *   cycle 3  medium  runs out after the recorded sections, filling the timeline
 *
 * usage: node demo/prep/build-mock-config.mjs <projectDir>
 */
import fs from 'node:fs';
import path from 'node:path';

const projectDir = process.argv[2];
if (!projectDir) {
  console.error('usage: build-mock-config.mjs <projectDir>');
  process.exit(2);
}

const FAST = { gap: 700, specify: 1400, plan: 1600, tasks: 1300, implement: 2600, verify: 1500, learnings: 1200 };
const SLOW = { gap: 1200, specify: 4500, plan: 5500, tasks: 4500, implement: 6500, verify: 4500, learnings: 3500 };
const MED = { gap: 800, specify: 2200, plan: 2400, tasks: 2000, implement: 3200, verify: 2000, learnings: 1600 };

// ── Clarification artefacts ───────────────────────────────────────────────────

const productDomain = `# Eshopy — product domain

## Who uses this

Two distinct users with almost no overlap:

- **Shoppers** arrive from search or a category link, browse, and want to be
  checking out in under a minute. Most are not logged in when they start.
- **Store administrators** live in the back office all day and care about
  throughput: editing catalogue entries, moving orders through fulfilment, and
  seeing what is selling.

## Decisions

- Browsing and cart-building never require an account. Sign-in is deferred to
  the first checkout step, with a return URL so nothing is lost.
- A guest cart lives in the browser and merges on login. Where the same item
  exists in both carts, the higher quantity wins.
- Categories nest two levels deep. Deeper hierarchies were considered and cut —
  they complicate navigation without helping the catalogue sizes in scope.
- Filters are additive and reflected as removable chips, so a shopper can always
  see why a list is short.

## Deliberately excluded from v1

Payment provider integration, multi-currency, and subscriptions. Each pulls in
an external dependency and a compliance surface the first release does not need.
`;

const technicalDomain = `# Eshopy — technical domain

## Stack

TypeScript in strict mode across the storefront and the back office. Server-side
rendering for catalogue and product pages so search engines see real content;
client-side state only for the cart and filter interactions.

## Structure

\`\`\`
src/catalog/     product, category and variant models, search, filters
src/cart/        cart state, guest-cart merge, checkout flow
src/accounts/    registration, sessions, addresses, wishlist
src/admin/       back-office views over the same models
\`\`\`

## Constraints

- Model and query logic stay pure. Anything touching the datastore lives behind
  a repository module so catalogue and cart logic are testable without fixtures.
- Filter and sort state is encoded in the URL, so a filtered list is shareable
  and the back button behaves.
- Rating aggregates are denormalised onto the product record. Recomputing them
  per request was measured as the dominant cost on category pages.
`;

const clarified = `# Eshopy — clarified plan

## Summary

A full ecommerce storefront with a back office. Shoppers browse a nested
category tree, search and filter products, build a cart as a guest or a signed-in
customer, and check out. Administrators manage catalogue and orders.

## Features

### 1. Catalog and search

Nested categories two levels deep with product counts. Full-text search over
names and descriptions, ranked by relevance. Additive filters on price, rating
and stock, with sorting and removable filter chips. Filter state lives in the URL.

### 2. Cart and checkout

Add to cart from product and listing pages, with variant selection required
where variants exist. Guest carts persist in the browser and merge on login,
higher quantity winning. Multi-step checkout behind authentication with a
return URL.

### 3. Customer accounts

Registration with password strength feedback, lockout after five failed logins
in fifteen minutes, and single-use one-hour password resets. Account area with
profile, up to five saved addresses, order history and a wishlist.

## Constraints

- TypeScript strict mode throughout
- Server-rendered catalogue pages; client state only for cart and filters
- No payment provider, no multi-currency, no subscriptions in v1
`;

const constitution = `# Eshopy constitution

## Principles

1. **The shopper is never blocked.** Browsing, searching and cart-building work
   without an account. Authentication appears at checkout and nowhere earlier.
2. **Pure core, thin edges.** Catalogue, cart and pricing logic are pure
   functions. Datastore access lives behind repository modules.
3. **State that survives a refresh.** Filters and sort live in the URL; carts
   live in the browser until they live on the server. A reload loses nothing.
4. **Strict types, no escape hatches.** No \`any\` and no non-null assertions on
   data crossing a module boundary.
5. **Measure before denormalising.** Caches and derived columns need a recorded
   reason.

## Review gates

A feature lands with its types, its tests and its data shape in one change. A
feature that compiles but has no test is not done.
`;

// ── Artefact builders ─────────────────────────────────────────────────────────

const specDoc = (title, summary, criteria) => `# Spec — ${title}

## Summary

${summary}

## Acceptance criteria

${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## Out of scope

Anything the clarified plan excludes from v1 — payment provider integration,
multi-currency and subscriptions.
`;

const planDoc = (title, modules, decisions) => `# Plan — ${title}

## Modules

${modules.map((m) => `- \`${m.path}\` — ${m.role}`).join('\n')}

## Decisions

${decisions.map((d) => `- ${d}`).join('\n')}

## Risks

The repository modules are the only impure code. If one grows past reading and
writing its own aggregate, split it before adding another caller.
`;

const tasksDoc = (title, phases) =>
  `# Tasks — ${title}\n\n${phases
    .map(
      (p) =>
        `## Phase ${p.number}: ${p.name}\n\n**Purpose**: ${p.purpose}\n\n` +
        p.tasks.map((t) => `- [${p.done ? 'x' : ' '}] ${t.id} ${t.text}`).join('\n'),
    )
    .join('\n\n')}\n`;

// ── Cycle 1 — Catalog and search ──────────────────────────────────────────────

const CATALOG_PHASES = [
  {
    number: 1,
    name: 'Models and categories',
    purpose: 'Define the product, variant and category models and the nested category tree.',
    tasks: [
      { id: 'T001', text: 'Define Product, Variant and Category types' },
      { id: 'T002', text: 'Build the two-level category tree with product counts' },
      { id: 'T003', text: 'Add the catalogue repository behind a pure query interface' },
    ],
  },
  {
    number: 2,
    name: 'Search, filters and sort',
    purpose: 'Make the catalogue searchable and filterable, with state encoded in the URL.',
    tasks: [
      { id: 'T004', text: 'Implement relevance-ranked search over name and description' },
      { id: 'T005', text: 'Implement additive price, rating and stock filters' },
      { id: 'T006', text: 'Encode filter and sort state in the URL and restore it on load' },
      { id: 'T007', text: 'Cover search ranking and additive filtering with tests' },
    ],
  },
];

// README.md is the file the merge conflict is staged on (storyboard section 05).
//
// It has to be a file that exists in the MERGE BASE and is modified on both
// sides. An add/add collision is classified as `both_added` by
// checkpoints/_mergeHelpers.classifyUnmergedPaths, which aborts the merge as a
// non-content conflict and never reaches the resolver. Only `UU` (both
// modified) is handed off. reset.sh seeds the baseline; the run rewrites it
// here; stage-conflict.sh rewrites it differently on main.
//
// Both sides replace the whole file so the conflict is guaranteed rather than
// auto-merged by git.
const readmeAfterCatalog = `# Eshopy

Storefront for a small online shop. See \`docs/my-specs/\` for the specifications.

## Modules

- \`src/catalog/types.ts\` — Product, Variant and Category models
- \`src/catalog/search.ts\` — relevance-ranked search over name and description
- \`src/catalog/filters.ts\` — additive price, rating and stock filters

## Status

Catalog and search implemented. Cart, checkout and accounts still to come.
`;

const catalogTypes = `export type CategorySlug = string;

export interface Category {
  slug: CategorySlug;
  name: string;
  parent: CategorySlug | null;
  productCount: number;
}

export interface Variant {
  sku: string;
  label: string;
  priceCents: number;
  stock: number;
}

export interface Product {
  id: string;
  name: string;
  description: string;
  category: CategorySlug;
  variants: Variant[];
  averageRating: number;
  reviewCount: number;
}
`;

const catalogSearch = `import type { Product } from "./types.js";

export interface SearchHit {
  product: Product;
  score: number;
}

/**
 * Relevance-ranked search over name and description. A name match outweighs a
 * description match — shoppers searching "headphones" want the product called
 * Headphones before every product that merely mentions them.
 */
export function search(products: readonly Product[], query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return products.map((product) => ({ product, score: 0 }));

  const hits: SearchHit[] = [];
  for (const product of products) {
    const name = product.name.toLowerCase();
    const description = product.description.toLowerCase();
    let score = 0;
    if (name === q) score += 100;
    else if (name.startsWith(q)) score += 50;
    else if (name.includes(q)) score += 25;
    if (description.includes(q)) score += 5;
    if (score > 0) hits.push({ product, score });
  }
  return hits.sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name));
}
`;

const catalogFilters = `import type { Product } from "./types.js";

export interface Filters {
  minPriceCents?: number;
  maxPriceCents?: number;
  minRating?: number;
  inStockOnly?: boolean;
}

const lowestPrice = (p: Product): number =>
  Math.min(...p.variants.map((v) => v.priceCents));

const anyInStock = (p: Product): boolean => p.variants.some((v) => v.stock > 0);

/** Filters are additive: an absent field constrains nothing. */
export function applyFilters(products: readonly Product[], filters: Filters): Product[] {
  return products.filter((p) => {
    if (filters.minPriceCents !== undefined && lowestPrice(p) < filters.minPriceCents) return false;
    if (filters.maxPriceCents !== undefined && lowestPrice(p) > filters.maxPriceCents) return false;
    if (filters.minRating !== undefined && p.averageRating < filters.minRating) return false;
    if (filters.inStockOnly && !anyInStock(p)) return false;
    return true;
  });
}

/** Round-trips through the URL so a filtered list is shareable. */
export function toSearchParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.minPriceCents !== undefined) params.set("min", String(filters.minPriceCents));
  if (filters.maxPriceCents !== undefined) params.set("max", String(filters.maxPriceCents));
  if (filters.minRating !== undefined) params.set("rating", String(filters.minRating));
  if (filters.inStockOnly) params.set("stock", "1");
  return params;
}
`;

// ── Cycle 2 — Cart and checkout ───────────────────────────────────────────────

const CART_PHASES = [
  {
    number: 1,
    name: 'Cart state and guest merge',
    purpose: 'Hold line items, survive a reload, and merge a guest cart on login.',
    tasks: [
      { id: 'T001', text: 'Define Cart and LineItem types keyed by variant SKU' },
      { id: 'T002', text: 'Implement add, remove and quantity change with stock caps' },
      { id: 'T003', text: 'Persist the guest cart in the browser' },
      { id: 'T004', text: 'Merge guest and server carts on login, higher quantity winning' },
    ],
  },
  {
    number: 2,
    name: 'Checkout flow',
    purpose: 'Take an authenticated cart through address, shipping and confirmation.',
    tasks: [
      { id: 'T005', text: 'Redirect guests to login with a return URL' },
      { id: 'T006', text: 'Validate stock for every line item before placing the order' },
      { id: 'T007', text: 'Write the order and clear the cart atomically' },
      { id: 'T008', text: 'Cover the merge rule and out-of-stock rejection with tests' },
    ],
  },
];

const cartTypes = `export interface LineItem {
  sku: string;
  quantity: number;
}

export interface Cart {
  id: string;
  items: LineItem[];
}

export type OrderStatus = "placed" | "fulfilled" | "cancelled";

export interface Order {
  id: string;
  cart: Cart;
  totalCents: number;
  status: OrderStatus;
  placedAt: string;
}
`;

const cartSrc = `import type { Cart, LineItem } from "./types.js";

export function addItem(cart: Cart, sku: string, quantity: number, stock: number): Cart {
  const existing = cart.items.find((i) => i.sku === sku);
  const capped = (want: number) => Math.min(want, stock);
  const items: LineItem[] = existing
    ? cart.items.map((i) =>
        i.sku === sku ? { ...i, quantity: capped(i.quantity + quantity) } : i,
      )
    : [...cart.items, { sku, quantity: capped(quantity) }];
  return { ...cart, items };
}

export function removeItem(cart: Cart, sku: string): Cart {
  return { ...cart, items: cart.items.filter((i) => i.sku !== sku) };
}

/**
 * Guest cart merges into the server cart on login. Where a SKU is in both, the
 * higher quantity wins — a shopper who deliberately raised the quantity as a
 * guest should not have it silently reduced by an older signed-in cart.
 */
export function mergeCarts(server: Cart, guest: Cart): Cart {
  const items = [...server.items];
  for (const g of guest.items) {
    const existing = items.find((i) => i.sku === g.sku);
    if (existing) existing.quantity = Math.max(existing.quantity, g.quantity);
    else items.push({ ...g });
  }
  return { ...server, items };
}

export function totalCents(cart: Cart, priceOf: (sku: string) => number): number {
  return cart.items.reduce((sum, i) => sum + priceOf(i.sku) * i.quantity, 0);
}
`;

const checkoutSrc = `import type { Cart, Order } from "./types.js";

export class OutOfStockError extends Error {
  readonly sku: string;
  constructor(sku: string) {
    super("OutOfStockError: " + sku + " is no longer available in the requested quantity");
    this.name = "OutOfStockError";
    this.sku = sku;
  }
}

/**
 * Stock is validated here rather than on add, because a cart can sit idle for
 * days while stock moves underneath it.
 */
export function placeOrder(
  cart: Cart,
  stockOf: (sku: string) => number,
  priceOf: (sku: string) => number,
  now: string,
): Order {
  for (const item of cart.items) {
    if (stockOf(item.sku) < item.quantity) throw new OutOfStockError(item.sku);
  }
  const totalCents = cart.items.reduce((sum, i) => sum + priceOf(i.sku) * i.quantity, 0);
  return { id: "order-" + cart.id, cart, totalCents, status: "placed", placedAt: now };
}
`;

// ── Cycle 3 — Customer accounts ───────────────────────────────────────────────

const ACCOUNT_PHASES = [
  {
    number: 1,
    name: 'Registration and sessions',
    purpose: 'Register, sign in, and survive the lockout and reset rules.',
    tasks: [
      { id: 'T001', text: 'Register with password strength scoring' },
      { id: 'T002', text: 'Lock an account after five failed logins in fifteen minutes' },
      { id: 'T003', text: 'Issue single-use password resets valid for one hour' },
    ],
  },
  {
    number: 2,
    name: 'Account area',
    purpose: 'Profile, saved addresses, wishlist and order history.',
    tasks: [
      { id: 'T004', text: 'Store up to five labelled addresses with one default' },
      { id: 'T005', text: 'Toggle wishlist entries, keeping out-of-stock items labelled' },
      { id: 'T006', text: 'List order history with status and totals' },
      { id: 'T007', text: 'Cover lockout timing and the five-address cap with tests' },
    ],
  },
];

const accountTypes = `export interface Address {
  id: string;
  label: string;
  line1: string;
  city: string;
  postcode: string;
  isDefault: boolean;
}

export interface Customer {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  addresses: Address[];
  wishlist: string[];
}
`;

const accountSrc = `import type { Address, Customer } from "./types.js";

export const MAX_ADDRESSES = 5;
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

export class AddressLimitError extends Error {
  constructor() {
    super("AddressLimitError: a customer may save at most " + MAX_ADDRESSES + " addresses");
    this.name = "AddressLimitError";
  }
}

export function addAddress(customer: Customer, address: Address): Customer {
  if (customer.addresses.length >= MAX_ADDRESSES) throw new AddressLimitError();
  const addresses = address.isDefault
    ? [...customer.addresses.map((a) => ({ ...a, isDefault: false })), address]
    : [...customer.addresses, address];
  return { ...customer, addresses };
}

/** Five failures inside the window locks the account. */
export function isLockedOut(failedAt: readonly number[], now: number): boolean {
  const recent = failedAt.filter((t) => now - t <= LOCKOUT_WINDOW_MS);
  return recent.length >= LOCKOUT_THRESHOLD;
}

export function toggleWishlist(customer: Customer, productId: string): Customer {
  const wishlist = customer.wishlist.includes(productId)
    ? customer.wishlist.filter((id) => id !== productId)
    : [...customer.wishlist, productId];
  return { ...customer, wishlist };
}
`;

// ── Cycle assembly ────────────────────────────────────────────────────────────

function cycle(featureId, title, pace, a) {
  return {
    feature: { id: featureId, title },
    stages: {
      gap_analysis: { delay: pace.gap, structured_output: { decision: 'RESUME_FEATURE' } },
      specify: { delay: pace.specify, writes: [{ path: 'specs/{feature}/spec.md', content: a.spec }] },
      plan: { delay: pace.plan, writes: [{ path: 'specs/{feature}/plan.md', content: a.plan }] },
      tasks: { delay: pace.tasks, writes: [{ path: 'specs/{feature}/tasks.md', content: a.tasksOpen }] },
      implement: {
        delay: pace.implement,
        writes: [...a.src, { path: 'specs/{feature}/tasks.md', content: a.tasksDone }],
      },
      implement_fix: { delay: 1200 },
      verify: {
        delay: pace.verify,
        structured_output: {
          passed: true,
          buildSucceeded: true,
          testsSucceeded: true,
          failures: [],
          summary: a.verifySummary,
        },
      },
      learnings: { delay: pace.learnings, structured_output: { insights: a.insights } },
      commit: { delay: 400 },
    },
  };
}

const cycles = [
  cycle('001-catalog-and-search', 'Catalog and search', FAST, {
    spec: specDoc(
      'Catalog and search',
      'Shoppers browse a two-level category tree, search products by name and description with relevance ranking, and narrow results with additive filters on price, rating and stock. Filter and sort state lives in the URL.',
      [
        'A category page lists its own products and those of its children, with a product count per category.',
        'Searching ranks an exact name match above a partial name match, and both above a description-only match.',
        'Selecting a price range and a minimum rating applies both constraints together.',
        'Reloading a filtered page restores the same filters from the URL.',
      ],
    ),
    plan: planDoc(
      'Catalog and search',
      [
        { path: 'src/catalog/types.ts', role: 'Product, Variant and Category models' },
        { path: 'src/catalog/search.ts', role: 'relevance-ranked search, pure' },
        { path: 'src/catalog/filters.ts', role: 'additive filters and URL round-trip, pure' },
      ],
      [
        'Name matches outrank description matches, because a shopper searching a product name wants that product first.',
        'Categories nest exactly two levels — deeper trees complicate navigation without helping catalogues in scope.',
        'Filter state is encoded in the URL so a filtered list is shareable and the back button behaves.',
      ],
    ),
    tasksOpen: tasksDoc('Catalog and search', CATALOG_PHASES),
    tasksDone: tasksDoc('Catalog and search', CATALOG_PHASES.map((p) => ({ ...p, done: true }))),
    src: [
      { path: 'src/catalog/types.ts', content: catalogTypes },
      { path: 'src/catalog/search.ts', content: catalogSearch },
      { path: 'src/catalog/filters.ts', content: catalogFilters },
      { path: 'README.md', content: readmeAfterCatalog },
    ],
    verifySummary:
      'Build and tests pass. Search ranking orders exact name matches first; price and rating filters compose additively and survive a URL round-trip.',
    insights: [
      {
        category: 'architecture',
        insight: 'Keeping search and filters pure let them be tested without a catalogue fixture or a datastore.',
        context: 'Catalog and search — search, filters and sort',
      },
      {
        category: 'product',
        insight: 'Encoding filter state in the URL removed the need for any client-side filter store.',
        context: 'Catalog and search — search, filters and sort',
      },
    ],
  }),

  cycle('002-cart-and-checkout', 'Cart and checkout', SLOW, {
    spec: specDoc(
      'Cart and checkout',
      'Shoppers build a cart as a guest or signed in. A guest cart persists in the browser and merges on login. Checkout runs behind authentication, validates stock, and writes an order.',
      [
        'Adding a variant already in the cart increases its quantity rather than adding a second line.',
        'Quantities are capped at available stock at the moment of adding.',
        'On login, a SKU present in both the guest and server carts ends at the higher of the two quantities.',
        'Checkout rejects the order when any line item exceeds available stock, naming the offending SKU.',
      ],
    ),
    plan: planDoc(
      'Cart and checkout',
      [
        { path: 'src/cart/types.ts', role: 'Cart, LineItem and Order models' },
        { path: 'src/cart/cart.ts', role: 'add, remove, quantity and guest-cart merge, pure' },
        { path: 'src/cart/checkout.ts', role: 'stock validation and order placement' },
      ],
      [
        'Line items are keyed by variant SKU, not product id, because price and stock live on the variant.',
        'The merge rule takes the higher quantity so a deliberate guest-side increase is never silently reduced.',
        'Stock is validated at checkout rather than on add, because a cart can sit idle while stock moves.',
      ],
    ),
    tasksOpen: tasksDoc('Cart and checkout', CART_PHASES),
    tasksDone: tasksDoc('Cart and checkout', CART_PHASES.map((p) => ({ ...p, done: true }))),
    src: [
      { path: 'src/cart/types.ts', content: cartTypes },
      { path: 'src/cart/cart.ts', content: cartSrc },
      { path: 'src/cart/checkout.ts', content: checkoutSrc },
    ],
    verifySummary:
      'Build and tests pass. Guest-cart merge takes the higher quantity per SKU; checkout rejects an out-of-stock line item by name.',
    insights: [
      {
        category: 'correctness',
        insight: 'Validating stock at checkout rather than on add avoided a cart that silently goes stale.',
        context: 'Cart and checkout — checkout flow',
      },
      {
        category: 'architecture',
        insight: 'Passing a price lookup into totalCents kept cart logic independent of the catalogue module.',
        context: 'Cart and checkout — cart state and guest merge',
      },
    ],
  }),

  cycle('003-customer-accounts', 'Customer accounts', MED, {
    spec: specDoc(
      'Customer accounts',
      'Customers register, sign in, and manage a profile, saved addresses, a wishlist and their order history. Failed logins lock the account; password resets are single-use and time-limited.',
      [
        'Five failed logins within fifteen minutes lock the account for thirty minutes.',
        'A password reset link works once and expires one hour after it is issued.',
        'A customer may save at most five addresses, exactly one of which is the default.',
        'Marking a new address as default clears the flag on the previous one.',
      ],
    ),
    plan: planDoc(
      'Customer accounts',
      [
        { path: 'src/accounts/types.ts', role: 'Customer and Address models' },
        { path: 'src/accounts/accounts.ts', role: 'address rules, lockout window and wishlist, pure' },
      ],
      [
        'Lockout is computed from a list of failure timestamps rather than a counter, so the fifteen-minute window is a filter and not a scheduled reset.',
        'The address cap is enforced in the domain rather than the UI, so the back office cannot bypass it.',
        'Wishlist entries survive an item going out of stock; the entry is labelled instead of removed.',
      ],
    ),
    tasksOpen: tasksDoc('Customer accounts', ACCOUNT_PHASES),
    tasksDone: tasksDoc('Customer accounts', ACCOUNT_PHASES.map((p) => ({ ...p, done: true }))),
    src: [
      { path: 'src/accounts/types.ts', content: accountTypes },
      { path: 'src/accounts/accounts.ts', content: accountSrc },
    ],
    verifySummary:
      'Build and tests pass. Lockout triggers on the fifth failure inside the window; the sixth saved address is rejected.',
    insights: [
      {
        category: 'security',
        insight: 'Deriving lockout from failure timestamps made the fifteen-minute window a filter rather than a reset job.',
        context: 'Customer accounts — registration and sessions',
      },
      {
        category: 'architecture',
        insight: 'Enforcing the address cap in the domain kept the back office from bypassing it.',
        context: 'Customer accounts — account area',
      },
    ],
  }),
];

// Spare cycles. The loop should run exactly three, one per manifest feature.
// But the mock indexes cycles by cycle *number*, not by feature, so any stage
// failure that forces a resume shifts every later cycle by one and the run ends
// by asking for a cycle the script does not declare. These two turn that from a
// crashed run into a degraded one. Reaching them means something upstream broke.
for (const [id, title] of [
  ['004-reviews-and-ratings', 'Reviews and ratings'],
  ['005-admin-back-office', 'Admin back office'],
]) {
  const phases = [
    {
      number: 1,
      name: 'Implementation',
      purpose: `Deliver ${title.toLowerCase()} against the clarified plan.`,
      tasks: [{ id: 'T001', text: `Implement ${title.toLowerCase()}` }],
    },
  ];
  cycles.push(
    cycle(id, title, MED, {
      spec: specDoc(title, `${title} for the Eshopy storefront.`, [
        `${title} is available to shoppers without a page reload.`,
      ]),
      plan: planDoc(title, [{ path: `src/${id.slice(4)}/index.ts`, role: 'entry point' }], [
        'Follows the module conventions established by the earlier features.',
      ]),
      tasksOpen: tasksDoc(title, phases),
      tasksDone: tasksDoc(title, phases.map((p) => ({ ...p, done: true }))),
      src: [{ path: `src/${id.slice(4)}/index.ts`, content: `export const feature = "${id}";\n` }],
      verifySummary: 'Build and tests pass.',
      insights: [
        { category: 'architecture', insight: 'Reused the existing module layout.', context: title },
      ],
    }),
  );
}

const manifestFeatures = [
  {
    id: 1,
    title: 'Catalog and search',
    description:
      'Nested categories with product counts, relevance-ranked search over names and descriptions, and additive price, rating and stock filters with URL-encoded state.',
  },
  {
    id: 2,
    title: 'Cart and checkout',
    description:
      'Variant-keyed cart with stock-capped quantities, guest carts that merge on login taking the higher quantity, and an authenticated checkout that validates stock before writing an order.',
  },
  {
    id: 3,
    title: 'Customer accounts',
    description:
      'Registration with password strength feedback, lockout after five failed logins in fifteen minutes, single-use hourly password resets, and an account area with addresses, wishlist and order history.',
  },
];

// ── Conflict resolver (storyboard section 05) ────────────────────────────────
//
// core/conflict-resolver.ts drives AgentRunner.runOneShot once per conflicted
// file, then re-reads the file and fails the merge if any conflict marker
// survives. Under the mock backend the reply is scripted: `editFile` writes the
// merged content, which is what a real resolver agent would have produced with
// its Edit tool.
//
// The merge below is a real merge, not a "take theirs": it keeps the run's
// module list AND the parallel work on main, reconciles the Status paragraph,
// and preserves the Contributing section that only main had.
const readmeMerged = `# Eshopy

Storefront for a small online shop. See \`docs/my-specs/\` for the specifications.

## Modules

- \`src/catalog/types.ts\` — Product, Variant and Category models
- \`src/catalog/search.ts\` — relevance-ranked search over name and description
- \`src/catalog/filters.ts\` — additive price, rating and stock filters
- \`src/admin/\` — back-office dashboard (in progress, not yet wired up)

## Status

Catalog and search implemented. Admin back office started in parallel on main.
Cart, checkout and accounts still to come.

## Contributing

Run \`npm test\` before opening a pull request.
`;

const oneShotResponses = [
  {
    // conflict-resolver.ts opens the prompt with
    // "Use the Edit tool to resolve the merge conflict in <file>."
    matchPrompt: 'resolve the merge conflict in README\\.md',
    isRegex: true,
    // Long enough that the resolver progress modal is legible on camera, short
    // enough not to stall the section.
    delayMs: 2600,
    // Left at zero deliberately. The progress modal renders "cost so far
    // $0.0000"; a scripted run genuinely costs nothing, and inventing a
    // plausible-looking figure would put a fabricated number on screen.
    cost: 0,
    finishedNormally: true,
    finalText:
      'Resolved README.md. Kept the catalogue module list from the run branch, ' +
      'preserved the admin back-office entry and the Contributing section added ' +
      'on main, and merged the two Status paragraphs into one.',
    editFile: { path: 'README.md', content: readmeMerged },
  },
];

const config = {
  prerequisites: {
    prerequisites: { delay: 600 },
    create_branch: { delay: 500 },
  },
  clarification: {
    clarification: { delay: 800 },
    clarification_product: { delay: 1600, writes: [{ path: '{goalProductDomain}', content: productDomain }] },
    clarification_technical: { delay: 1600, writes: [{ path: '{goalTechnicalDomain}', content: technicalDomain }] },
    clarification_synthesis: {
      delay: 1800,
      writes: [{ path: '{goalClarified}', content: clarified }],
      structured_output: { filesProduced: ['GOAL_clarified.md'] },
    },
    constitution: { delay: 1400, writes: [{ path: '.specify/memory/constitution.md', content: constitution }] },
    manifest_extraction: { delay: 1500, structured_output: { features: manifestFeatures } },
  },
  dex_loop: { cycles },
  completion: { completion: { delay: 600 } },
  oneShotResponses,
};

// ── Guards ────────────────────────────────────────────────────────────────────

// MockAgentRunner.renderTemplate runs over writes[].content as well as
// writes[].path, and throws MockConfigInvalidPathError on any {token} it does
// not recognise. A TypeScript template literal like `${sku}` therefore looks
// like a substitution token and kills the stage mid-run.
//
// That failure is expensive and quiet: the stage errors, its feature never
// completes, the next cycle's gap analysis takes the RESUME branch, every
// later cycle shifts by one, and the run finally dies asking for a cycle the
// script does not declare. Cheaper to catch it here.
const ALLOWED_TOKENS = new Set([
  'specDir', 'cycle', 'feature', 'runId', 'shortRunId',
  'goalFile', 'goalProductDomain', 'goalTechnicalDomain', 'goalClarified',
]);

const offences = [];
const scan = (where, text) => {
  for (const [, token] of String(text).matchAll(/\{([a-zA-Z_]+)\}/g)) {
    if (!ALLOWED_TOKENS.has(token)) offences.push(`${where}: unknown token {${token}}`);
  }
};
const walk = (node, where) => {
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'writes' || key === 'appends') {
      for (const [i, w] of value.entries()) {
        scan(`${where}.${key}[${i}].path`, w.path);
        if (w.content !== undefined) scan(`${where}.${key}[${i}].content`, w.content);
        if (w.line !== undefined) scan(`${where}.${key}[${i}].line`, w.line);
      }
    } else if (value && typeof value === 'object') {
      walk(value, `${where}.${key}`);
    }
  }
};

if (cycles.length < manifestFeatures.length) {
  console.error(`FATAL: ${cycles.length} cycles but ${manifestFeatures.length} manifest features.`);
  console.error('The loop runs one cycle per feature and the mock indexes cycles by cycle number,');
  console.error('so it will ask for a cycle the script does not declare. Add cycles.');
  process.exit(1);
}

walk(config, 'config');
if (offences.length) {
  console.error('FATAL: mock-config contains substitution tokens the mock will reject:');
  for (const o of offences) console.error(`  ${o}`);
  console.error('\nMost likely a TypeScript template literal in generated source — write');
  console.error('string concatenation instead, or the stage dies mid-run.');
  process.exit(1);
}

const dest = path.join(projectDir, '.dex', 'mock-config.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

const totalMs = [
  ...Object.values(config.prerequisites),
  ...Object.values(config.clarification),
  ...Object.values(config.completion),
].reduce((n, d) => n + d.delay, 0)
  + cycles.reduce((n, c) => n + Object.values(c.stages).reduce((m, s) => m + s.delay, 0), 0);

console.log(`wrote ${dest}`);
console.log(`  ${cycles.length} cycles, ${manifestFeatures.length} manifest features`);
console.log(`  scripted delay total ~${(totalMs / 1000).toFixed(1)}s (excludes orchestrator overhead)`);
