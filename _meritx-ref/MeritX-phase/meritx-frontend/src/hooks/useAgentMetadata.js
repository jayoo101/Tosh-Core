'use client';
import useSWR from 'swr';
import { fetchIPFSMetadata } from '@/lib/ipfs';

const fetcher = async (ipfsURI) => {
  const meta = await fetchIPFSMetadata(ipfsURI);
  if (!meta) return null;
  return {
    avatarUrl: meta.image || null,
    description: meta.description || '',
    socials: meta.socials || null,
    skillEndpoint: meta.skillEndpoint || null,
  };
};

/**
 * Per-component IPFS metadata loader.
 * Returns cached data instantly on subsequent renders (IPFS content is immutable).
 */
export function useAgentMetadata(ipfsURI) {
  const { data, isLoading } = useSWR(
    ipfsURI || null,
    fetcher,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      revalidateIfStale: false,
      dedupingInterval: Infinity,
      errorRetryCount: 1,
    }
  );

  return {
    avatarUrl: data?.avatarUrl ?? null,
    description: data?.description ?? '',
    socials: data?.socials ?? null,
    skillEndpoint: data?.skillEndpoint ?? null,
    isMetaLoading: isLoading && !!ipfsURI,
  };
}
