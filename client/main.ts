import { FeedreaderApp } from './app.ts';
import { bindInteractions } from './interactions.ts';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Application root is missing');

const app = new FeedreaderApp(root);
bindInteractions(app);
void app.start();
