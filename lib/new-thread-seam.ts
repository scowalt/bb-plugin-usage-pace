import type { BbPluginApi } from "@get-bb/plugin-sdk";

export interface NewThreadExecutionRequest {
  projectId: string;
  hostId: string | null;
  origin: string;
  originPluginId: string | null;
  parentThreadId: string | null;
  requested: { providerId: string | null; model: string | null; reasoningLevel: string | null };
  sources: { providerId: string | null; model: string | null; reasoningLevel: string | null };
}

export interface NewThreadExecutionChoice {
  providerId: string;
  model: string;
  reasoningLevel: string;
  reason: string;
}

export type NewThreadExecutionChooser = (
  request: NewThreadExecutionRequest,
  context: { signal: AbortSignal },
) => NewThreadExecutionChoice | null | Promise<NewThreadExecutionChoice | null>;

interface ChooserApi {
  experimental_chooseNewThreadExecution(chooser: NewThreadExecutionChooser): void;
}

export function hasNewThreadSeam(bb: Pick<BbPluginApi, "providers">): boolean {
  return typeof (bb.providers as Partial<ChooserApi>).experimental_chooseNewThreadExecution === "function";
}

export function registerNewThreadChooser(bb: Pick<BbPluginApi, "providers">, chooser: NewThreadExecutionChooser): void {
  (bb.providers as unknown as ChooserApi).experimental_chooseNewThreadExecution(chooser);
}
