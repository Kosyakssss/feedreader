import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Storage } from './storage';
import { Configuration } from './config';
import { Themes } from './themes';
import { Diagnostics } from './diagnostics';
import { Events } from './events';
import { Refresh } from './refresh';

export function createApp(directory = process.env.FEEDREADER_DATA_DIR || 'data') {
  directory = resolve(directory);
  const config = new Configuration(directory);
  const themes = new Themes(directory);
  themes.validate(config.read());
  const store = new Storage(directory);
  const log = new Diagnostics(
    process.env.FEEDREADER_LOG_DIR ||
      (process.platform === 'darwin'
        ? join(homedir(), 'Library/Logs/feedreader')
        : join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'feedreader')),
  );
  const events = new Events();
  const refresh = new Refresh(store, config, events, log);
  const startedAt = new Date().toISOString();
  return {
    store,
    config,
    themes,
    log,
    events,
    refresh,
    startedAt,
    async close() {
      events.close();
      await refresh.completion?.catch(() => undefined);
      await log.flush();
      store.close();
    },
  };
}
export type App = ReturnType<typeof createApp>;
let instance: App | undefined;
export function app(): App {
  return (instance ??= createApp());
}
