import './styles.css';
import { SiteMeasureApp } from './app';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('SiteMeasure could not find its application root.');

new SiteMeasureApp(root);
