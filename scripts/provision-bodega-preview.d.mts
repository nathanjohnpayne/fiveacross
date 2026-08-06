export interface BodegaPreviewDay {
  date: string;
  title: string;
  emoji?: string;
}

export interface BodegaPreview {
  eventName: string;
  dateRange: string;
  hostedBy: string;
  days: BodegaPreviewDay[];
}

export interface BodegaHostnameRead {
  host: string;
  data: Record<string, unknown> | null;
}

export interface BodegaPreviewPlan {
  updates: string[];
  alreadyCorrect: string[];
}

export const BODEGA_EVENT_ID: string;
export const BODEGA_PROJECT_ID: string;
export const BODEGA_PREVIEW_HOSTS: readonly string[];
export const BODEGA_EVENT_PREVIEW: BodegaPreview;
export function planBodegaPreviewProvisioning(hostDocs: Iterable<BodegaHostnameRead>): BodegaPreviewPlan;
export function formatBodegaPreviewPlan(plan: BodegaPreviewPlan): string;
