import './styles.css';
import { SiteMeasureApp } from './app';
import { DebugLog } from './debug-log';

const debugLog = new DebugLog(localStorage, window);
const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('SiteMeasure could not find its application root.');

new SiteMeasureApp(root, undefined, debugLog);
