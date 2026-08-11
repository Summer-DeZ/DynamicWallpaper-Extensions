import {
  cleanupWorkbenchDirectory,
  discoverWorkbenchDirectories
} from './platform/workbench/uninstallCleanup';
import {
  cleanupGlobalStorageDirectory,
  discoverGlobalStorageDirectories
} from './platform/storage/uninstallDataCleanup';

async function main(): Promise<void> {
  const directories = await discoverWorkbenchDirectories();
  let failed = false;
  for (const directory of directories) {
    const result = await cleanupWorkbenchDirectory(directory);
    console.log(JSON.stringify(result));
    if (result.errors.length > 0) failed = true;
  }
  const storageDirectories = await discoverGlobalStorageDirectories();
  for (const directory of storageDirectories) {
    const result = await cleanupGlobalStorageDirectory(directory);
    console.log(JSON.stringify(result));
    if (result.errors.length > 0) failed = true;
  }
  if (failed) process.exitCode = 1;
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
