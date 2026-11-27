import './styles.css';
import { SiteMeasureApp } from './app';
import { DebugLog } from './debug-log';
import { LocalStorageProjectRepository } from './data/local-storage-repository';
import { IndexedDbPhotoStore } from './data/photo-store';

const debugLog = new DebugLog(localStorage, window);
const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('SiteMeasure could not find its application root.');

async function start(): Promise<void> {
	if (!root) return;
	root.textContent = 'Opening local projects...';
	let migrationWarning = '';
	try {
		await new LocalStorageProjectRepository(localStorage).migratePhotos(new IndexedDbPhotoStore());
	} catch (error) {
		debugLog.log('photo-migration.error', error);
		migrationWarning = 'Some photos could not be moved to device storage. Existing projects were kept; export a backup and reload to retry.';
	}
	new SiteMeasureApp(root, undefined, debugLog, migrationWarning);
}
void start();
