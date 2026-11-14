import { error, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { scopes } from '#lib/server/store.ts';
import type { Actions, PageServerLoad } from './$types';

// Plain HTML: no script comes with this page.
export const csr = false;

export const load: PageServerLoad = ({ locals }) => {
  locals.wake(); // opening the app is the moment to check for news
  return { entries: locals.store.entries(scopes.latest) };
};

export const actions: Actions = {
  // Keeping, or no longer keeping, then back to the entry where it was.
  keep: async ({ request, locals }) => {
    const form = await request.formData();
    const id = Number(form.get('id'));
    if (!Number.isInteger(id) || !locals.store.entry(id)) error(404, 'Not found');
    locals.store.mark([id], { bookmarked: form.get('keep') === '1' });
    redirect(303, `${resolve('/')}#e${id}`);
  },
};
