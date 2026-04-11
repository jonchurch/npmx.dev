# User Profile Page: Missing Packages

## Problem Statement

User profile pages on npmx.dev silently drop packages where the user is an npm maintainer but not the repo owner. Concrete example: `express` is missing from `~jonchurch`'s profile even though he's in its maintainers list.

## Working Theory

Two layers of bug, both required to produce the symptom:

1. **Wrong Algolia query.** `useAlgoliaSearch.ts:188` filters on `owner.name:${user}`, which in the `npm-search` index resolves to *repo host owner* (or npm publisher when no repo exists) — not the maintainers list. The maintainers live in `owners[]`, which Algolia stores but doesn't expose as a filterable attribute, so any filter-based query can't reach them.

2. **No merge with the fallback.** `useUserPackages.ts:71` accepts Algolia's partial result as authoritative whenever it's non-empty; the npm-registry `maintainer:${user}` path on lines 85-111 only runs if Algolia returned exactly zero. So for any user who owns at least one repo, the maintainer-only packages are never fetched from anywhere.

---

The rest of this document is the investigation context and evidence behind the theory above.

## What npmx sends to Algolia

On the user profile page, `useUserPackages.ts` calls `searchByOwner(username)` in `useAlgoliaSearch.ts:165-215`, which uses the `algoliasearch` JS client to send (per page, paginating up to `maxResults ?? 1000` in batches of 200):

```ts
client.search({
  requests: [{
    indexName: 'npm-search',
    query: '',
    offset, length,                               // pagination
    filters: `owner.name:${ownerName}`,           // <-- the filter under scrutiny
    analyticsTags: ['npmx.dev'],
    attributesToRetrieve: ATTRIBUTES_TO_RETRIEVE,
    attributesToHighlight: [],
  }]
})
```

## What we tested

Against the public `npm-search` index (`OFCNCOG2CU` / index `npm-search`), via direct HTTP to `/1/indexes/npm-search/query`. Same endpoint the JS client uses, same `query: ''`, same `filters` string. We did **not** replicate `offset`/`length` pagination, `attributesToRetrieve`, `attributesToHighlight`, or `analyticsTags` — none of those affect which records match, only how they're returned.

**Test 1 — raw record inspection.** Fetched the `express` record to see what `owner` and `owners` actually contain:

```
owner  = { name: "expressjs", link: "https://github.com/expressjs" }
owners = [ { name: "wesleytodd" }, { name: "jonchurch" }, { name: "ctcpip" },
           { name: "ulisesgascon" }, { name: "sheplu" } ]
```

`owners` (plural) mirrors the npm maintainers list and contains `jonchurch`.

`owner` (singular) is **not** just the git repo owner — it's a derived field with a fallback chain. Verified empirically with two more records:

- `turbo-spark`: publisher=`aleclloydprobert`, repo=`github.com/graphieros/TS` → `owner.name = "graphieros"` (repo wins), `owner.link = github.com/graphieros`
- `vue-data-ui-doc`: publisher=`aleclloydprobert`, `repository: null` → `owner.name = "aleclloydprobert"` (falls back to publisher), `owner.link = npmjs.com/~aleclloydprobert`

The exact chain is confirmed below from the indexer source (see **Ground truth: `algolia/npm-search`**).

**Test 2 — `filters: "owner.name:jonchurch"`** (the query npmx sends): **14 hits**, all under `github.com/jonchurch/*` (personal repos, including `@spacejunk/*` scoped packages whose repo happens to live under jonchurch). No `express`, no `body-parser`, etc.

**Test 3 — `filters: "owners.name:jonchurch"`** (hypothetical correct filter): **0 hits, `exhaustiveNbHits: true`**. Algolia didn't error, it silently returned empty. `owners.name` is not a filterable attribute — the filter is a silent no-op.

