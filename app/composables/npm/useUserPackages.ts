/**
 * Fetch all packages for a given npm user.
 *
 * Mirrors {@link useOrgPackages} — both use the same npm registry endpoint
 * (`/-/org/<name>/package`) which accepts usernames and org names alike.
 * The only difference: unknown users return an empty list instead of a 404.
 */
export function useUserPackages(username: MaybeRefOrGetter<string>) {
  const route = useRoute()
  const { searchProvider } = useSearchProvider()
  const searchProviderValue = computed(() => {
    const p = normalizeSearchParam(route.query.p)
    if (p === 'npm' || searchProvider.value === 'npm') return 'npm'
    return 'algolia'
  })
  const { getPackagesByName } = useAlgoliaSearch()

  const asyncData = useLazyAsyncData(
    () => `user-packages:${searchProviderValue.value}:${toValue(username)}`,
    async (_nuxtApp, { signal }) => {
      const user = toValue(username)
      if (!user) {
        return emptySearchResponse()
      }

      let packageNames: string[]
      try {
        const { packages } = await $fetch<{ packages: string[]; count: number }>(
          `/api/registry/org/${encodeURIComponent(user)}/packages`,
          { signal },
        )
        packageNames = packages
      } catch {
        // Unknown user or network error — show empty state, not a 404
        return emptySearchResponse()
      }

      if (user !== toValue(username)) {
        return emptySearchResponse()
      }

      if (packageNames.length === 0) {
        return emptySearchResponse()
      }

      if (searchProviderValue.value === 'algolia') {
        try {
          const response = await getPackagesByName(packageNames)
          if (user !== toValue(username)) {
            return emptySearchResponse()
          }
          if (response.objects.length > 0) {
            return response
          }
        } catch {
          // Fall through to npm registry path
        }
      }

      const metaResults = await mapWithConcurrency(
        packageNames,
        async name => {
          try {
            return await $fetch<PackageMetaResponse>(
              `/api/registry/package-meta/${encodePackageName(name)}`,
              { signal },
            )
          } catch {
            return null
          }
        },
        10,
      )

      if (user !== toValue(username)) {
        return emptySearchResponse()
      }

      const results: NpmSearchResult[] = metaResults
        .filter((meta): meta is PackageMetaResponse => meta !== null)
        .map(metaToSearchResult)

      return {
        isStale: false,
        objects: results,
        total: results.length,
        time: new Date().toISOString(),
      } satisfies NpmSearchResponse
    },
    { default: emptySearchResponse },
  )

  return asyncData
}
