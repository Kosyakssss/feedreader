// Where a page sits: the breadcrumbs, and the list of pages under each one.
import { feedPath } from './format';

export type Link = { href: string; label: string };
export type Crumb = Link & { under?: Link[] };

export const APP_NAME = 'Lagan';
export const FEEDS: Link = { href: '/feeds', label: 'Feeds' };
export const PAGES: Link[] = [{ href: '/all', label: 'All' }, { href: '/archive', label: 'Archive' }, { href: '/bookmarks', label: 'Bookmarks' }, FEEDS];

export function trailFor(path: string, feeds: { id: number; label: string }[]): Crumb[] {
  const home: Crumb = { href: '/', label: APP_NAME, under: PAGES };
  const feedsPage: Crumb = { ...FEEDS, under: feeds.map((feed) => ({ href: feedPath(feed.id), label: feed.label })) };
  if (path === '/') return [home];
  if (path === FEEDS.href) return [home, feedsPage];
  const page = PAGES.find((link) => link.href === path);
  if (page) return [home, page];
  const feed = feeds.find((candidate) => feedPath(candidate.id) === path);
  return feed ? [home, feedsPage, { href: path, label: feed.label }] : [home];
}
