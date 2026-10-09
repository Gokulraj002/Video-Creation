import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Campaign, type ContactItem } from './api';

interface UploadResult {
  inserted: number;
  alreadyInCampaign: number;
  invalid: { row: number; reason: string }[];
}

export function CampaignDetail({ id, onUnauthorized }: { id: string; onUnauthorized: () => void }) {
  const [campaign, setCampaign] = useState<Campaign>();
  const [contacts, setContacts] = useState<{ total: number; items: ContactItem[] }>({ total: 0, items: [] });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string>();

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onUnauthorized();
      else setError(err instanceof Error ? err.message : String(err));
    },
    [onUnauthorized],
  );

  const load = useCallback(async () => {
    const [c, list] = await Promise.all([
      api<Campaign>(`/campaigns/${id}`),
      api<{ total: number; items: ContactItem[] }>(`/campaigns/${id}/contacts?limit=200`),
    ]);
    setCampaign(c);
    setContacts(list);
  }, [id]);

  useEffect(() => {
    load().catch(handle);
  }, [load, handle]);

  // Poll while anything is in flight
  const active = campaign
    ? campaign.renders.queued + campaign.renders.rendering + campaign.messages.queued > 0
    : false;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => load().catch(handle), 3000);
    return () => clearInterval(t);
  }, [active, load, handle]);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      setNotice(await action());
      await load();
    } catch (err) {
      handle(err);
    } finally {
      setBusy(false);
    }
  }

  const uploadCsv = (file: File) =>
    run(async () => {
      const form = new FormData();
      form.append('file', file);
      const r = await api<UploadResult>(`/campaigns/${id}/contacts`, { method: 'POST', body: form });
      const invalid = r.invalid.length
        ? ` ${r.invalid.length} skipped: ${r.invalid.slice(0, 5).map((i) => `row ${i.row} ${i.reason}`).join('; ')}`
        : '';
      return `Added ${r.inserted} contacts (${r.alreadyInCampaign} already in campaign).${invalid}`;
    });

  const render = (body: { limit?: number; force?: boolean }) =>
    run(async () => {
      const r = await api<{ queued: number }>(`/campaigns/${id}/render`, { method: 'POST', json: body });
      return `Queued ${r.queued} renders.`;
    });

  const send = (retryFailed: boolean) => {
    if (!campaign) return;
    const ok = window.confirm(
      retryFailed
        ? 'Retry all failed WhatsApp messages?'
        : `Send WhatsApp videos to every rendered contact (${campaign.renders.done})? This cannot be undone.`,
    );
    if (!ok) return;
    void run(async () => {
      const r = await api<{ queued: number }>(`/campaigns/${id}/send`, { method: 'POST', json: { retryFailed } });
      return `Queued ${r.queued} messages.`;
    });
  };

  if (!campaign) return <div className="card">{error ? <p className="error">{error}</p> : 'Loading...'}</div>;

  const { renders: r, messages: m } = campaign;

  return (
    <>
      <div className="card">
        <a href="#/" className="muted">
          ← All campaigns
        </a>
        <h2>{campaign.name}</h2>
        <p className="muted">Template: {campaign.template_name}</p>
        <div className="stats">
          <Stat label="Contacts" value={campaign.contacts} />
          <Stat label="Rendering" value={r.queued + r.rendering} />
          <Stat label="Rendered" value={r.done} />
          <Stat label="Render failed" value={r.failed} bad />
          <Stat label="Sent" value={m.sent + m.delivered + m.read} />
          <Stat label="Delivered" value={m.delivered + m.read} />
          <Stat label="Read" value={m.read} />
          <Stat label="Dry run" value={m.dry_run} />
          <Stat label="Send failed" value={m.failed} bad />
        </div>
      </div>

      <div className="card">
        <h3>1. Upload contacts</h3>
        <p className="muted">
          CSV with a <code>phone</code> column (or mobile / whatsapp), optional <code>name</code>. Every other column
          (city, offer, ...) is usable in the template as <code>{'{city}'}</code>.
        </p>
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadCsv(f);
            e.target.value = '';
          }}
        />

        <h3>2. Render videos</h3>
        <div className="row">
          <button disabled={busy || !campaign.contacts} onClick={() => render({ limit: 3 })}>
            Render 3 previews
          </button>
          <button disabled={busy || !campaign.contacts} onClick={() => render({})}>
            Render all
          </button>
          <button className="secondary" disabled={busy || !r.done} onClick={() => render({ force: true })}>
            Re-render everything
          </button>
        </div>

        <h3>3. Send on WhatsApp</h3>
        <div className="row">
          <button disabled={busy || !r.done} onClick={() => send(false)}>
            Send to rendered contacts
          </button>
          <button className="secondary" disabled={busy || !m.failed} onClick={() => send(true)}>
            Retry failed
          </button>
        </div>

        {notice ? <p className="notice">{notice}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </div>

      {preview ? (
        <div className="card preview">
          <video src={preview} controls autoPlay />
          <button className="secondary" onClick={() => setPreview(undefined)}>
            Close preview
          </button>
        </div>
      ) : null}

      <div className="card">
        <h3>
          Contacts{' '}
          <span className="muted">
            ({contacts.items.length} of {contacts.total})
          </span>
        </h3>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Video</th>
              <th>WhatsApp</th>
            </tr>
          </thead>
          <tbody>
            {contacts.items.map((c) => (
              <tr key={c.id}>
                <td>{c.name ?? '-'}</td>
                <td>{c.phone}</td>
                <td>
                  <Badge status={c.render_status} title={c.render_error} />
                  {c.video_url ? (
                    <button className="link" onClick={() => setPreview(c.video_url!)}>
                      Play
                    </button>
                  ) : null}
                </td>
                <td>
                  <Badge status={c.message_status} title={c.message_error} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Stat({ label, value, bad }: { label: string; value: number; bad?: boolean }) {
  return (
    <div className={`stat${bad && value ? ' bad' : ''}`}>
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

function Badge({ status, title }: { status: string | null; title: string | null }) {
  if (!status) return <span className="muted">-</span>;
  return (
    <span className={`badge ${status}`} title={title ?? undefined}>
      {status.replace('_', ' ')}
    </span>
  );
}
