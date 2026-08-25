'use client';

import { useState, useCallback } from 'react';
import { ipfsGatewayUrls } from '@/lib/ipfs';

/**
 * Resilient IPFS image component.
 * Automatically cycles through multiple gateways on load errors (429, 504, etc.)
 * and shows a fallback after all gateways are exhausted.
 *
 * @param {string} src - ipfs:// URI or HTTP URL
 * @param {string} alt - alt text
 * @param {React.ReactNode} fallback - fallback content when all gateways fail
 * @param {string} className - className for the <img> element
 */
export default function IpfsImage({ src, alt, fallback, className = 'w-full h-full object-cover' }) {
  const urls = ipfsGatewayUrls(src);
  const [gatewayIdx, setGatewayIdx] = useState(0);
  const [status, setStatus] = useState(urls.length > 0 ? 'loading' : 'error');

  const handleError = useCallback(() => {
    const next = gatewayIdx + 1;
    if (next < urls.length) {
      setGatewayIdx(next);
    } else {
      setStatus('error');
    }
  }, [gatewayIdx, urls.length]);

  if (status === 'error' || urls.length === 0) {
    return <>{fallback ?? <span className="text-2xl font-black text-blue-500">{(alt || '?').charAt(0)}</span>}</>;
  }

  return (
    <>
      {status === 'loading' && (
        <div className="absolute inset-0 bg-zinc-800 animate-pulse rounded-xl" />
      )}
      <img
        src={urls[gatewayIdx]}
        alt={alt || ''}
        className={className}
        onLoad={() => setStatus('loaded')}
        onError={handleError}
        style={status === 'loading' ? { opacity: 0, position: 'absolute' } : undefined}
      />
    </>
  );
}