**Test 4 — `query: "jonchurch", typoTolerance: false`** (free-text search, the approach in PR #1978): **21 hits**, and `express` is in them (with `owner.name = "expressjs"`). The only way `express` matches is via `owners[].name = "jonchurch"`. So `owners[].name` **is searchable as text** — just not filterable. This is the trick PR #1978 exploits.

Caveat: text search is noisier than a filter. The 21 hits also include `jonchurch_resume` (owner: `churchjg`, matched on package name) and a couple of `@pkgjs/*` packages unrelated to maintainership. Any approach based on text search needs in-app filtering to prune the noise.

## The three-concept model (per PR #1978)

There is no single "package owner" field. Three distinct concepts on the npm side:

1. **publisher** — `package.publisher.username` in the npm registry; the last person to publish. Single value.
2. **maintainers** — `package.maintainers[].username`; the current npm maintainer list. Many values.
3. **repo owner** — derived from `package.links.repository` URL path.

Algolia's `owner.name` is a best-effort smush of (3) → (1): repo owner if a repo exists on a recognised host, else publisher. Algolia's `owners[].name` mirrors (2). The npm registry's `author:X` search matches (1); `maintainer:X` matches (2). npmjs.org's `~user` page unions (1)+(2) and includes deprecated packages.

## Ground truth: `algolia/npm-search` source

All links below are permalinks to commit [`4736244`](https://github.com/algolia/npm-search/tree/4736244247b63a6344e517bf0a79411155a5e51a) of `algolia/npm-search`, the open-source indexer that populates the public `npm-search` index npmx queries.

### `owner.name` fallback chain (authoritative)

The `getOwner` function at [`src/formatPkg.ts:316-358`](https://github.com/algolia/npm-search/blob/4736244247b63a6344e517bf0a79411155a5e51a/src/formatPkg.ts#L316-L358):

```ts
function getOwner({ repository, lastPublisher, author }) {
  if (repository?.user) {
    if (repository.host === 'github.com')    return { name: repository.user, ...github }
    if (repository.host === 'gitlab.com')    return { name: repository.user, ...gitlab }
    if (repository.host === 'bitbucket.org') return { name: repository.user, ...bitbucket }
  }
  if (lastPublisher) return lastPublisher
  return author || null
}
```

Called at [`src/formatPkg.ts:135`](https://github.com/algolia/npm-search/blob/4736244247b63a6344e517bf0a79411155a5e51a/src/formatPkg.ts#L135) with the literal comment `// always favor the repository owner`. This is a deliberate design policy, not a bug.

Full fallback, in order:

1. `repository.user` — **but only** if `repository.host` is `github.com`, `gitlab.com`, or `bitbucket.org`.
2. `lastPublisher` — a single value (the most recent publisher), not the maintainers list.
3. `author`.

**Gap worth noting:** packages hosted on self-hosted git / gitea / sourcehut / any other host fall **past** the repo branch to `lastPublisher`. So "repo owner wins" is only true on the big three hosts.

### `owners[]` = npm maintainers

At [`src/formatPkg.ts:186`](https://github.com/algolia/npm-search/blob/4736244247b63a6344e517bf0a79411155a5e51a/src/formatPkg.ts#L186):

```ts
owners: (cleaned.owners || []).map(formatUser),
```

`cleaned` is the `nice-package` output, which renames the npm registry's `maintainers` array to `owners`. So Algolia's `owners[]` is a one-to-one mirror of `package.maintainers[]`.

### Index settings (searchable vs filterable)

From [`src/config.ts:4-27`](https://github.com/algolia/npm-search/blob/4736244247b63a6344e517bf0a79411155a5e51a/src/config.ts#L4-L27):

```ts
searchableAttributes: [
  'unordered(_popularName)',
  'name, description, keywords',
  '_searchInternal.popularAlternativeNames',
  'owner.name',     // searchable ✓
  'owners.name',    // searchable ✓
],
attributesForFaceting: [
  ...
  'searchable(owner.name)',   // filterable ✓
  // no entry for owners.name — filterable ✗
  ...
],
```

Definitive:

- **`owner.name`** is both searchable and facetable. You can `filters: "owner.name:X"` *and* it matches free-text queries.
- **`owners.name`** is searchable-only. Free-text `query: X` will match it, but `filters: "owners.name:X"` silently returns nothing.

This is precisely what our Tests 3 and 4 observed empirically, now confirmed in the config.

## Hypotheses

1. **Algolia's `owner.name` filter misses maintainer-only relationships.** Confirmed by Tests 1-3. The filter can only find packages where the user is the repo owner (or the publisher, when there's no repo). Maintainer-only packages like `express`-for-`jonchurch` are unreachable via this filter.

2. **The npm-registry fallback in `useUserPackages.ts` only fires on zero results.** Line 71 returns Algolia's response as soon as `response.objects.length > 0`. The `maintainer:${user}` path on lines 85-111 only runs when Algolia returned exactly zero. So any user who owns even one repo gets a partial Algolia list treated as authoritative, and the maintainer-only packages are never fetched.

3. **Deprecated packages are reachable only via Algolia.** PR #1978 shows the npm registry `maintainer:` / `author:` searches silently exclude deprecated packages (4 missing `dbushell` packages were all deprecated). Algolia's index retains them. So even a perfect Algolia+npm-registry merge wouldn't match npmjs.org exactly unless it specifically keeps deprecated hits from the Algolia side.

4. **Pagination caps may also be truncating results** on either path. `searchByOwner` caps at `maxResults ?? 1000` (`useAlgoliaSearch.ts:169`); the npm-registry path caps at `MAX_RESULTS = 250` (`useUserPackages.ts:5`). PR #1978's comparison table shows users like `~fb` (465 on npmjs.com) and `~pi0` (654) — the 250 cap is definitely biting for prolific maintainers.

## PR #1978 approach

Switches from `filters: "owner.name:X"` to `query: X, typoTolerance: false` (free-text search) + in-app filtering. Empirically improves coverage across all 7 tested users (see table in PR body), closes the gap with npmjs.org but doesn't fully match. Still Algolia-only, so it inherits Algolia's own coverage gaps (e.g. `@dbushell/hmmarkdown2` was missing from Algolia entirely — likely uncached new package).

PR's own endorsed long-term fix: get `algolia/npm-search` to add `owners.name` to `attributesForFaceting`, then a clean `filters: "owner.name:X OR owners.name:X"` works.

## Not yet verified

- Whether `searchWithSuggestions` (`useAlgoliaSearch.ts:298`) has the same blind spot on other surfaces (search, autocomplete).
- Whether the live `/~jonchurch` profile on npmx.dev matches the 14-hit Algolia result (end-to-end sanity check).

## Provenance

- [npmx-dev/npmx.dev#1978](https://github.com/npmx-dev/npmx.dev/pull/1978) (alex-key) — concrete comparison data, three-concept model, deprecated-package finding, text-search workaround.
- `algolia/npm-search` indexer source, commit [`4736244`](https://github.com/algolia/npm-search/tree/4736244247b63a6344e517bf0a79411155a5e51a) — authoritative ground truth for `owner` derivation and index settings.
- Earlier Claude investigation lives in surviving subagent transcripts at `~/.claude/projects/-Users-jon-Forks-npmx-dev/d3b548b0-865b-4126-9c3d-52d7a1d814f7/subagents/` — parent session JSONL is gone.
