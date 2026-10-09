export type Vars = Record<string, string>;

export interface TemplateRow {
  id: string;
  name: string;
  composition_id: string;
  props: Record<string, unknown>;
  base_video_url: string | null;
  base_video_fit: 'pad' | 'crop';
  wa_template_name: string | null;
  wa_template_lang: string;
  wa_body_params: string[];
  created_at: string;
}

export interface CampaignRow {
  id: string;
  name: string;
  template_id: string;
  props: Record<string, unknown>;
  created_at: string;
}

export interface ContactRow {
  id: string;
  seq: string;
  campaign_id: string;
  name: string | null;
  phone: string;
  vars: Vars;
  created_at: string;
}

export type RenderStatus = 'queued' | 'rendering' | 'done' | 'failed';
export type MessageStatus = 'queued' | 'dry_run' | 'sent' | 'delivered' | 'read' | 'failed';

export interface RenderJobData {
  renderId: string;
}

export interface SendJobData {
  messageId: string;
}
