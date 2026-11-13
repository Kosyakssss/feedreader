// An address in the app, under whatever path the app is served at: /lagan
// behind `tailscale serve`, or nothing on its own port. For addresses built
// as the app runs, which SvelteKit's resolve() can't check against its routes.
import { resolve } from '$app/paths';

const resolveAny = resolve as (path: string) => string;

export const at = (path: string): string => resolveAny(path);
