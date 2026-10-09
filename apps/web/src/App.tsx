import { useEffect, useState } from 'react';
import { getApiKey, setApiKey } from './api';
import { CampaignDetail } from './CampaignDetail';
import { CampaignList } from './CampaignList';

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

function KeyForm({ onSave }: { onSave: () => void }) {
  const [key, setKey] = useState('');
  return (
    <form
      className="card narrow"
      onSubmit={(e) => {
        e.preventDefault();
        setApiKey(key.trim());
        onSave();
      }}
    >
      <h2>Enter API key</h2>
      <p className="muted">The ADMIN_API_KEY from your .env file.</p>
      <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="API key" autoFocus />
      <button type="submit" disabled={!key.trim()}>
        Continue
      </button>
    </form>
  );
}

export function App() {
  const hash = useHashRoute();
  const [hasKey, setHasKey] = useState(() => Boolean(getApiKey()));
  const onUnauthorized = () => setHasKey(false);
  const campaignId = /^#\/c\/([\w-]+)/.exec(hash)?.[1];

  return (
    <div className="app">
      <header>
        <a href="#/" className="logo">
          Video Campaigns
        </a>
        {hasKey ? (
          <button className="link" onClick={onUnauthorized}>
            Change key
          </button>
        ) : null}
      </header>
      <main>
        {!hasKey ? (
          <KeyForm onSave={() => setHasKey(true)} />
        ) : campaignId ? (
          <CampaignDetail id={campaignId} onUnauthorized={onUnauthorized} />
        ) : (
          <CampaignList onUnauthorized={onUnauthorized} />
        )}
      </main>
    </div>
  );
}
