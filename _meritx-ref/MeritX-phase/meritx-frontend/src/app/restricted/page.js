export const metadata = {
  title: 'Access Denied — MeritX Protocol',
  robots: 'noindex, nofollow',
};

export default function RestrictedPage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", monospace',
        padding: '2rem',
      }}
    >
      <div style={{ maxWidth: 560, width: '100%', textAlign: 'center' }}>
        <h1
          style={{
            color: '#ff4444',
            fontSize: 'clamp(1.8rem, 5vw, 2.8rem)',
            fontWeight: 900,
            letterSpacing: '0.25em',
            marginBottom: '2.5rem',
            lineHeight: 1.2,
          }}
        >
          ⚠️ ACCESS DENIED
        </h1>

        <div
          style={{
            border: '1px solid rgba(255, 68, 68, 0.4)',
            background: 'rgba(255, 68, 68, 0.04)',
            borderRadius: 8,
            padding: '2rem 1.5rem',
            marginBottom: '2rem',
          }}
        >
          <p
            style={{
              color: '#ff4444',
              fontSize: '0.85rem',
              lineHeight: 1.8,
              margin: 0,
              letterSpacing: '0.04em',
            }}
          >
            Pursuant to regulatory compliance and Terms of Service,
            MeritX Protocol is not available in your jurisdiction.
          </p>
        </div>

        <p
          style={{
            color: '#555',
            fontSize: '0.7rem',
            letterSpacing: '0.1em',
            margin: 0,
          }}
        >
          This geo-restriction is enforced at the network edge. (Error Code: REG-GEO-BLOCK)
        </p>
      </div>
    </div>
  );
}
