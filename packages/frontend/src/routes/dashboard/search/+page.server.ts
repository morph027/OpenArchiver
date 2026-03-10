import type { PageServerLoad, RequestEvent } from './$types';
import { api } from '$lib/server/api';
import type { SearchResult } from '@open-archiver/types';

import type { MatchingStrategy } from '@open-archiver/types';

async function performSearch(
	keywords: string,
	page: number,
	matchingStrategy: MatchingStrategy,
	event: RequestEvent,
	filter?: string
) {
	if (!keywords) {
		return { searchResult: null, keywords: '', page: 1, matchingStrategy: 'last', filter: '' };
	}

	try {
		const params = new URLSearchParams({
			keywords,
			page: String(page),
			limit: '10',
			matchingStrategy,
		});
		if (filter) {
			params.set('filter', filter);
		}
		const response = await api(`/search?${params.toString()}`, event, {
			method: 'GET',
		});

		if (!response.ok) {
			const error = await response.json();
			return {
				searchResult: null,
				keywords,
				page,
				matchingStrategy,
				filter: filter ?? '',
				error: error.message,
			};
		}

		const searchResult = (await response.json()) as SearchResult;
		return { searchResult, keywords, page, matchingStrategy, filter: filter ?? '' };
	} catch (error) {
		return {
			searchResult: null,
			keywords,
			page,
			matchingStrategy,
			filter: filter ?? '',
			error: error instanceof Error ? error.message : 'Unknown error',
		};
	}
}

export const load: PageServerLoad = async (event) => {
	const keywords = event.url.searchParams.get('keywords') || '';
	const page = parseInt(event.url.searchParams.get('page') || '1');
	const matchingStrategy = (event.url.searchParams.get('matchingStrategy') ||
		'last') as MatchingStrategy;
	const filter = event.url.searchParams.get('filter') || '';
	return performSearch(keywords, page, matchingStrategy, event, filter);
};
