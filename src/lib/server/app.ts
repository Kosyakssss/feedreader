import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Storage } from './storage';
import { Diagnostics } from './diagnostics';
import { Events } from './events';
import { Refresh } from './refresh';
export function createApp(directory = process.env.FEEDREADER_DATA_DIR || 'data') {
  const store = new Storage(resolve(directory));
  const log = new Diagnostics(
    process.env.FEEDREADER_LOG_DIR ||
      (process.platform === 'darwin'
        ? join(homedir(), 'Library/Logs/feedreader')
        : join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'feedreader')),
  );
  const events = new Events();
  const refresh = new Refresh(store, events, log);
  const startedAt = new Date().toISOString();
  return { store, log, events, refresh, startedAt };
}
export type App = ReturnType<typeof createApp>;
let instance: App | undefined;
export function app(): App {
  return (instance ??= createApp());
}
