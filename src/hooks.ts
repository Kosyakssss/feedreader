import type { Reroute } from '@sveltejs/kit';
import { internalPath } from '$lib/paths';
export const reroute: Reroute = ({ url }) => internalPath(url.pathname);
