import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
export const fallback: RequestHandler = () => json({ error: 'Not found' }, { status: 404 });
