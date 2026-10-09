import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Campaign, type Template } from './api';

export function CampaignList({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', templateId: '', brandName: '', brandColor: '#4f46e5' });

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onUnauthorized();
      else setError(err instanceof Error ? err.message : String(err));
    },
    [onUnauthorized],
  );

  useEffect(() => {
    Promise.all([api<Campaign[]>('/campaigns'), api<Template[]>('/templates')])
      .then(([c, t]) => {
        setCampaigns(c);
        setTemplates(t);
        setForm((f) => ({ ...f, templateId: f.templateId || t[0]?.id || '' }));
      })
      .catch(handle);
  }, [handle]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const props: Record<string, string> = { brandColor: form.brandColor };
      if (form.brandName.trim()) props.brandName = form.brandName.trim();
      const campaign = await api<Campaign>('/campaigns', {
        method: 'POST',
        json: { name: form.name.trim(), templateId: form.templateId, props },
      });
      window.location.hash = `#/c/${campaign.id}`;
    } catch (err) {
      handle(err);
    }
  }

  return (
    <>
      <form className="card" onSubmit={create}>
        <h2>New campaign</h2>
        <div className="grid">
          <label>
            Name
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </label>
          <label>
            Template
            <select value={form.templateId} onChange={(e) => setForm({ ...form, templateId: e.target.value })}>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Brand name
            <input
              value={form.brandName}
              onChange={(e) => setForm({ ...form, brandName: e.target.value })}
              placeholder="Shown at the bottom of the video"
            />
          </label>
          <label>
            Brand color
            <input
              type="color"
              value={form.brandColor}
              onChange={(e) => setForm({ ...form, brandColor: e.target.value })}
            />
          </label>
        </div>
        <button type="submit" disabled={!form.name.trim() || !form.templateId}>
          Create campaign
        </button>
        {error ? <p className="error">{error}</p> : null}
      </form>

      <div className="card">
        <h2>Campaigns</h2>
        {campaigns.length === 0 ? (
          <p className="muted">No campaigns yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Template</th>
                <th>Contacts</th>
                <th>Rendered</th>
                <th>Sent</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id}>
                  <td>
                    <a href={`#/c/${c.id}`}>{c.name}</a>
                  </td>
                  <td>{c.template_name}</td>
                  <td>{c.contacts}</td>
                  <td>{c.renders.done}</td>
                  <td>{c.messages.sent + c.messages.delivered + c.messages.read + c.messages.dry_run}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
