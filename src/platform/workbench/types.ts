export interface PatchResult {
  workbenchHtml: string;
  injectionFile: string;
}

export type WorkbenchPatchStatus = 'missing' | 'current' | 'stale';
