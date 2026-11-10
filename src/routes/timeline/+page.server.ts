import { timelinePage } from '#lib/server/timeline.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => timelinePage(locals.store);
