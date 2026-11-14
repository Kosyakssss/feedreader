// An address in the app, under whatever path the app is served at: /lagan
// behind `tailscale serve`, or nothing on its own port. Only for addresses
// that come as data, as the breadcrumbs' do, which SvelteKit's resolve()
// can't check against its routes; a known route goes through resolve().
import { resolve } from '$app/paths';

const resolveAny = resolve as (path: string) => string;

export const at = (path: string): string => resolveAny(path);
