import type { WorkbenchPatchStatus } from './types';

export type WorkbenchPatchEnabledState = boolean | undefined;

export type WorkbenchPatchRecoveryAction =
  | 'none'
  | 'remember-enabled'
  | 'refresh-stale'
  | 'restore-missing'
  | 'confirm-legacy-restore';

/**
 * Reconciles the persisted user intent with the patch found in the current VS Code install.
 * An undefined intent belongs to an older extension version and must never silently turn a
 * deliberately restored Workbench back on.
 */
export function decideWorkbenchPatchRecovery(
  enabled: WorkbenchPatchEnabledState,
  status: WorkbenchPatchStatus
): WorkbenchPatchRecoveryAction {
  if (enabled === false) {
    return 'none';
  }

  if (status === 'current') {
    return enabled === undefined ? 'remember-enabled' : 'none';
  }

  if (status === 'stale') {
    return 'refresh-stale';
  }

  return enabled === true ? 'restore-missing' : 'confirm-legacy-restore';
}
